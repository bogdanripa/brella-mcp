import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { EMAIL_RE, requestCode, signOut, validateSession, verifyCode } from "../brella/auth.js";
import { buildUrl, sessionHeaders, V4_HEADERS } from "../brella/http.js";
import { deserialize } from "../brella/jsonapi.js";
import { mapEvent } from "../brella/mappers.js";
import { routes } from "../brella/routes.js";
import { SetupError } from "../errors.js";
import type { AccountMeta, Store, StoredSession } from "../store/types.js";

export const ATTEMPT_TTL_MS = 15 * 60_000;
export const MAX_CODE_TRIES = 5;

interface Attempt {
  id: string;
  email: string;
  alias?: string;
  makeDefault: boolean;
  createdAt: number;
  tries: number;
}

export interface StartResult {
  attempt_id: string;
  email: string;
  code_sent: boolean;
  /** When Brella wants a captcha for the email request, the operator triggers it in the official app. */
  manual_request_needed: boolean;
  instructions: string;
  expires_at: string;
}

export interface ReadyAccount {
  email: string;
  alias?: string;
  is_default: boolean;
  display_name?: string;
  events: { slug: string; name: string | null; status: string }[];
}

export function manualInstructions(email: string): string {
  return (
    `Brella requires a captcha to send the code from here. Open https://next.brella.io/login in your browser, choose ` +
    `"Continue with email", enter ${email} and press continue — Brella emails you a 6-digit code. ` +
    `Do not type the code on the Brella page; enter it in this setup instead.`
  );
}

/**
 * Email-code setup state machine (spec §4). Attempts live only in this
 * process's memory; codes are never logged, stored or returned.
 */
export class SetupFlow {
  private readonly attempts = new Map<string, Attempt>();

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly now: () => number = Date.now,
    private readonly api = { requestCode, verifyCode, validateSession, signOut },
  ) {}

  async start(emailRaw: string, opts: { alias?: string; makeDefault?: boolean; skipRequest?: boolean } = {}): Promise<StartResult> {
    const email = emailRaw.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new SetupError("INVALID_EMAIL", "That does not look like an email address");
    // A new attempt for the same email invalidates the previous one.
    for (const [id, a] of this.attempts) if (a.email === email) this.attempts.delete(id);
    this.gc();

    let codeSent = false;
    let manual = false;
    if (opts.skipRequest) manual = true;
    else {
      const res = await this.api.requestCode(this.cfg, email);
      codeSent = res.sent;
      manual = !res.sent;
    }
    const attempt: Attempt = {
      id: randomUUID(),
      email,
      alias: opts.alias?.trim() || undefined,
      makeDefault: !!opts.makeDefault,
      createdAt: this.now(),
      tries: 0,
    };
    this.attempts.set(attempt.id, attempt);
    return {
      attempt_id: attempt.id,
      email,
      code_sent: codeSent,
      manual_request_needed: manual,
      instructions: codeSent ? `Brella emailed a sign-in code to ${email}. Enter it here.` : manualInstructions(email),
      expires_at: new Date(attempt.createdAt + ATTEMPT_TTL_MS).toISOString(),
    };
  }

  async verify(attemptId: string, code: string): Promise<ReadyAccount> {
    const a = this.attempts.get(attemptId);
    if (!a) throw new SetupError("SETUP_ATTEMPT_NOT_FOUND", "No such setup attempt; start again");
    if (this.now() - a.createdAt > ATTEMPT_TTL_MS) {
      this.attempts.delete(attemptId);
      throw new SetupError("SETUP_ATTEMPT_EXPIRED", "This setup attempt expired; request a new code");
    }
    if (a.tries >= MAX_CODE_TRIES) {
      this.attempts.delete(attemptId);
      throw new SetupError("TOO_MANY_ATTEMPTS", "Too many wrong codes; request a new code");
    }
    a.tries++;
    const verified = await this.api.verifyCode(this.cfg, a.email, code);
    this.attempts.delete(attemptId);
    return this.finish(a, verified.session, verified.user);
  }

  private async finish(a: Attempt, session: StoredSession, user?: { id?: string; email?: string; name?: string }): Promise<ReadyAccount> {
    await this.store.putSession(a.email, session);
    const checked = (await this.api.validateSession(this.cfg, session).catch(() => undefined)) ?? user;
    const existing = (await this.store.listAccounts()).find((x) => x.email.toLowerCase() === a.email);
    const meta: AccountMeta = {
      email: a.email,
      alias: a.alias ?? existing?.alias,
      is_default: a.makeDefault || existing?.is_default || false,
      user_id: checked?.id ?? existing?.user_id,
      display_name: checked?.name ?? existing?.display_name,
      created_at: existing?.created_at ?? new Date(this.now()).toISOString(),
      verified_at: new Date(this.now()).toISOString(),
    };
    await this.store.upsertAccount(meta);
    const events = await this.listEvents(a.email).catch(() => []);
    const saved = (await this.store.listAccounts()).find((x) => x.email.toLowerCase() === a.email)!;
    return { email: saved.email, alias: saved.alias, is_default: saved.is_default, display_name: saved.display_name, events };
  }

  /** Setup's own readiness check: list the account's events with the stored session. */
  async listEvents(email: string): Promise<ReadyAccount["events"]> {
    const session = await this.store.getSession(email);
    if (!session) return [];
    const res = await fetch(buildUrl(this.cfg.apiBase, routes.meEvents(), { "page[size]": 100 }), {
      headers: { ...V4_HEADERS, "User-Agent": this.cfg.userAgent, ...sessionHeaders(session) },
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) throw new SetupError("UPSTREAM_UNREACHABLE", `Event list check failed (${res.status})`);
    return deserialize(await res.json()).data.map((n) => {
      const e = mapEvent(n);
      return { slug: e.slug, name: e.name, status: e.status };
    });
  }

  async status(): Promise<(AccountMeta & { session_valid: boolean | null })[]> {
    const accounts = await this.store.listAccounts();
    return Promise.all(
      accounts.map(async (a) => {
        const s = await this.store.getSession(a.email).catch(() => null);
        let valid: boolean | null = null;
        if (!s) valid = false;
        else {
          try {
            valid = (await this.api.validateSession(this.cfg, s)) !== null;
          } catch {
            valid = null;
          }
        }
        return { ...a, session_valid: valid };
      }),
    );
  }

  /** Upstream sign-out, then local deletion regardless; both outcomes reported. */
  async remove(emailRaw: string): Promise<{ upstream_sign_out: string; local_removed: boolean }> {
    const email = emailRaw.trim().toLowerCase();
    const s = await this.store.getSession(email).catch(() => null);
    let upstream = "no_session";
    if (s) {
      const r = await this.api.signOut(this.cfg, s);
      upstream = r.ok ? "ok" : `failed (${r.status || "unreachable"})`;
    }
    await this.store.removeAccount(email);
    return { upstream_sign_out: upstream, local_removed: true };
  }

  private gc(): void {
    for (const [id, a] of this.attempts) if (this.now() - a.createdAt > ATTEMPT_TTL_MS) this.attempts.delete(id);
  }
}

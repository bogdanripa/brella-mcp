import type { Config } from "../config.js";
import { BrellaError, redact } from "../errors.js";
import type { Store, StoredSession } from "../store/types.js";
import { deserialize, type Document } from "./jsonapi.js";

export const V4_HEADERS: Record<string, string> = {
  Accept: "application/vnd.brella.v4+json",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  // Matches the web app; makes schedule payloads carry speakers/stages.
  "include-extra-schedule-data": "true",
};

const AUTH_HEADER_NAMES = ["access-token", "client", "uid", "expiry", "token-type"] as const;

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Map 404 to this code instead of the generic UPSTREAM_CHANGED. */
  notFound?: BrellaError["code"];
  cacheTtlMs?: number;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  json: unknown;
}

export function buildUrl(base: string, path: string, query?: RequestOptions["query"]): string {
  const url = new URL(base + (path.startsWith("/") ? path : `/${path}`));
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export function sessionHeaders(s: StoredSession): Record<string, string> {
  const h: Record<string, string> = {};
  for (const name of AUTH_HEADER_NAMES) {
    const v = s[name];
    if (v) h[name] = v;
  }
  if (s.cookies?.length) h.cookie = s.cookies.map((c) => c.split(";")[0]).join("; ");
  return h;
}

/** Extract a session from a response (verify step, and token rotation). */
export function sessionFromHeaders(headers: Headers, previous?: StoredSession): StoredSession | null {
  const token = headers.get("access-token");
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (!token && cookies.length === 0) return null;
  const next: StoredSession = { ...(previous ?? {}), updated_at: new Date().toISOString() };
  if (token) {
    next["access-token"] = token;
    for (const name of ["client", "uid", "expiry", "token-type"] as const) {
      const v = headers.get(name);
      if (v) next[name] = v;
    }
  }
  if (cookies.length) {
    const jar = new Map<string, string>();
    for (const c of [...(previous?.cookies ?? []), ...cookies]) jar.set(c.split("=")[0], c);
    next.cookies = [...jar.values()];
  }
  return next;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Authenticated client for one account (spec §5).
 * - Every request for an account runs through one queue: this is both the
 *   single-flight token lock (§5.3) and the 2 req/s throttle (§5.4).
 * - A rotated access-token is persisted before the call returns.
 * - 401 → SETUP_REQUIRED, nothing is cleared.
 */
export class AccountClient {
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly cache = new Map<string, { at: number; doc: Document }>();

  constructor(
    readonly email: string,
    private readonly store: Store,
    private readonly cfg: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async get(path: string, opts: RequestOptions = {}): Promise<Document> {
    const key = buildUrl(this.cfg.apiBase, path, opts.query);
    if (opts.cacheTtlMs) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < opts.cacheTtlMs) return hit.doc;
    }
    const doc = await this.request("GET", path, opts);
    if (opts.cacheTtlMs) this.cache.set(key, { at: Date.now(), doc });
    return doc;
  }

  async request(method: Method, path: string, opts: RequestOptions = {}): Promise<Document> {
    const res = await this.raw(method, path, opts);
    try {
      return deserialize(res.json);
    } catch {
      throw new BrellaError("UPSTREAM_CHANGED", `Unexpected response shape from ${method} ${path}`);
    }
  }

  /** Drop cached reads (after a write). */
  invalidate(prefix?: string): void {
    if (!prefix) return this.cache.clear();
    for (const k of this.cache.keys()) if (k.includes(prefix)) this.cache.delete(k);
  }

  async raw(method: Method, path: string, opts: RequestOptions = {}): Promise<RawResponse> {
    const idempotent = method === "GET";
    const maxAttempts = idempotent ? 3 : 1;
    let attempt = 0;
    for (;;) {
      attempt++;
      const res = await this.enqueue(() => this.once(method, path, opts));
      const retriable = res.status === 429 || res.status >= 500;
      if (retriable && attempt < maxAttempts) {
        const ra = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** (attempt - 1) + Math.random() * 250;
        await sleep(Math.min(backoff, 10_000));
        continue;
      }
      return this.check(method, path, res, opts);
    }
  }

  private async once(method: Method, path: string, opts: RequestOptions): Promise<RawResponse> {
    const session = await this.store.getSession(this.email);
    if (!session) {
      throw new BrellaError("SETUP_REQUIRED", `No stored Brella session for ${this.email}. Run setup for this account.`, {
        account: this.email,
      });
    }
    const minGap = 1000 / Math.max(this.cfg.requestsPerSecond, 0.1);
    const wait = this.lastRequestAt + minGap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const url = buildUrl(this.cfg.apiBase, path, opts.query);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { ...V4_HEADERS, "User-Agent": this.cfg.userAgent, ...sessionHeaders(session) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const timedOut = (e as Error).name === "AbortError";
      throw new BrellaError(
        "UPSTREAM_UNREACHABLE",
        timedOut ? `Brella did not answer within ${this.cfg.timeoutMs / 1000}s` : `Could not reach Brella: ${redact(String((e as Error).message))}`,
        { timed_out: timedOut, method },
      );
    } finally {
      clearTimeout(timer);
    }

    // Token rotation (§5.3): persist before anything else sees the response.
    const rotated = sessionFromHeaders(res.headers, session);
    if (rotated && rotated["access-token"] && rotated["access-token"] !== session["access-token"]) {
      await this.store.putSession(this.email, rotated);
    } else if (rotated && rotated.cookies && JSON.stringify(rotated.cookies) !== JSON.stringify(session.cookies)) {
      await this.store.putSession(this.email, rotated);
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { _nonJson: true };
      }
    }
    if (this.cfg.debug) console.error(`[brella] ${method} ${new URL(url).pathname} → ${res.status}`);
    return { status: res.status, headers: res.headers, json };
  }

  private check(method: Method, path: string, res: RawResponse, opts: RequestOptions): RawResponse {
    const s = res.status;
    if (s >= 200 && s < 300) return res;
    const upstreamMsg = errorTitle(res.json);
    if (s === 401) {
      throw new BrellaError("SETUP_REQUIRED", `Brella rejected the stored session for ${this.email}. Rerun setup for this account.`, {
        account: this.email,
      }, s);
    }
    if (s === 404) {
      throw new BrellaError(opts.notFound ?? "UPSTREAM_CHANGED", upstreamMsg ?? `Not found: ${method} ${path}`, {}, s);
    }
    if (s === 429) {
      const ra = Number(res.headers.get("retry-after"));
      throw new BrellaError("RATE_LIMITED", "Brella is rate limiting this account", Number.isFinite(ra) ? { retry_after_seconds: ra } : {}, s);
    }
    if (s === 409 || s === 412) {
      throw new BrellaError("MEETING_STATE_CHANGED", upstreamMsg ?? "The resource changed upstream", {}, s);
    }
    if (s === 422 || s === 400 || s === 403) {
      // Validation failures: caller decides (slot taken, state changed…).
      throw new BrellaError("INVALID_ARGUMENT", upstreamMsg ?? `Brella refused ${method} ${path} (${s})`, { upstream_status: s, upstream_errors: errorList(res.json) }, s);
    }
    if (s >= 500) throw new BrellaError("UPSTREAM_UNREACHABLE", `Brella returned ${s}`, {}, s);
    throw new BrellaError("UPSTREAM_CHANGED", upstreamMsg ?? `Unexpected status ${s} from ${method} ${path}`, {}, s);
  }
}

function errorList(json: any): string[] {
  const errs = json?.errors;
  if (Array.isArray(errs)) return errs.map((e: any) => redact(String(e?.title ?? e?.detail ?? e))).slice(0, 5);
  if (errs && typeof errs === "object") return Object.entries(errs).map(([k, v]) => redact(`${k}: ${v}`)).slice(0, 5);
  if (typeof json?.error === "string") return [redact(json.error)];
  return [];
}

function errorTitle(json: any): string | undefined {
  return errorList(json)[0];
}

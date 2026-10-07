import type { Config } from "../config.js";
import { SetupError } from "../errors.js";
import type { StoredSession } from "../store/types.js";
import { buildUrl, sessionFromHeaders, sessionHeaders, V4_HEADERS } from "./http.js";
import { deserialize } from "./jsonapi.js";
import { routes } from "./routes.js";

/**
 * Setup-only calls for the email-code ("one click link") flow. Nothing in this
 * file is reachable from an MCP tool.
 */

async function call(
  cfg: Config,
  method: string,
  path: string,
  body?: unknown,
  session?: StoredSession,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    return await fetch(buildUrl(cfg.authBase, path), {
      method,
      headers: { ...V4_HEADERS, "User-Agent": cfg.userAgent, ...(session ? sessionHeaders(session) : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw new SetupError("UPSTREAM_UNREACHABLE", "Could not reach Brella");
  } finally {
    clearTimeout(timer);
  }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CodeRequestResult =
  | { sent: true }
  | { sent: false; reason: "captcha_required" | "rejected"; status: number };

/**
 * Ask Brella to email a sign-in code. The web app attaches an invisible
 * hCaptcha token to this call; we never solve captchas, so if Brella insists
 * on one the operator triggers the email themselves (see setup instructions)
 * and only the verify step runs here.
 */
export async function requestCode(cfg: Config, email: string): Promise<CodeRequestResult> {
  if (!EMAIL_RE.test(email)) throw new SetupError("INVALID_EMAIL", "That does not look like an email address");
  const res = await call(cfg, "POST", routes.requestCode(), { one_click_link: { email } });
  if (res.ok) return { sent: true };
  if (res.status === 429) throw new SetupError("RATE_LIMITED", "Brella says too many attempts; wait an hour and retry");
  const text = (await res.text()).toLowerCase();
  const captcha = text.includes("captcha");
  return { sent: false, reason: captcha || res.status === 422 || res.status === 403 ? "captcha_required" : "rejected", status: res.status };
}

export interface VerifiedSession {
  session: StoredSession;
  user?: { id?: string; email?: string; name?: string };
}

export async function verifyCode(cfg: Config, email: string, code: string): Promise<VerifiedSession> {
  const token = code.trim();
  if (!/^[A-Za-z0-9]{4,12}$/.test(token)) throw new SetupError("INVALID_CODE", "The code should be the 6-character code from the email");
  const res = await call(cfg, "POST", routes.verifyCode(), { token, email });
  if (res.status === 429) throw new SetupError("RATE_LIMITED", "Too many attempts. Brella asks to wait an hour before trying again.");
  if (!res.ok) throw new SetupError("INVALID_CODE", "The code is invalid or expired");
  const session = sessionFromHeaders(res.headers);
  if (!session) throw new SetupError("INVALID_CODE", "Brella accepted the code but returned no session (unexpected upstream change)");
  let user: VerifiedSession["user"];
  try {
    const doc = deserialize(await res.json());
    const u = doc.data[0];
    if (u) user = { id: u.id, email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || undefined };
  } catch {
    /* body is optional */
  }
  return { session, user };
}

/** Validate a stored session; returns the user summary or null on 401. */
export async function validateSession(cfg: Config, session: StoredSession): Promise<VerifiedSession["user"] | null> {
  const res = await call(cfg, "GET", routes.meUser(), undefined, session);
  if (res.status === 401) return null;
  if (!res.ok) throw new SetupError("UPSTREAM_UNREACHABLE", `Session check failed with ${res.status}`);
  const doc = deserialize(await res.json());
  const u = doc.data[0];
  return { id: u?.id, email: u?.email, name: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || undefined };
}

export async function signOut(cfg: Config, session: StoredSession): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await call(cfg, "DELETE", routes.signOut(), {}, session);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Stable error codes (spec §9). Runtime tools only ever surface these. */
export type ErrorCode =
  | "SETUP_REQUIRED"
  | "ACCOUNT_NOT_FOUND"
  | "EVENT_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "ATTENDEE_NOT_FOUND"
  | "MEETING_NOT_FOUND"
  | "CONVERSATION_NOT_FOUND"
  | "MEETING_STATE_CHANGED"
  | "SLOT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "UPSTREAM_CHANGED"
  | "UPSTREAM_UNREACHABLE"
  | "NOTE_DELIVERY_FAILED"
  | "INVALID_ARGUMENT";

/** Setup-only codes (never returned by MCP tools). */
export type SetupErrorCode =
  | "INVALID_EMAIL"
  | "INVALID_CODE"
  | "SETUP_ATTEMPT_NOT_FOUND"
  | "SETUP_ATTEMPT_EXPIRED"
  | "TOO_MANY_ATTEMPTS"
  | "CODE_REQUEST_BLOCKED"
  | "UPSTREAM_UNREACHABLE"
  | "RATE_LIMITED";

export class BrellaError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly status?: number,
  ) {
    super(message);
    this.name = "BrellaError";
  }
}

export class SetupError extends Error {
  constructor(
    public readonly code: SetupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SetupError";
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /(access-token|client|uid|authorization|cookie|set-cookie|token|code|ott)(["'\s:=]+)([^"',\s&]+)/gi,
];

/** Strip anything that looks like a credential from free text before it leaves the process. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, k, sep) => `${k}${sep}[redacted]`);
  return out;
}

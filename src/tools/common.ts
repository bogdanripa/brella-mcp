import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AccountRegistry, BrellaAccount } from "../brella/service.js";
import { BrellaError, redact } from "../errors.js";

export const accountArg = z
  .string()
  .optional()
  .describe("Email or alias of an account created during setup. Omit to use the default account.");
export const eventArg = z.string().min(1).describe("Brella event slug (e.g. HTW2026) or a next.brella.io event URL");
export const includeRawArg = z.boolean().optional().describe("Include the raw upstream object under `raw` (default false)");
export const pagingArgs = {
  page_number: z.number().int().min(1).optional().describe("Page number, default 1"),
  page_size: z.number().int().min(1).max(120).optional().describe("Page size, default 50, max 120"),
  fetch_all: z.boolean().optional().describe("Fetch every page (capped at 20 pages; reported when hit)"),
};

export interface ToolContext {
  registry: AccountRegistry;
  /** Set for OAuth callers: the only Brella account this connection may use. */
  boundEmail?: string;
}

export const READ = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

export function meta(acct: BrellaAccount | null, eventSlug?: string | null) {
  return {
    account: acct?.email ?? null,
    ...(eventSlug ? { event_slug: eventSlug } : {}),
    fetched_at: new Date().toISOString(),
  };
}

export function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function fail(err: unknown, account?: string | null): CallToolResult {
  const e =
    err instanceof BrellaError
      ? err
      : new BrellaError("UPSTREAM_CHANGED", `Unexpected failure: ${redact(String((err as Error)?.message ?? err))}`);
  const payload = {
    error: { code: e.code, message: redact(e.message), ...e.details },
    meta: { account: account ?? (e.details.account as string | undefined) ?? null, fetched_at: new Date().toISOString() },
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** Register a tool whose handler gets a resolved account and never throws raw errors. */
export function tool<S extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  def: { title: string; description: string; input: S; annotations: Record<string, boolean> },
  handler: (args: z.infer<z.ZodObject<S>>, acct: BrellaAccount) => Promise<Record<string, unknown>>,
): void {
  server.registerTool(
    name,
    { title: def.title, description: def.description, inputSchema: def.input, annotations: { title: def.title, ...def.annotations } },
    (async (args: any) => {
      let acct: BrellaAccount | null = null;
      try {
        acct = await ctx.registry.resolve(args?.account, ctx.boundEmail);
        return ok(await handler(args, acct));
      } catch (e) {
        return fail(e, acct?.email);
      }
    }) as any,
  );
}

export function withRaw<T extends object>(model: T, raw: unknown, include?: boolean): T & { raw?: unknown } {
  return include ? { ...model, raw } : model;
}

/** Same calendar day in the event's timezone (falls back to the ISO date prefix). */
export function sameDay(iso: string | null, day: string, tz: string | null): boolean {
  if (!iso) return false;
  try {
    if (tz) {
      const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
      return d === day;
    }
  } catch {
    /* invalid tz */
  }
  return iso.slice(0, 10) === day;
}

export function overlaps(aStart: string | null, aEnd: string | null, bStart: string | null, bEnd: string | null): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

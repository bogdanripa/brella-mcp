import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collect, pick } from "../brella/jsonapi.js";
import { mapAttendee, mapEvent, mapSession } from "../brella/mappers.js";
import { routes } from "../brella/routes.js";
import { CATALOG_TTL, pageQuery, paged } from "../brella/service.js";
import { accountArg, eventArg, includeRawArg, meta, pagingArgs, READ, tool, type ToolContext, withRaw } from "./common.js";

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "brella_list_accounts",
    {
      title: "List Brella accounts",
      description:
        "List the Brella accounts configured during setup, so you can pick an `account` value for other tools. " +
        "Read-only: it never signs in or repairs sessions. `setup_required: true` means the operator must rerun setup for that account.",
      inputSchema: {},
      annotations: { title: "List Brella accounts", ...READ, openWorldHint: false },
    },
    async () => {
      const accounts = await ctx.registry.store.listAccounts();
      const rows = await Promise.all(
        accounts.map(async (a) => {
          const session = await ctx.registry.store.getSession(a.email).catch(() => null);
          return {
            email: a.email,
            ...(a.alias ? { alias: a.alias } : {}),
            is_default: a.is_default,
            setup_present: !!session,
            setup_required: !session,
          };
        }),
      );
      const payload = { accounts: rows, meta: { account: null, fetched_at: new Date().toISOString() } };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    },
  );
}

export function registerEventTools(server: McpServer, ctx: ToolContext): void {
  tool(
    server,
    ctx,
    "brella_list_my_events",
    {
      title: "List my Brella events",
      description: "List events the account has joined, with status computed from the event dates.",
      input: {
        account: accountArg,
        status: z.enum(["upcoming", "ongoing", "past", "all"]).optional().describe("Filter by status (default all)"),
        include_raw: includeRawArg,
      },
      annotations: READ,
    },
    async (args, acct) => {
      const nodes = await acct.myEvents();
      const seen = new Set<string>();
      const events = nodes
        .map((n) => ({ model: mapEvent(n), n }))
        .filter(({ model }) => model.slug && !seen.has(model.slug) && seen.add(model.slug))
        .filter(({ model }) => !args.status || args.status === "all" || model.status === args.status)
        .sort((a, b) => String(b.model.starts_at ?? "").localeCompare(String(a.model.starts_at ?? "")))
        .map(({ model, n }) => withRaw(model, n, args.include_raw));
      return { events, meta: meta(acct) };
    },
  );

  tool(
    server,
    ctx,
    "brella_get_event",
    {
      title: "Get Brella event",
      description: "Event details (name, dates, timezone, venue) by slug or Brella URL.",
      input: { event: eventArg, account: accountArg, include_raw: includeRawArg },
      annotations: READ,
    },
    async (args, acct) => {
      const { raw, ...event } = await acct.event(args.event);
      return { event: withRaw(event, raw, args.include_raw), meta: meta(acct, event.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_get_my_profile",
    {
      title: "Get my event profile",
      description: "The account's own attendee profile in an event, including selected interests.",
      input: { event: eventArg, account: accountArg, include_raw: includeRawArg },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const n = await acct.meAttendee(ev.slug);
      if (!n) return { profile: null, meta: meta(acct, ev.slug) };
      const profile = { ...mapAttendee(n, ev.slug, String(n.id)), is_me: true };
      // me_attendee does not always inline the interest names; fill from the selections endpoint.
      if (profile.interests.length === 0) {
        try {
          const sel = await acct.http.get(routes.attendeeInterests(ev.slug), { cacheTtlMs: CATALOG_TTL });
          const names = sel.data.map((s) => pick<string>(s, "interest.name", "name")).filter(Boolean) as string[];
          profile.interests = [...new Set(names)];
        } catch {
          /* optional */
        }
      }
      return { profile: withRaw(profile, n, args.include_raw), interests_catalog_ref: "brella_get_interest_catalog", meta: meta(acct, ev.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_get_interest_catalog",
    {
      title: "Get interest catalog",
      description: "The event's interest taxonomy (categories → interests), for matching sessions and people against the user's interests.",
      input: { event: eventArg, account: accountArg },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const doc = await acct.http.get(routes.interests(ev.slug), { cacheTtlMs: CATALOG_TTL, notFound: "EVENT_NOT_FOUND" });
      const categories = doc.data.map((c) => ({
        id: c.id ?? null,
        name: pick<string>(c, "name", "title") ?? null,
        interests: ((c.children ?? c.interests ?? []) as any[])
          .map((i) => ({ id: i.id ?? null, name: pick<string>(i, "name", "title") ?? null }))
          .filter((i) => i.name),
      }));
      return { categories, meta: meta(acct, ev.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_search_event",
    {
      title: "Search an event",
      description: "Search attendees, sessions and sponsors in an event (same search box as the Brella app).",
      input: { event: eventArg, query: z.string().min(1), account: accountArg, ...pagingArgs },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const me = await acct.meWithAttendee(ev.slug);
      const { nodes, page } = await paged(
        (number, size) =>
          acct.http.get(routes.search(ev.slug), { query: { search: args.query, ...pageQuery(number, size) }, cacheTtlMs: CATALOG_TTL, notFound: "EVENT_NOT_FOUND" }),
        args,
        acct.cfg.pageSizeDefault,
      );
      // Results may be typed resources or wrappers ({ searchable: {...} }).
      const items = nodes.flatMap((n) => (n.searchable && typeof n.searchable === "object" ? [n.searchable] : [n]));
      const attendees = [...items.filter((n) => n.type === "attendee"), ...collect(items.filter((n) => n.type !== "attendee"), "attendee")];
      const sessions = items.filter((n) => n.type === "timeslot");
      const sponsors = items.filter((n) => n.type === "sponsor").map((s) => ({ sponsor_id: s.id, name: pick(s, "name", "title") ?? null }));
      const uniq = <T extends { id?: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()];
      return {
        attendees: uniq(attendees).map((a) => mapAttendee(a, ev.slug, me.attendeeId)),
        sessions: uniq(sessions).map((s) => mapSession(s, ev.slug, new Set(), ev.timezone)),
        sponsors,
        page,
        meta: meta(acct, ev.slug),
      };
    },
  );
}

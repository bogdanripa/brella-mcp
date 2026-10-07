import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Node } from "../brella/jsonapi.js";
import { pick } from "../brella/jsonapi.js";
import { type AttendeeModel, mapAttendee } from "../brella/mappers.js";
import { routes } from "../brella/routes.js";
import { type BrellaAccount, CATALOG_TTL, pageQuery, paged } from "../brella/service.js";
import { BrellaError } from "../errors.js";
import { accountArg, eventArg, includeRawArg, meta, pagingArgs, READ, tool, type ToolContext, withRaw } from "./common.js";

/** interest id → name, from the event catalog (children of each category). */
async function interestIndex(acct: BrellaAccount, slug: string): Promise<Map<string, string>> {
  const doc = await acct.http.get(routes.interests(slug), { cacheTtlMs: CATALOG_TTL, notFound: "EVENT_NOT_FOUND" });
  const idx = new Map<string, string>();
  const add = (n: any) => {
    const name = pick<string>(n, "name", "title");
    if (n?.id != null && name) idx.set(String(n.id), name);
  };
  for (const c of doc.data) {
    add(c);
    for (const ch of (c.children ?? c.interests ?? []) as any[]) add(ch);
  }
  for (const n of doc.index.values()) if (n.type === "interest") add(n);
  return idx;
}

/** Fill interest names the attendee payload only referenced by id. */
function hydrate(n: Node, a: AttendeeModel, idx: Map<string, string>): AttendeeModel {
  if (a.interests.length) return a;
  const names = new Set<string>();
  for (const si of (n.selectedInterests ?? n.attendeeInterests ?? []) as any[]) {
    const id = pick(si, "interest.id", "interestId");
    const name = id != null ? idx.get(String(id)) : undefined;
    if (name) names.add(name);
  }
  return { ...a, interests: [...names] };
}

function matchInterestIds(idx: Map<string, string>, wanted: string[]): { ids: number[]; unknown: string[] } {
  const ids: number[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    const wl = w.trim().toLowerCase();
    const exact = [...idx].filter(([, n]) => n.toLowerCase() === wl);
    const hits = exact.length ? exact : [...idx].filter(([, n]) => n.toLowerCase().includes(wl));
    if (!hits.length) unknown.push(w);
    for (const [id] of hits) ids.push(Number(id));
  }
  return { ids: [...new Set(ids)], unknown };
}

export function registerAttendeeTools(server: McpServer, ctx: ToolContext): void {
  tool(
    server,
    ctx,
    "brella_list_attendees",
    {
      title: "List attendees",
      description: "Networking attendees of an event, optionally filtered by free-text query and/or one interest name. Defaults to one page.",
      input: { event: eventArg, query: z.string().optional(), interest: z.string().optional(), include_raw: includeRawArg, account: accountArg, ...pagingArgs },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const [idx, me] = await Promise.all([interestIndex(acct, ev.slug).catch(() => new Map<string, string>()), acct.meWithAttendee(ev.slug)]);
      let interestIds: number[] | undefined;
      if (args.interest) {
        const m = matchInterestIds(idx, [args.interest]);
        if (!m.ids.length) throw new BrellaError("INVALID_ARGUMENT", `Unknown interest "${args.interest}"; see brella_get_interest_catalog`);
        interestIds = m.ids;
      }
      const { nodes, page } = await paged(
        (number, size) =>
          interestIds
            ? acct.http.request("POST", routes.attendees(ev.slug), {
                body: { interest_ids: interestIds, page: { number, size }, ...(args.query ? { search: args.query } : {}) },
                notFound: "EVENT_NOT_FOUND",
              })
            : acct.http.get(routes.attendees(ev.slug), {
                query: { search: args.query, ...pageQuery(number, size) },
                cacheTtlMs: CATALOG_TTL,
                notFound: "EVENT_NOT_FOUND",
              }),
        args,
        acct.cfg.pageSizeDefault,
      );
      const attendees = nodes.map((n) => withRaw(hydrate(n, mapAttendee(n, ev.slug, me.attendeeId), idx), n, args.include_raw));
      return { attendees, page, meta: meta(acct, ev.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_get_attendee",
    {
      title: "Get attendee",
      description: "One attendee's event profile (only fields Brella exposes; nothing is enriched from elsewhere).",
      input: { event: eventArg, attendee_id: z.string().min(1), include_raw: includeRawArg, account: accountArg },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const [n, idx, me] = await Promise.all([
        acct.attendeeNode(ev.slug, args.attendee_id),
        interestIndex(acct, ev.slug).catch(() => new Map<string, string>()),
        acct.meWithAttendee(ev.slug),
      ]);
      return { attendee: withRaw(hydrate(n, mapAttendee(n, ev.slug, me.attendeeId), idx), n, args.include_raw), meta: meta(acct, ev.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_find_attendees_by_interest",
    {
      title: "Find attendees by interest",
      description:
        "Attendees who selected any of the given interests (names matched against the event's interest catalog, case-insensitive). " +
        "Reports which interests matched per attendee, unknown interest names, and whether paging was capped.",
      input: { event: eventArg, interests: z.array(z.string().min(1)).min(1).max(20), account: accountArg, ...pagingArgs },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const [idx, me] = await Promise.all([interestIndex(acct, ev.slug), acct.meWithAttendee(ev.slug)]);
      const { ids, unknown } = matchInterestIds(idx, args.interests);
      if (!ids.length) return { attendees: [], matched_interests: {}, unknown_interests: unknown, meta: meta(acct, ev.slug) };
      const { nodes, page } = await paged(
        (number, size) =>
          acct.http.request("POST", routes.attendees(ev.slug), { body: { interest_ids: ids, page: { number, size } }, notFound: "EVENT_NOT_FOUND" }),
        args,
        acct.cfg.pageSizeDefault,
      );
      const wantedNames = new Set(ids.map((i) => idx.get(String(i))!.toLowerCase()));
      const attendees = nodes.map((n) => hydrate(n, mapAttendee(n, ev.slug, me.attendeeId), idx)).filter((a) => !a.is_me);
      const matched: Record<string, string[]> = {};
      for (const a of attendees) matched[a.attendee_id] = a.interests.filter((i) => wantedNames.has(i.toLowerCase()));
      return {
        attendees,
        matched_interests: matched,
        unknown_interests: unknown,
        page,
        truncated: !!page.capped || (!args.fetch_all && page.has_next),
        meta: meta(acct, ev.slug),
      };
    },
  );
}

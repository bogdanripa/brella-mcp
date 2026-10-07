import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BrellaError } from "../errors.js";
import { type MeetingModel, type SessionModel } from "../brella/mappers.js";
import { routes } from "../brella/routes.js";
import { accountArg, DESTRUCTIVE, eventArg, meta, overlaps, READ, sameDay, tool, type ToolContext, WRITE } from "./common.js";

const dayArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Day in YYYY-MM-DD (event timezone)");

export function registerAgendaTools(server: McpServer, ctx: ToolContext): void {
  tool(
    server,
    ctx,
    "brella_list_sessions",
    {
      title: "List agenda sessions",
      description: "Conference agenda sessions, sorted by start time, with bookmark state. Filter by day, stage, track, text or bookmarked-only.",
      input: {
        event: eventArg,
        day: dayArg,
        stage: z.string().optional().describe("Case-insensitive substring of the stage/room name"),
        track: z.string().optional(),
        query: z.string().optional().describe("Case-insensitive text match on title, description and speaker names"),
        only_bookmarked: z.boolean().optional(),
        account: accountArg,
      },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      let sessions = await acct.sessions(ev.slug, ev.timezone);
      const has = (h: string | null | undefined, n: string) => !!h && h.toLowerCase().includes(n.toLowerCase());
      if (args.day) sessions = sessions.filter((s) => sameDay(s.starts_at, args.day!, ev.timezone));
      if (args.stage) sessions = sessions.filter((s) => has(s.stage, args.stage!) || has(s.location, args.stage!));
      if (args.track) sessions = sessions.filter((s) => has(s.track, args.track!));
      if (args.query) {
        const q = args.query;
        sessions = sessions.filter((s) => has(s.title, q) || has(s.description, q) || s.speakers.some((sp) => has(sp.name, q) || has(sp.company, q)));
      }
      if (args.only_bookmarked) sessions = sessions.filter((s) => s.is_bookmarked);
      // Keep list payloads light: descriptions are available via brella_get_session.
      return { sessions: sessions.map(({ description: _d, ...s }) => s), count: sessions.length, meta: meta(acct, ev.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_get_session",
    {
      title: "Get session",
      description: "One agenda session with description and full speaker list.",
      input: { event: eventArg, session_id: z.string().min(1), account: accountArg },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      return { session: await acct.session(ev.slug, args.session_id, ev.timezone), meta: meta(acct, ev.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_bookmark_session",
    {
      title: "Bookmark (join) session",
      description: "Bookmark a session so it shows in My Agenda (and blocks that networking slot). Idempotent.",
      input: { event: eventArg, session_id: z.string().min(1), account: accountArg },
      annotations: WRITE,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      await acct.session(ev.slug, args.session_id, ev.timezone); // validates the id under this account
      const before = await acct.bookmarks(ev.slug, true);
      if (before.has(args.session_id)) return { session_id: args.session_id, bookmarked: true, already_applied: true, meta: meta(acct, ev.slug) };
      await acct.http.request("POST", routes.timeslotBookmarks(ev.slug), { query: { timeslot_id: args.session_id }, body: {} });
      acct.http.invalidate("timeslot_bookmarks");
      acct.http.invalidate("/schedule");
      return { session_id: args.session_id, bookmarked: true, already_applied: false, meta: meta(acct, ev.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_unbookmark_session",
    {
      title: "Remove session bookmark",
      description: "Remove a session from My Agenda. Idempotent.",
      input: { event: eventArg, session_id: z.string().min(1), account: accountArg },
      annotations: DESTRUCTIVE,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const before = await acct.bookmarks(ev.slug, true);
      const bookmarkId = before.get(args.session_id);
      if (!bookmarkId) return { session_id: args.session_id, bookmarked: false, already_applied: true, meta: meta(acct, ev.slug) };
      await acct.http.request("DELETE", routes.timeslotBookmark(ev.slug, bookmarkId));
      acct.http.invalidate("timeslot_bookmarks");
      acct.http.invalidate("/schedule");
      return { session_id: args.session_id, bookmarked: false, already_applied: false, meta: meta(acct, ev.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_get_my_agenda",
    {
      title: "Get My Agenda",
      description:
        "Bookmarked sessions + accepted meetings, sorted by start, with blocked networking slots and locally computed overlaps. " +
        "Check `overlaps` before accepting a meeting or bookmarking a session.",
      input: { event: eventArg, day: dayArg, include_pending: z.boolean().optional().describe("Also include pending meetings (default false)"), account: accountArg },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const [sessions, { meetings }] = await Promise.all([acct.sessions(ev.slug, ev.timezone), acct.meetings(ev.slug)]);
      const wanted = new Set(["accepted", ...(args.include_pending ? ["pending"] : [])]);
      let items: ({ kind: "session"; session: SessionModel } | { kind: "meeting"; meeting: MeetingModel })[] = [
        ...sessions.filter((s) => s.is_bookmarked).map((s) => ({ kind: "session" as const, session: s })),
        ...meetings.filter((m) => wanted.has(m.model.status) && m.model.starts_at).map((m) => ({ kind: "meeting" as const, meeting: m.model })),
      ];
      const start = (i: (typeof items)[number]) => (i.kind === "session" ? i.session.starts_at : i.meeting.starts_at);
      const end = (i: (typeof items)[number]) => (i.kind === "session" ? i.session.ends_at : i.meeting.ends_at);
      const id = (i: (typeof items)[number]) => (i.kind === "session" ? i.session.id : i.meeting.meeting_id);
      if (args.day) items = items.filter((i) => sameDay(start(i), args.day!, ev.timezone));
      items.sort((a, b) => String(start(a) ?? "").localeCompare(String(start(b) ?? "")));

      const blocked = items
        .filter((i) => i.kind === "meeting" || i.session.blocks_networking !== false)
        .map((i) => ({ starts_at: start(i), ends_at: end(i), reason: i.kind }));
      const conflicts: { a_id: string; b_id: string; kind: string }[] = [];
      for (let x = 0; x < items.length; x++) {
        for (let y = x + 1; y < items.length; y++) {
          const a = items[x];
          const b = items[y];
          if (overlaps(start(a), end(a), start(b), end(b))) {
            const kind = [a.kind, b.kind].sort().join("-");
            conflicts.push({ a_id: id(a), b_id: id(b), kind: kind === "meeting-session" ? "session-meeting" : kind });
          }
        }
      }
      return { items, blocked_networking_slots: blocked, overlaps: conflicts, meta: meta(acct, ev.slug) };
    },
  );
}

export function assertState(cond: boolean, message: string, fresh: unknown): void {
  if (!cond) throw new BrellaError("MEETING_STATE_CHANGED", message, { meeting: fresh });
}

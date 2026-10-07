import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mapEvent, mapNotification, type NotificationModel } from "../brella/mappers.js";
import { routes } from "../brella/routes.js";
import { type BrellaAccount, LIVE_TTL, pageQuery, paged, type PageInput } from "../brella/service.js";
import { listConversations } from "./chat.js";
import { accountArg, meta, pagingArgs, READ, tool, type ToolContext } from "./common.js";

async function notificationsFor(acct: BrellaAccount, slug: string, input: PageInput) {
  return paged(
    (number, size) => acct.http.get(routes.notificationHistory(slug), { query: pageQuery(number, size), cacheTtlMs: LIVE_TTL, notFound: "EVENT_NOT_FOUND" }),
    input,
    acct.cfg.pageSizeDefault,
  );
}

export function registerActivityTools(server: McpServer, ctx: ToolContext): void {
  tool(
    server,
    ctx,
    "brella_list_notifications",
    {
      title: "List notifications",
      description:
        "Activity feed (new meeting requests, accepts/declines/cancellations, chat messages, reminders), newest first. " +
        "Use `since` for change detection. Without `event`, covers the account's ongoing and upcoming events.",
      input: {
        event: z.string().optional().describe("Event slug or URL; omit for all ongoing/upcoming events"),
        unread_only: z.boolean().optional(),
        since: z.string().optional().describe("ISO timestamp; only items created after it"),
        account: accountArg,
        ...pagingArgs,
      },
      annotations: READ,
    },
    async (args, acct) => {
      let slugs: string[];
      if (args.event) slugs = [(await acct.event(args.event)).slug];
      else {
        const evs = (await acct.myEvents()).map((n) => mapEvent(n)).filter((e) => e.slug && (e.status === "ongoing" || e.status === "upcoming"));
        slugs = [...new Set(evs.map((e) => e.slug))].slice(0, 5);
      }
      const all: (NotificationModel & { event_slug: string })[] = [];
      const pages: Record<string, unknown> = {};
      for (const slug of slugs) {
        const { nodes, page } = await notificationsFor(acct, slug, args);
        pages[slug] = page;
        all.push(...nodes.map((n) => ({ ...mapNotification(n), event_slug: slug })));
      }
      const since = args.since ? new Date(args.since).getTime() : null;
      const notifications = all
        .filter((n) => !since || (n.created_at != null && new Date(n.created_at).getTime() > since))
        .filter((n) => !args.unread_only || n.is_read === false)
        .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
      return {
        notifications,
        page: slugs.length === 1 ? pages[slugs[0]] : pages,
        ...(args.unread_only ? { note: "Brella tracks read state on the device; items without read state are excluded by unread_only." } : {}),
        meta: meta(acct, slugs.length === 1 ? slugs[0] : null),
      };
    },
  );

  tool(
    server,
    ctx,
    "brella_get_networking_summary",
    {
      title: "Networking summary",
      description: "Cheap counts for hourly polling: pending incoming/outgoing requests, unread conversations, recent notifications, and the next accepted meeting.",
      input: { event: z.string().min(1).describe("Event slug or URL"), account: accountArg },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const [{ meetings }, convs, notes] = await Promise.all([
        acct.meetings(ev.slug),
        listConversations(acct, ev.slug),
        notificationsFor(acct, ev.slug, { page_size: 50 }).catch(() => ({ nodes: [] as any[] })),
      ]);
      const ms = meetings.map((m) => m.model).filter((m) => !m.is_chat_only);
      const now = Date.now();
      const next =
        ms
          .filter((m) => m.status === "accepted" && m.starts_at && new Date(m.ends_at ?? m.starts_at).getTime() > now)
          .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))[0] ?? null;
      const mapped = notes.nodes.map(mapNotification);
      return {
        pending_incoming: ms.filter((m) => m.status === "pending" && m.direction === "incoming").length,
        pending_outgoing: ms.filter((m) => m.status === "pending" && m.direction === "outgoing").length,
        unread_conversations: convs.conversations.filter((c) => (c.unread_count ?? 0) > 0).length,
        unread_notifications: mapped.some((n) => n.is_read !== null) ? mapped.filter((n) => n.is_read === false).length : null,
        latest_notification_at: mapped.map((n) => n.created_at).filter(Boolean).sort().pop() ?? null,
        next_meeting: next,
        meta: meta(acct, ev.slug),
      };
    },
  );
}

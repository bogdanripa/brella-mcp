import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendChatMessage } from "../brella/cable.js";
import { type ConversationModel, conversationFromMeeting, mapMeeting, mapMessage, type MessageModel } from "../brella/mappers.js";
import { routes } from "../brella/routes.js";
import { type BrellaAccount, LIVE_TTL, pageQuery, paged } from "../brella/service.js";
import { BrellaError } from "../errors.js";
import { accountArg, eventArg, meta, pagingArgs, READ, tool, type ToolContext, WRITE } from "./common.js";

const bodyArg = z.string().min(1).max(2000).describe("Message text (single recipient)");

export async function listConversations(acct: BrellaAccount, event: string): Promise<{ slug: string; conversations: ConversationModel[] }> {
  const { event: ev, meetings } = await acct.meetings(event);
  const byId = new Map<string, ConversationModel>();
  for (const { node, model } of meetings) {
    const c = conversationFromMeeting(node, model);
    if (c && !byId.has(c.conversation_id)) byId.set(c.conversation_id, c);
  }
  const conversations = [...byId.values()].sort((a, b) => String(b.last_message_at ?? "").localeCompare(String(a.last_message_at ?? "")));
  return { slug: ev.slug, conversations };
}

async function recentMessages(acct: BrellaAccount, conversationId: string, size = 10): Promise<MessageModel[]> {
  const me = await acct.me();
  const doc = await acct.http.get(routes.chatMessages(conversationId), {
    query: pageQuery(1, size),
    notFound: "CONVERSATION_NOT_FOUND",
  });
  return doc.data.map((n) => mapMessage(n, conversationId, me));
}

/** Send and then prove delivery (spec §7.6: no blind retry; confirm by re-reading). */
async function sendAndConfirm(acct: BrellaAccount, conversationId: string, body: string) {
  await recentMessages(acct, conversationId, 1); // access check → CONVERSATION_NOT_FOUND for foreign ids
  const sentAt = Date.now();
  const res = await sendChatMessage(acct.http, acct.cfg, conversationId, body);
  acct.http.invalidate(`chat_conversations/${conversationId}`);
  const me = await acct.me();
  if (res.echoed && res.message) {
    return { message: mapMessage(res.message, conversationId, me), delivery: "confirmed" as const };
  }
  const recent = await recentMessages(acct, conversationId, 10).catch(() => [] as MessageModel[]);
  const found = recent.find((m) => m.sender.is_me && m.body === body && (!m.sent_at || new Date(m.sent_at).getTime() >= sentAt - 120_000));
  return {
    message: found ?? { message_id: res.uuid, conversation_id: conversationId, sender: { user_id: me.userId, attendee_id: null, name: null, is_me: true }, body, sent_at: null, is_meeting_proposal: false, proposed_meeting: null },
    delivery: found ? ("confirmed" as const) : ("unknown" as const),
  };
}

export function registerChatTools(server: McpServer, ctx: ToolContext): void {
  tool(
    server,
    ctx,
    "brella_list_conversations",
    {
      title: "List conversations",
      description: "Chat conversations in an event (each is linked to a meeting or chat request), most recent first.",
      input: { event: eventArg, unread_only: z.boolean().optional(), account: accountArg, ...pagingArgs },
      annotations: READ,
    },
    async (args, acct) => {
      const { slug, conversations } = await listConversations(acct, args.event);
      const filtered = args.unread_only ? conversations.filter((c) => (c.unread_count ?? 0) > 0) : conversations;
      const size = Math.min(args.page_size ?? acct.cfg.pageSizeDefault, 120);
      const number = args.page_number ?? 1;
      const slice = args.fetch_all ? filtered : filtered.slice((number - 1) * size, number * size);
      return {
        conversations: slice,
        page: { number, size, total_items: filtered.length, has_next: !args.fetch_all && number * size < filtered.length },
        meta: meta(acct, slug),
      };
    },
  );

  tool(
    server,
    ctx,
    "brella_get_conversation_messages",
    {
      title: "Get conversation messages",
      description: "Messages in one conversation, returned oldest → newest. page_number 1 is the most recent page.",
      input: { conversation_id: z.string().min(1), account: accountArg, ...pagingArgs },
      annotations: READ,
    },
    async (args, acct) => {
      const me = await acct.me();
      const { nodes, page } = await paged(
        (number, size) =>
          acct.http.get(routes.chatMessages(args.conversation_id), { query: pageQuery(number, size), cacheTtlMs: LIVE_TTL, notFound: "CONVERSATION_NOT_FOUND" }),
        args,
        acct.cfg.pageSizeDefault,
      );
      const messages = nodes
        .map((n) => mapMessage(n, args.conversation_id, me))
        .sort((a, b) => String(a.sent_at ?? "").localeCompare(String(b.sent_at ?? "")));
      return { messages, page, meta: meta(acct) };
    },
  );

  tool(
    server,
    ctx,
    "brella_send_chat_message",
    {
      title: "Send chat message",
      description: "Send one message in an existing conversation. Not retried; delivery is confirmed by re-reading the conversation (`delivery: confirmed | unknown`).",
      input: { conversation_id: z.string().min(1), body: bodyArg, account: accountArg },
      annotations: WRITE,
    },
    async (args, acct) => {
      const out = await sendAndConfirm(acct, args.conversation_id, args.body);
      return { ...out, meta: meta(acct) };
    },
  );

  tool(
    server,
    ctx,
    "brella_start_chat",
    {
      title: "Start chat with attendee",
      description: "Open (or return the existing) conversation with one attendee, optionally sending an opening message. Starting a brand-new chat requires `body`.",
      input: { event: eventArg, attendee_id: z.string().min(1), body: bodyArg.optional(), account: accountArg },
      annotations: WRITE,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const { conversations } = await listConversations(acct, ev.slug);
      const existing = conversations.find((c) => c.participants.some((p) => p.attendee_id === args.attendee_id));
      if (existing) {
        const sent = args.body ? await sendAndConfirm(acct, existing.conversation_id, args.body) : null;
        return { conversation: existing, created: false, ...(sent ? { message: sent.message, delivery: sent.delivery } : {}), meta: meta(acct, ev.slug) };
      }
      if (!args.body) throw new BrellaError("INVALID_ARGUMENT", "No existing conversation with this attendee; provide `body` to start one");
      if (!ev.event_id) throw new BrellaError("UPSTREAM_CHANGED", "Event payload has no numeric id");
      const userId = await acct.userIdForAttendee(ev.slug, args.attendee_id);
      const doc = await acct.http.request("POST", routes.startChat(), {
        body: { meeting: { user_id: Number(userId) || userId, event_id: Number(ev.event_id) || ev.event_id, message: args.body } },
      });
      acct.http.invalidate("/me/meetings");
      const node = doc.data[0];
      const me = await acct.meWithAttendee(ev.slug);
      const model = node ? mapMeeting(node, me, ev.slug, ev.timezone) : null;
      const conv = node && model ? conversationFromMeeting(node, model) : null;
      return {
        conversation: conv ?? { conversation_id: null, event_slug: ev.slug, meeting_id: model?.meeting_id ?? null, participants: model?.counterpart ? [model.counterpart] : [] },
        created: true,
        meta: meta(acct, ev.slug),
      };
    },
  );
}

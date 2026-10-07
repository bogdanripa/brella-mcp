import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendChatMessage } from "../brella/cable.js";
import { type MeetingModel, mapMeeting, mapSlot } from "../brella/mappers.js";
import { routes } from "../brella/routes.js";
import type { BrellaAccount } from "../brella/service.js";
import { BrellaError } from "../errors.js";
import { assertState } from "./agenda.js";
import { accountArg, DESTRUCTIVE, eventArg, includeRawArg, meta, READ, sameDay, tool, type ToolContext, withRaw, WRITE } from "./common.js";

const meetingIdArg = z.string().min(1).describe("Brella meeting id");
const isoArg = z.string().min(10).describe("ISO 8601 start time, e.g. 2026-10-07T13:45:00+03:00");

/** Re-read after a write so callers see what Brella actually stored. */
async function fresh(acct: BrellaAccount, id: string): Promise<MeetingModel> {
  acct.http.invalidate("/me/meetings");
  return (await acct.meeting(id)).model;
}

function sameInstant(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 60_000;
}

/** Map a validation refusal on a meeting write to the spec's codes. */
async function onWriteError(e: unknown, acct: BrellaAccount, id: string | null): Promise<never> {
  if (e instanceof BrellaError && (e.code === "INVALID_ARGUMENT" || e.code === "MEETING_STATE_CHANGED")) {
    const text = [e.message, ...((e.details.upstream_errors as string[]) ?? [])].join(" ").toLowerCase();
    const freshState = id ? await fresh(acct, id).catch(() => null) : null;
    if (/slot|time|busy|overlap|taken|available|block/.test(text)) {
      throw new BrellaError("SLOT_UNAVAILABLE", e.message, { meeting: freshState, upstream_errors: e.details.upstream_errors });
    }
    throw new BrellaError("MEETING_STATE_CHANGED", e.message, { meeting: freshState, upstream_errors: e.details.upstream_errors });
  }
  throw e;
}

async function resolveSlot(acct: BrellaAccount, slug: string, attendeeId: string, startsAt: string, meetingId?: string) {
  const slots = await acct.suggestedSlots(slug, attendeeId, meetingId);
  const hit = slots.find((s) => sameInstant((s as any).startTime ?? (s as any).startsAt, startsAt));
  if (!hit) {
    throw new BrellaError("SLOT_UNAVAILABLE", `No free meeting slot starting at ${startsAt} for both of you`, {
      available_starts: slots.slice(0, 20).map((s) => (s as any).startTime ?? (s as any).startsAt).filter(Boolean),
    });
  }
  return hit;
}

export function registerMeetingTools(server: McpServer, ctx: ToolContext): void {
  tool(
    server,
    ctx,
    "brella_list_meeting_requests",
    {
      title: "List meeting requests",
      description: "1:1 meeting requests in an event (incoming/outgoing, any status), newest first. Chat-only conversations are excluded; use brella_list_conversations for those.",
      input: {
        event: eventArg,
        status: z.enum(["pending", "accepted", "declined", "cancelled", "all"]).optional().describe("Default all"),
        direction: z.enum(["incoming", "outgoing", "all"]).optional().describe("Default all"),
        include_chat_only: z.boolean().optional().describe("Also include chat requests without a time slot (default false)"),
        include_raw: includeRawArg,
        account: accountArg,
      },
      annotations: READ,
    },
    async (args, acct) => {
      const { event, meetings } = await acct.meetings(args.event);
      const list = meetings
        .filter(({ model }) => args.include_chat_only || !model.is_chat_only)
        .filter(({ model }) => !args.status || args.status === "all" || model.status === args.status)
        .filter(({ model }) => !args.direction || args.direction === "all" || model.direction === args.direction)
        .sort((a, b) => String(b.model.created_at ?? "").localeCompare(String(a.model.created_at ?? "")))
        .map(({ model, node }) => withRaw(model, node, args.include_raw));
      return { meetings: list, count: list.length, meta: meta(acct, event.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_get_meeting_request",
    {
      title: "Get meeting request",
      description: "One meeting/meeting request with counterpart, time, location and linked conversation.",
      input: { meeting_id: meetingIdArg, include_raw: includeRawArg, account: accountArg },
      annotations: READ,
    },
    async (args, acct) => {
      const { node, model } = await acct.meeting(args.meeting_id);
      return { meeting: withRaw(model, node, args.include_raw), meta: meta(acct, model.event_slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_accept_meeting_request",
    {
      title: "Accept meeting request",
      description: "Accept a pending incoming meeting request. Idempotent; returns SLOT_UNAVAILABLE / MEETING_STATE_CHANGED with fresh state if it can no longer be accepted.",
      input: { meeting_id: meetingIdArg, account: accountArg },
      annotations: WRITE,
    },
    async (args, acct) => {
      const { model } = await acct.meeting(args.meeting_id);
      if (model.status === "accepted") return { meeting: model, already_applied: true, meta: meta(acct, model.event_slug) };
      assertState(model.status === "pending", `Meeting is ${model.raw_status ?? model.status}, not pending`, model);
      assertState(model.direction !== "outgoing", "This is your own outgoing request; only the other person can accept it", model);
      try {
        await acct.http.request("PATCH", routes.meetingAction(args.meeting_id, "accept"), { body: {} });
      } catch (e) {
        await onWriteError(e, acct, args.meeting_id);
      }
      return { meeting: await fresh(acct, args.meeting_id), already_applied: false, meta: meta(acct, model.event_slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_decline_meeting_request",
    {
      title: "Decline meeting request",
      description: "Decline a pending incoming meeting request, optionally with a short note to the requester (sent in the decline itself).",
      input: { meeting_id: meetingIdArg, note: z.string().max(1000).optional(), account: accountArg },
      annotations: DESTRUCTIVE,
    },
    async (args, acct) => {
      const { model } = await acct.meeting(args.meeting_id);
      if (model.status === "declined") return { meeting: model, note_delivery: "not_sent", already_applied: true, meta: meta(acct, model.event_slug) };
      assertState(model.status === "pending", `Meeting is ${model.raw_status ?? model.status}, not pending`, model);
      assertState(model.direction !== "outgoing", "This is your own outgoing request; use brella_cancel_meeting instead", model);
      try {
        await acct.http.request("PATCH", routes.meetingAction(args.meeting_id, "reject"), {
          body: { meeting: { message: args.note ?? "", freeze_chat: false } },
        });
      } catch (e) {
        await onWriteError(e, acct, args.meeting_id);
      }
      return {
        meeting: await fresh(acct, args.meeting_id),
        note_delivery: args.note ? "decline_payload" : "not_sent",
        already_applied: false,
        meta: meta(acct, model.event_slug),
      };
    },
  );

  tool(
    server,
    ctx,
    "brella_cancel_meeting",
    {
      title: "Cancel meeting",
      description: "Cancel an accepted meeting or withdraw your own pending outgoing request, optionally with a note. Distinct from declining an incoming request.",
      input: { meeting_id: meetingIdArg, note: z.string().max(1000).optional(), account: accountArg },
      annotations: DESTRUCTIVE,
    },
    async (args, acct) => {
      const { model } = await acct.meeting(args.meeting_id);
      if (model.status === "cancelled") return { meeting: model, already_applied: true, meta: meta(acct, model.event_slug) };
      assertState(
        model.status === "accepted" || (model.status === "pending" && model.direction !== "incoming"),
        model.status === "pending" ? "Incoming pending requests are declined, not cancelled" : `Meeting is ${model.raw_status ?? model.status}`,
        model,
      );
      try {
        await acct.http.request("PATCH", routes.meetingAction(args.meeting_id, "cancel"), {
          body: { meeting: { message: args.note ?? "", freeze_chat: false } },
        });
      } catch (e) {
        await onWriteError(e, acct, args.meeting_id);
      }
      return { meeting: await fresh(acct, args.meeting_id), already_applied: false, meta: meta(acct, model.event_slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_list_available_meeting_slots",
    {
      title: "List available meeting slots",
      description:
        "Free networking slots. With attendee_id: slots Brella suggests as free for both of you. Without: your own networking slots and whether each is blocked.",
      input: { event: eventArg, attendee_id: z.string().optional(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), account: accountArg },
      annotations: READ,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      const nodes = args.attendee_id ? await acct.suggestedSlots(ev.slug, args.attendee_id) : await acct.availability(ev.slug, args.day);
      let slots = nodes.map((n) => mapSlot(n, ev.timezone, args.attendee_id ? false : undefined));
      if (args.day) slots = slots.filter((s) => sameDay(s.starts_at, args.day!, ev.timezone));
      slots.sort((a, b) => String(a.starts_at ?? "").localeCompare(String(b.starts_at ?? "")));
      return { slots, meta: meta(acct, ev.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_propose_meeting",
    {
      title: "Propose a meeting",
      description: "Send one attendee a 1:1 meeting request at an explicit start time (must match a free slot; meeting length is fixed by the event).",
      input: { event: eventArg, attendee_id: z.string().min(1), starts_at: isoArg, note: z.string().max(1000).optional(), account: accountArg },
      annotations: WRITE,
    },
    async (args, acct) => {
      const ev = await acct.event(args.event);
      if (!ev.event_id) throw new BrellaError("UPSTREAM_CHANGED", "Event payload has no numeric id");
      const me = await acct.meWithAttendee(ev.slug);
      // Idempotency: an open request to the same person at the same time already exists.
      const { meetings } = await acct.meetings(ev.slug);
      const dup = meetings.find(
        ({ model }) =>
          model.counterpart?.attendee_id === args.attendee_id && ["pending", "accepted"].includes(model.status) && sameInstant(model.starts_at, args.starts_at),
      );
      if (dup) return { meeting: dup.model, already_applied: true, meta: meta(acct, ev.slug) };

      const userId = await acct.userIdForAttendee(ev.slug, args.attendee_id);
      const slot = await resolveSlot(acct, ev.slug, args.attendee_id, args.starts_at);
      let created;
      try {
        created = await acct.http.request("POST", routes.meetings(), {
          body: { meeting: { user_id: Number(userId) || userId, event_id: Number(ev.event_id) || ev.event_id, message: args.note ?? "", timeslot_id: Number(slot.id) || slot.id } },
        });
      } catch (e) {
        await onWriteError(e, acct, null);
      }
      acct.http.invalidate("/me/meetings");
      const node = created!.data[0];
      const model = node ? mapMeeting(node, me, ev.slug, ev.timezone) : null;
      return { meeting: model, already_applied: false, meta: meta(acct, ev.slug) };
    },
  );

  tool(
    server,
    ctx,
    "brella_propose_reschedule",
    {
      title: "Propose a new meeting time",
      description:
        "Propose a different time for an existing meeting. mode=native (default) uses Brella's reschedule action, which the counterpart then accepts/declines; " +
        "mode=chat_proposal only sends the proposed time as a chat message on the linked conversation. Never cancels the existing meeting.",
      input: {
        meeting_id: meetingIdArg,
        starts_at: isoArg,
        note: z.string().max(1000).optional(),
        mode: z.enum(["native", "chat_proposal"]).optional(),
        account: accountArg,
      },
      annotations: WRITE,
    },
    async (args, acct) => {
      const { model } = await acct.meeting(args.meeting_id);
      const mode = args.mode ?? "native";
      if (mode === "chat_proposal") {
        if (!model.conversation_id) throw new BrellaError("CONVERSATION_NOT_FOUND", "This meeting has no linked conversation");
        const when = new Date(args.starts_at);
        const local = model.timezone
          ? new Intl.DateTimeFormat("en-GB", { timeZone: model.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(when)
          : args.starts_at;
        const body = args.note ? `${args.note}` : `Could we move our meeting to ${local}?`;
        const res = await sendChatMessage(acct.http, acct.cfg, model.conversation_id, body);
        return {
          meeting_id: args.meeting_id,
          proposed_starts_at: args.starts_at,
          mode: "chat_proposal",
          conversation_id: model.conversation_id,
          delivery: res.echoed ? "confirmed" : "unknown",
          meta: meta(acct, model.event_slug),
        };
      }
      assertState(["pending", "accepted", "reschedule_proposed"].includes(model.status), `Meeting is ${model.raw_status ?? model.status}`, model);
      if (sameInstant(model.starts_at, args.starts_at)) {
        return { meeting_id: args.meeting_id, proposed_starts_at: args.starts_at, mode: "native", already_applied: true, meeting: model, meta: meta(acct, model.event_slug) };
      }
      if (!model.event_slug || !model.counterpart?.attendee_id) {
        throw new BrellaError("UPSTREAM_CHANGED", "Cannot resolve the counterpart/event for this meeting; use mode=chat_proposal");
      }
      const slot = await resolveSlot(acct, model.event_slug, model.counterpart.attendee_id, args.starts_at, args.meeting_id);
      try {
        await acct.http.request("PATCH", routes.meetingAction(args.meeting_id, "reschedule"), {
          body: { meeting: { message: args.note ?? "", timeslot_id: Number(slot.id) || slot.id, unset_location: true } },
        });
      } catch (e) {
        await onWriteError(e, acct, args.meeting_id);
      }
      return {
        meeting_id: args.meeting_id,
        proposed_starts_at: args.starts_at,
        mode: "native",
        conversation_id: model.conversation_id,
        meeting: await fresh(acct, args.meeting_id),
        meta: meta(acct, model.event_slug),
      };
    },
  );
}

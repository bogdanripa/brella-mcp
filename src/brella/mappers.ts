import type { Node } from "./jsonapi.js";
import { pick } from "./jsonapi.js";

/**
 * Upstream → spec §6 models. Brella's attribute names are only partly pinned
 * (route table is pinned; payload keys come from public scrapers and the web
 * app's own field usage), so every mapper reads a short list of candidates and
 * never invents values.
 */

const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const fullName = (o: any): string | null =>
  str(pick(o, "name", "fullName")) ?? (str([pick(o, "firstName"), pick(o, "lastName")].filter(Boolean).join(" ")) || null);

// ---------- events ----------

export interface EventModel {
  slug: string;
  event_id: string | null;
  name: string | null;
  status: "ongoing" | "upcoming" | "past" | "unknown";
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  venue: string | null;
  is_physical: boolean | null;
  web_url: string;
}

export function eventStatus(starts: string | null, ends: string | null, now = new Date()): EventModel["status"] {
  if (!starts && !ends) return "unknown";
  const s = starts ? new Date(starts) : null;
  const e = ends ? new Date(ends) : null;
  // Date-only ends mean "through the end of that day".
  if (e && ends && /^\d{4}-\d{2}-\d{2}$/.test(ends)) e.setUTCHours(23, 59, 59);
  if (e && now > e) return "past";
  if (s && now < s) return "upcoming";
  return "ongoing";
}

export function mapEvent(n: Node, now = new Date()): EventModel {
  const ev = n.type === "attendee" && n.event && typeof n.event === "object" ? n.event : n;
  const slug = String(pick(ev, "slug", "eventSlug") ?? ev.id ?? "");
  const starts = str(pick(ev, "startTime", "startDate", "startsAt", "startAt"));
  const ends = str(pick(ev, "endTime", "endDate", "endsAt", "endAt"));
  const venueParts = [pick(ev, "venueName", "venue", "locationName"), pick(ev, "address", "streetAddress"), pick(ev, "city")]
    .filter((x) => typeof x === "string" && x.trim()) as string[];
  const type = str(pick(ev, "eventType", "attendanceType", "type_"));
  return {
    slug,
    event_id: str(ev.id),
    name: str(pick(ev, "name", "title")),
    status: eventStatus(starts, ends, now),
    starts_at: starts,
    ends_at: ends,
    timezone: str(pick(ev, "timeZone", "timezone", "tz")),
    venue: venueParts.length ? [...new Set(venueParts)].join(", ") : null,
    is_physical: type ? !/virtual|online/i.test(type) : typeof ev.isVirtual === "boolean" ? !ev.isVirtual : null,
    web_url: `https://next.brella.io/events/${encodeURIComponent(slug)}/home`,
  };
}

/** Accepts "HTW2026" or any next.brella.io URL containing /events/<slug>/. */
export function parseEventSlug(input: string): string {
  const s = input.trim();
  const m = s.match(/\/events\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  return s.replace(/^\/+|\/+$/g, "");
}

// ---------- attendees ----------

export interface AttendeeModel {
  attendee_id: string;
  user_id: string | null;
  event_slug: string;
  name: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  badge: string | null;
  bio: string | null;
  interests: string[];
  looking_for: string[];
  social: { linkedin: string | null; website: string | null };
  is_me: boolean;
}

function interestNames(n: any): { offering: string[]; seeking: string[]; all: string[] } {
  const all: string[] = [];
  const seeking: string[] = [];
  const offering: string[] = [];
  const sel: any[] = n.selectedInterests ?? n.attendeeInterests ?? [];
  for (const si of sel) {
    const name = str(pick(si, "interest.name", "name", "interestName"));
    if (!name) continue;
    if (!all.includes(name)) all.push(name);
    const intent = String(pick(si, "intent.matchLabel", "intent.selectionLabel", "intent.slug", "intentName") ?? "").toLowerCase();
    if (/seek|look|want|need|find/.test(intent)) seeking.push(name);
    else if (intent) offering.push(name);
  }
  if (all.length === 0 && Array.isArray(n.interests)) {
    for (const i of n.interests) {
      const name = typeof i === "string" ? i : str(pick(i, "name"));
      if (name && !all.includes(name)) all.push(name);
    }
  }
  return { offering, seeking, all };
}

export function mapAttendee(n: Node, eventSlug: string, meAttendeeId?: string | null): AttendeeModel {
  const user = (n.user && typeof n.user === "object" ? n.user : {}) as any;
  const ints = interestNames(n);
  const lookingFor = (n.lookingFor as string[] | undefined) ?? (ints.seeking.length ? ints.seeking : []);
  return {
    attendee_id: String(n.id),
    user_id: str(pick(n, "userId", "user.id")),
    event_slug: eventSlug,
    name: fullName(n) ?? fullName(user),
    title: str(pick(n, "companyTitle", "jobTitle", "title")),
    company: str(pick(n, "companyName", "company")),
    location: str(pick(n, "location", "city", "country", "user.country")),
    badge: str(pick(n, "persona.name", "group.name", "badge", "ticketType")),
    bio: str(pick(n, "pitch", "bio", "description")),
    interests: ints.all,
    looking_for: Array.isArray(lookingFor) ? lookingFor : [],
    social: {
      linkedin: str(pick(user, "linkedin", "linkedinUrl") ?? pick(n, "linkedin")),
      website: str(pick(user, "website", "websiteUrl") ?? pick(n, "website")),
    },
    is_me: meAttendeeId != null && String(n.id) === String(meAttendeeId),
  };
}

// ---------- sessions (timeslots) ----------

export interface SessionModel {
  id: string;
  event_slug: string;
  title: string | null;
  description?: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  stage: string | null;
  track: string | null;
  location: string | null;
  speakers: { attendee_id: string | null; speaker_id: string | null; name: string | null; title: string | null; company: string | null }[];
  is_bookmarked: boolean;
  blocks_networking: boolean | null;
  kind: string | null;
}

export function mapSession(n: Node, eventSlug: string, bookmarkedIds: Set<string>, tz: string | null): SessionModel {
  const speakers = ((n.speakers ?? n.timeslotSpeakers ?? []) as any[]).map((s) => {
    const sp = s.speaker && typeof s.speaker === "object" ? s.speaker : s;
    return {
      attendee_id: str(pick(sp, "attendeeId", "attendee.id")),
      speaker_id: str(sp.id),
      name: fullName(sp),
      title: str(pick(sp, "companyTitle", "title", "jobTitle")),
      company: str(pick(sp, "companyName", "company")),
    };
  });
  const stage = str(pick(n, "stage.name", "room.name", "stageName", "roomName", "location.name"));
  return {
    id: String(n.id),
    event_slug: eventSlug,
    title: str(pick(n, "title", "name")),
    description: str(pick(n, "description", "body")),
    starts_at: str(pick(n, "startTime", "startsAt", "startAt")),
    ends_at: str(pick(n, "endTime", "endsAt", "endAt")),
    timezone: tz,
    stage,
    track: str(pick(n, "track.name", "trackName")),
    location: str(pick(n, "location.name", "locationName")) ?? stage,
    speakers,
    is_bookmarked: bookmarkedIds.has(String(n.id)) || n.isBookmarked === true || n.bookmarked === true,
    blocks_networking: typeof n.blocksNetworking === "boolean" ? n.blocksNetworking : typeof n.blockNetworking === "boolean" ? n.blockNetworking : null,
    kind: str(pick(n, "timeslotType", "kind", "category")),
  };
}

// ---------- meetings ----------

export type MeetingStatus = "pending" | "accepted" | "declined" | "cancelled" | "reschedule_proposed" | "completed" | "unknown";

/** Fixture-tested status map (spec §6.4). */
export const MEETING_STATUS_MAP: Record<string, MeetingStatus> = {
  pending: "pending",
  requested: "pending",
  suggested: "pending",
  accepted: "accepted",
  confirmed: "accepted",
  rejected: "declined",
  declined: "declined",
  cancelled: "cancelled",
  canceled: "cancelled",
  reschedule_requested: "reschedule_proposed",
  rescheduled: "reschedule_proposed",
  reschedule_proposed: "reschedule_proposed",
  completed: "completed",
  finished: "completed",
  done: "completed",
};

export function mapMeetingStatus(raw: string | null | undefined): MeetingStatus {
  if (!raw) return "unknown";
  return MEETING_STATUS_MAP[String(raw).toLowerCase()] ?? "unknown";
}

export interface MeetingModel {
  meeting_id: string;
  event_slug: string | null;
  direction: "incoming" | "outgoing" | "unknown";
  status: MeetingStatus;
  raw_status: string | null;
  is_chat_only: boolean;
  counterpart: { attendee_id: string | null; user_id: string | null; name: string | null; title: string | null; company: string | null } | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  timeslot_id: string | null;
  location: string | null;
  table: string | null;
  note: string | null;
  conversation_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  web_url: string | null;
}

export interface MeContext {
  userId: string | null;
  attendeeId?: string | null;
}

function personFrom(x: any): MeetingModel["counterpart"] {
  if (!x || typeof x !== "object") return null;
  const att = x.attendee && typeof x.attendee === "object" ? x.attendee : x.type === "attendee" ? x : null;
  const user = x.user && typeof x.user === "object" ? x.user : x.type === "user" ? x : null;
  return {
    attendee_id: str(att?.id ?? pick(x, "attendeeId")),
    user_id: str(user?.id ?? pick(x, "userId", "user.id") ?? (x.type === "user" ? x.id : undefined)),
    name: fullName(att ?? {}) ?? fullName(user ?? {}) ?? fullName(x),
    title: str(pick(att ?? x, "companyTitle", "title")),
    company: str(pick(att ?? x, "companyName", "company")),
  };
}

export function mapMeeting(n: Node, me: MeContext, eventSlug: string | null, tz: string | null): MeetingModel {
  const rawStatus = str(pick(n, "status", "state"));
  const senderId = str(pick(n, "senderId", "sender.id", "requesterId", "requester.id", "inviterId", "inviter.id", "userId"));
  const receiverId = str(pick(n, "receiverId", "receiver.id", "inviteeId", "invitee.id", "otherUserId"));
  let direction: MeetingModel["direction"] = "unknown";
  if (typeof n.isSender === "boolean") direction = n.isSender ? "outgoing" : "incoming";
  else if (typeof n.incoming === "boolean") direction = n.incoming ? "incoming" : "outgoing";
  else if (me.userId && senderId) direction = senderId === me.userId ? "outgoing" : "incoming";
  else if (me.userId && receiverId) direction = receiverId === me.userId ? "incoming" : "outgoing";

  // Counterpart: explicit fields first, then sender/receiver, then participants.
  let counterpart = personFrom(n.otherAttendee ?? n.otherUser ?? n.otherParticipant);
  if (!counterpart && me.userId) {
    const s = n.sender ?? n.requester ?? n.inviter;
    const r = n.receiver ?? n.invitee;
    if (s && str(s.id) !== me.userId && str(pick(s, "userId", "user.id")) !== me.userId) counterpart = personFrom(s);
    else if (r) counterpart = personFrom(r);
  }
  if (!counterpart && Array.isArray(n.participants ?? n.meetingParticipants ?? n.attendees)) {
    const list = (n.participants ?? n.meetingParticipants ?? n.attendees) as any[];
    const other = list.find((p) => {
      const uid = str(pick(p, "userId", "user.id"));
      const aid = str(pick(p, "attendeeId", "attendee.id")) ?? (p.type === "attendee" ? str(p.id) : null);
      return (me.userId ? uid !== me.userId : true) && (me.attendeeId ? aid !== me.attendeeId : true);
    });
    counterpart = personFrom(other);
  }

  const timeslot = n.timeslot && typeof n.timeslot === "object" ? n.timeslot : null;
  const location = n.location && typeof n.location === "object" ? n.location : null;
  const slug = eventSlug ?? str(pick(n, "event.slug", "eventSlug"));
  const chatOnly = n.chat === true || n.isChat === true || /chat/i.test(String(pick(n, "meetingType", "kind") ?? "")) || (!timeslot && !pick(n, "startTime"));
  return {
    meeting_id: String(n.id),
    event_slug: slug,
    direction,
    status: mapMeetingStatus(rawStatus),
    raw_status: rawStatus,
    is_chat_only: chatOnly,
    counterpart,
    starts_at: str(pick(timeslot, "startTime", "startsAt") ?? pick(n, "startTime", "startsAt")),
    ends_at: str(pick(timeslot, "endTime", "endsAt") ?? pick(n, "endTime", "endsAt")),
    timezone: tz,
    timeslot_id: str(timeslot?.id ?? pick(n, "timeslotId")),
    location: str(pick(location, "name", "title") ?? pick(n, "locationName", "networkingArea.name")),
    table: str(pick(n, "tableName", "table", "tableNumber", "location.tableName")),
    note: str(pick(n, "message", "note", "lastMessage")),
    conversation_id: str(pick(n, "chatConversation.id", "chatConversationId", "conversationId")),
    created_at: str(pick(n, "createdAt")),
    updated_at: str(pick(n, "updatedAt")),
    web_url: slug ? `https://next.brella.io/events/${encodeURIComponent(slug)}/meetings` : null,
  };
}

// ---------- chat ----------

export interface ConversationModel {
  conversation_id: string;
  event_slug: string | null;
  participants: { attendee_id: string | null; user_id: string | null; name: string | null }[];
  meeting_id: string | null;
  meeting_status: MeetingStatus;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number | null;
}

export function conversationFromMeeting(n: Node, m: MeetingModel): ConversationModel | null {
  if (!m.conversation_id) return null;
  const conv = (n.chatConversation && typeof n.chatConversation === "object" ? n.chatConversation : {}) as any;
  const unread = pick<number>(conv, "unreadCount", "unreadMessagesCount") ?? pick<number>(n, "unreadMessagesCount", "unreadCount");
  return {
    conversation_id: m.conversation_id,
    event_slug: m.event_slug,
    participants: m.counterpart ? [{ attendee_id: m.counterpart.attendee_id, user_id: m.counterpart.user_id, name: m.counterpart.name }] : [],
    meeting_id: m.meeting_id,
    meeting_status: m.status,
    last_message_at: str(pick(conv, "lastMessageAt", "latestMessage.createdAt", "updatedAt") ?? pick(n, "lastMessageAt", "updatedAt")),
    last_message_preview: str(pick(conv, "latestMessage.content", "lastMessage.content", "lastMessage")),
    unread_count: typeof unread === "number" ? unread : unread != null ? Number(unread) : null,
  };
}

export interface MessageModel {
  message_id: string;
  conversation_id: string;
  sender: { user_id: string | null; attendee_id: string | null; name: string | null; is_me: boolean };
  body: string | null;
  sent_at: string | null;
  is_meeting_proposal: boolean;
  proposed_meeting: { starts_at: string | null; ends_at: string | null; meeting_id: string | null } | null;
}

export function mapMessage(n: any, conversationId: string, me: MeContext): MessageModel {
  const user = n.user && typeof n.user === "object" ? n.user : n.sender && typeof n.sender === "object" ? n.sender : {};
  const userId = str(user.id ?? pick(n, "userId", "senderId"));
  const kind = String(pick(n, "messageType", "kind", "category") ?? "").toLowerCase();
  const meeting = n.meeting && typeof n.meeting === "object" ? n.meeting : null;
  const proposal = /meeting|suggest|resched/.test(kind) || !!meeting;
  return {
    message_id: String(n.id ?? n.uuid),
    conversation_id: conversationId,
    sender: { user_id: userId, attendee_id: str(pick(n, "attendeeId", "attendee.id")), name: fullName(user), is_me: !!me.userId && userId === me.userId },
    body: str(pick(n, "content", "body", "text", "message")),
    sent_at: str(pick(n, "createdAt", "sentAt")),
    is_meeting_proposal: proposal,
    proposed_meeting: proposal
      ? {
          starts_at: str(pick(meeting, "timeslot.startTime", "startTime")),
          ends_at: str(pick(meeting, "timeslot.endTime", "endTime")),
          meeting_id: str(meeting?.id ?? pick(n, "meetingId")),
        }
      : null,
  };
}

// ---------- notifications ----------

export type NotificationType =
  | "meeting_request_received"
  | "meeting_accepted"
  | "meeting_declined"
  | "meeting_cancelled"
  | "meeting_rescheduled"
  | "chat_message"
  | "session_reminder"
  | "other";

export function mapNotificationType(raw: string | null): NotificationType {
  const t = (raw ?? "").toLowerCase();
  if (!t) return "other";
  if (/resched/.test(t)) return "meeting_rescheduled";
  if (/cancel/.test(t)) return "meeting_cancelled";
  if (/(reject|declin)/.test(t)) return "meeting_declined";
  if (/accept|confirm/.test(t)) return "meeting_accepted";
  if (/meeting|request|invite/.test(t)) return "meeting_request_received";
  if (/chat|message/.test(t)) return "chat_message";
  if (/timeslot|session|reminder|schedule|bookmark/.test(t)) return "session_reminder";
  return "other";
}

export interface NotificationModel {
  notification_id: string;
  type: NotificationType;
  raw_type: string | null;
  title: string | null;
  body: string | null;
  meeting_id: string | null;
  conversation_id: string | null;
  attendee_id: string | null;
  created_at: string | null;
  is_read: boolean | null;
}

export function mapNotification(n: any): NotificationModel {
  const data = (n.data && typeof n.data === "object" ? n.data : n.payload && typeof n.payload === "object" ? n.payload : {}) as any;
  const rawType = str(pick(n, "notificationType", "kind", "category", "action") ?? pick(data, "type", "notificationType"));
  return {
    notification_id: String(n.id),
    type: mapNotificationType(rawType ?? str(n.title)),
    raw_type: rawType,
    title: str(pick(n, "title", "heading", "subject")),
    body: str(pick(n, "body", "message", "content", "text")),
    meeting_id: str(pick(n, "meetingId", "meeting.id") ?? pick(data, "meetingId", "meeting_id")),
    conversation_id: str(pick(n, "chatConversationId", "chatConversation.id") ?? pick(data, "chatConversationId", "chat_conversation_id")),
    attendee_id: str(pick(n, "attendeeId", "senderAttendeeId", "attendee.id") ?? pick(data, "attendeeId", "attendee_id")),
    created_at: str(pick(n, "createdAt", "sentAt")),
    is_read: typeof n.isRead === "boolean" ? n.isRead : typeof n.read === "boolean" ? n.read : n.readAt !== undefined ? n.readAt != null : null,
  };
}

// ---------- slots ----------

export interface SlotModel {
  timeslot_id: string;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  is_blocked_by_me: boolean;
  is_blocked_by_them?: boolean;
}

export function mapSlot(n: any, tz: string | null, blockedByThem?: boolean): SlotModel {
  const blockedMe = n.blocked === true || n.isBlocked === true || n.available === false || n.isAvailable === false || n.hasMeeting === true;
  return {
    timeslot_id: String(n.id),
    starts_at: str(pick(n, "startTime", "startsAt")),
    ends_at: str(pick(n, "endTime", "endsAt")),
    timezone: tz,
    is_blocked_by_me: blockedMe,
    ...(blockedByThem === undefined ? {} : { is_blocked_by_them: blockedByThem }),
  };
}

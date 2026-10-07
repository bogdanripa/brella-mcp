/**
 * Upstream route table, pinned from the official web app bundle
 * (next.brella.io, Expo web build fetched 2026-10-07; see docs/upstream-contract.md).
 * Paths are relative to the API base (https://api.brella.io/api).
 */
const e = encodeURIComponent;

export const routes = {
  // --- setup-only auth (never wrapped by an MCP tool) ---
  requestCode: () => `/one_click_links`, // POST {hcaptcha_token?, one_click_link:{email}}
  verifyCode: () => `/one_click_links/sign_in`, // POST {token, email}
  signOut: () => `/auth/sign_out`, // DELETE
  meUser: () => `/me/user`, // GET (session validation)

  // --- events & profile ---
  meEvents: () => `/me/events`,
  event: (slug: string) => `/events/${e(slug)}`,
  meAttendee: (slug: string) => `/me/events/${e(slug)}/me_attendee`,
  interests: (slug: string) => `/events/${e(slug)}/interests`,
  attendeeInterests: (slug: string) => `/me/events/${e(slug)}/attendee_interests`,
  search: (slug: string) => `/me/events/${e(slug)}/search`,

  // --- agenda ---
  schedule: (slug: string) => `/me/events/${e(slug)}/schedule`, // ?date=all&include_pending=true&bookmarks=true
  timeslot: (slug: string, id: string) => `/events/${e(slug)}/timeslots/${e(id)}`,
  timeslotBookmarks: (slug: string) => `/me/events/${e(slug)}/timeslot_bookmarks`, // GET; POST ?timeslot_id=
  timeslotBookmark: (slug: string, bookmarkId: string) => `/me/events/${e(slug)}/timeslot_bookmarks/${e(bookmarkId)}`, // DELETE

  // --- meetings ---
  meetings: () => `/me/meetings`, // GET ?event_id=&status=; POST {meeting:{user_id,event_id,timeslot_id,message}} = suggest
  meeting: (id: string) => `/me/meetings/${e(id)}`,
  meetingAction: (id: string, action: "accept" | "reject" | "cancel" | "reschedule" | "poke") => `/me/meetings/${e(id)}/${action}`, // PATCH
  startChat: () => `/me/meetings/start_chat`, // POST {meeting:{user_id,event_id,message}}
  networkingAvailability: (slug: string, date?: string) =>
    `/me/events/${e(slug)}/meetings/networking_availability${date ? `/${e(date)}` : ""}`,
  suggestedTimeslots: (slug: string, attendeeId: string) => `/events/${e(slug)}/attendees/${e(attendeeId)}/timeslots/suggested`,

  // --- attendees ---
  attendees: (slug: string) => `/events/${e(slug)}/attendees`, // GET ?search=; POST {interest_ids,page}
  attendee: (slug: string, id: string) => `/events/${e(slug)}/attendees/${e(id)}`,

  // --- chat ---
  chatMessages: (conversationId: string) => `/me/chat_conversations/${e(conversationId)}/chat_messages`,
  oneTimeToken: () => `/me/one_time_tokens`, // POST → websocket ott

  // --- activity ---
  notificationHistory: (slug: string) => `/me/events/${e(slug)}/notifications/history`,
} as const;

/** AnyCable channel used by the web app to send chat messages. */
export const CHAT_CHANNEL = "Api::Latest::Me::ChatConversationsChannel";

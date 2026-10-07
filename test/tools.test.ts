import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOKMARKS_EMPTY, BOOKMARKS_ONE, EVENT, INTERESTS, ME_ATTENDEE, ME_USER, meeting, meetingIncluded, SCHEDULE } from "./fixtures/upstream.js";
import { on, setup } from "./helpers.js";

const base = [
  on("GET", "/me/user", ME_USER),
  on("GET", "/events/HTW2026", EVENT),
  on("GET", "/me/events/HTW2026/me_attendee", ME_ATTENDEE),
  on("GET", "/events/HTW2026/interests", INTERESTS),
  on("GET", "/me/events/HTW2026/schedule", SCHEDULE),
];

test("tools/list exposes the §7 catalog and no sign-in tools", async () => {
  const { client } = await setup([]);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "brella_accept_meeting_request",
    "brella_bookmark_session",
    "brella_cancel_meeting",
    "brella_decline_meeting_request",
    "brella_find_attendees_by_interest",
    "brella_get_attendee",
    "brella_get_conversation_messages",
    "brella_get_event",
    "brella_get_interest_catalog",
    "brella_get_meeting_request",
    "brella_get_my_agenda",
    "brella_get_my_profile",
    "brella_get_networking_summary",
    "brella_get_session",
    "brella_list_accounts",
    "brella_list_attendees",
    "brella_list_available_meeting_slots",
    "brella_list_conversations",
    "brella_list_meeting_requests",
    "brella_list_my_events",
    "brella_list_notifications",
    "brella_list_sessions",
    "brella_propose_meeting",
    "brella_propose_reschedule",
    "brella_search_event",
    "brella_send_chat_message",
    "brella_start_chat",
    "brella_unbookmark_session",
  ]);
  for (const t of (await client.listTools()).tools) {
    assert.doesNotMatch(t.name, /sign|login|code|auth|token|password/);
    const props = Object.keys((t.inputSchema as any).properties ?? {});
    for (const p of props) assert.doesNotMatch(p, /code|token|password|cookie|credential/, `${t.name}.${p}`);
  }
});

test("401 maps to SETUP_REQUIRED and nothing is cleared", async () => {
  const { call, store } = await setup([on("GET", "/events/HTW2026", { errors: [{ title: "unauthorized" }] }, { status: 401 })]);
  const r = await call("brella_get_event", { event: "HTW2026" });
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, "SETUP_REQUIRED");
  assert.equal(r.data.meta.account, "body@genez.io");
  assert.ok(store.sessions.get("body@genez.io"));
  assert.doesNotMatch(JSON.stringify(r.data), /tok-1/);
});

test("missing session → SETUP_REQUIRED; unknown account → ACCOUNT_NOT_FOUND", async () => {
  const { call } = await setup(base, { session: false });
  assert.equal((await call("brella_get_event", { event: "HTW2026" })).data.error.code, "SETUP_REQUIRED");
  assert.equal((await call("brella_get_event", { event: "HTW2026", account: "nobody" })).data.error.code, "ACCOUNT_NOT_FOUND");
});

test("rotated access-token is persisted; auth headers are sent", async () => {
  const { call, store, calls } = await setup([on("GET", "/events/HTW2026", EVENT, { headers: { "access-token": "tok-2", client: "cli", uid: "body@genez.io" } })]);
  const r = await call("brella_get_event", { event: "https://next.brella.io/events/HTW2026/home", account: "work" });
  assert.equal(r.isError, false);
  assert.equal(r.data.event.slug, "HTW2026");
  assert.equal(r.data.event.timezone, "Europe/Bucharest");
  assert.equal(store.sessions.get("body@genez.io")!["access-token"], "tok-2");
  assert.equal(calls[0].headers["access-token"], "tok-1");
  assert.equal(calls[0].headers.accept, "application/vnd.brella.v4+json");
});

test("GETs retry on 503; writes are never retried", async () => {
  let n = 0;
  const flaky = (c: any) => (c.method === "GET" && c.path === "/events/HTW2026" ? (++n < 2 ? { status: 503, body: {} } : { body: EVENT }) : undefined);
  const { call } = await setup([flaky]);
  const r = await call("brella_get_event", { event: "HTW2026" });
  assert.equal(r.isError, false);
  assert.equal(n, 2);

  let posts = 0;
  const { call: call2 } = await setup([
    ...base,
    on("GET", "/me/events/HTW2026/timeslot_bookmarks", BOOKMARKS_EMPTY),
    on("GET", "/events/HTW2026/timeslots/12345", { data: SCHEDULE.included[0] }),
    (c) => (c.method === "POST" && c.path === "/me/events/HTW2026/timeslot_bookmarks" ? (posts++, { status: 502, body: {} }) : undefined),
  ]);
  const w = await call2("brella_bookmark_session", { event: "HTW2026", session_id: "12345" });
  assert.equal(w.isError, true);
  assert.equal(posts, 1);
});

test("sessions: list + day filter + bookmark idempotency", async () => {
  const { call, calls } = await setup([...base, on("GET", "/me/events/HTW2026/timeslot_bookmarks", BOOKMARKS_ONE), on("GET", "/events/HTW2026/timeslots/12345", { data: SCHEDULE.included[0], included: SCHEDULE.included.slice(2) })]);
  const list = await call("brella_list_sessions", { event: "HTW2026", day: "2026-10-07" });
  assert.equal(list.data.sessions.length, 2);
  const s = list.data.sessions[0];
  assert.equal(s.title, "Product Strategy When Anyone Can Ship");
  assert.equal(s.stage, "Build & Grow Stage");
  assert.equal(s.speakers[0].company, "Spotify");
  assert.equal(s.is_bookmarked, true);
  const b = await call("brella_bookmark_session", { event: "HTW2026", session_id: "12345" });
  assert.equal(b.data.already_applied, true);
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("unbookmark deletes by bookmark id", async () => {
  const { call, calls } = await setup([...base, on("GET", "/me/events/HTW2026/timeslot_bookmarks", BOOKMARKS_ONE), on("DELETE", "/me/events/HTW2026/timeslot_bookmarks/b1", {})]);
  const r = await call("brella_unbookmark_session", { event: "HTW2026", session_id: "12345" });
  assert.equal(r.data.already_applied, false);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/me/events/HTW2026/timeslot_bookmarks/b1"));
});

test("meetings: list incoming pending, accept, decline with note, agenda overlaps", async () => {
  let status = "pending";
  const meetingsList = () => ({ data: [meeting("7156539", status)], included: meetingIncluded("7156539"), meta: { "total-pages": 1 } });
  const routes = [
    ...base,
    on("GET", "/me/events/HTW2026/timeslot_bookmarks", BOOKMARKS_ONE),
    (c: any) => (c.method === "GET" && c.path === "/me/meetings" ? { body: meetingsList() } : undefined),
    (c: any) => (c.method === "GET" && c.path === "/me/meetings/7156539" ? { body: { data: meeting("7156539", status), included: meetingIncluded("7156539") } } : undefined),
    (c: any) => (c.method === "PATCH" && c.path === "/me/meetings/7156539/accept" ? ((status = "accepted"), { body: {} }) : undefined),
    (c: any) => (c.method === "PATCH" && c.path === "/me/meetings/7156539/reject" ? ((status = "rejected"), { body: {} }) : undefined),
  ];
  const { call, calls } = await setup(routes);

  const list = await call("brella_list_meeting_requests", { event: "HTW2026", status: "pending", direction: "incoming" });
  assert.equal(list.data.meetings.length, 1);
  const m = list.data.meetings[0];
  assert.equal(m.direction, "incoming");
  assert.equal(m.counterpart.name, "Zein Darwesh");
  assert.equal(m.conversation_id, "c-7156539");
  assert.equal(m.timezone, "Europe/Bucharest");

  const acc = await call("brella_accept_meeting_request", { meeting_id: "7156539" });
  assert.equal(acc.isError, false);
  assert.equal(acc.data.meeting.status, "accepted");
  const again = await call("brella_accept_meeting_request", { meeting_id: "7156539" });
  assert.equal(again.data.already_applied, true);

  // accepted meeting 10:45–11:00Z does not overlap sessions; the two sessions overlap each other
  const agenda = await call("brella_get_my_agenda", { event: "HTW2026" });
  assert.equal(agenda.data.items.length, 2);
  assert.deepEqual(agenda.data.overlaps, []);

  status = "pending";
  const dec = await call("brella_decline_meeting_request", { meeting_id: "7156539", note: "Please resend for 13:45" });
  assert.equal(dec.data.note_delivery, "decline_payload");
  const patch = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/reject"))!;
  assert.deepEqual(patch.body, { meeting: { message: "Please resend for 13:45", freeze_chat: false } });

  const bad = await call("brella_accept_meeting_request", { meeting_id: "7156539" });
  assert.equal(bad.data.error.code, "MEETING_STATE_CHANGED");
});

test("propose_meeting resolves the slot and sends the web app's body", async () => {
  const routes = [
    ...base,
    on("GET", "/me/meetings", { data: [] }),
    on("GET", "/events/HTW2026/attendees/654", { data: { id: "654", type: "attendee", attributes: { "first-name": "Dan", "user-id": 6540 } } }),
    on("GET", "/events/HTW2026/attendees/654/timeslots/suggested", {
      data: [{ id: "88", type: "timeslot", attributes: { "start-time": "2026-10-07T10:45:00.000Z", "end-time": "2026-10-07T11:00:00.000Z" } }],
    }),
    on("POST", "/me/meetings", { data: meeting("9", "pending", { sender: "501", receiver: "6540" }), included: meetingIncluded("9") }),
  ];
  const { call, calls } = await setup(routes);
  const missing = await call("brella_propose_meeting", { event: "HTW2026", attendee_id: "654", starts_at: "2026-10-07T09:00:00+03:00" });
  assert.equal(missing.data.error.code, "SLOT_UNAVAILABLE");
  assert.deepEqual(missing.data.error.available_starts, ["2026-10-07T10:45:00.000Z"]);

  const r = await call("brella_propose_meeting", { event: "HTW2026", attendee_id: "654", starts_at: "2026-10-07T13:45:00+03:00", note: "Hi Dan" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.meeting.direction, "outgoing");
  const post = calls.find((c) => c.method === "POST" && c.path === "/me/meetings")!;
  assert.deepEqual(post.body, { meeting: { user_id: 6540, event_id: 9001, message: "Hi Dan", timeslot_id: 88 } });
});

test("conversations derive from meetings; messages are chronological", async () => {
  const routes = [
    ...base,
    on("GET", "/me/meetings", { data: [meeting("1", "accepted")], included: meetingIncluded("1", undefined, undefined, 2) }),
    on("GET", "/me/chat_conversations/c-1/chat_messages", {
      data: [
        { id: "m2", type: "chat-message", attributes: { content: "13:45 works", "created-at": "2026-10-07T05:52:00Z" }, relationships: { user: { data: { id: "654", type: "user" } } } },
        { id: "m1", type: "chat-message", attributes: { content: "Hi!", "created-at": "2026-10-07T05:50:00Z" }, relationships: { user: { data: { id: "501", type: "user" } } } },
      ],
    }),
  ];
  const { call } = await setup(routes);
  const convs = await call("brella_list_conversations", { event: "HTW2026", unread_only: true });
  assert.equal(convs.data.conversations.length, 1);
  assert.equal(convs.data.conversations[0].unread_count, 2);
  const msgs = await call("brella_get_conversation_messages", { conversation_id: "c-1" });
  assert.deepEqual(msgs.data.messages.map((m: any) => m.message_id), ["m1", "m2"]);
  assert.equal(msgs.data.messages[0].sender.is_me, true);
  const foreign = await call("brella_get_conversation_messages", { conversation_id: "zzz" });
  assert.equal(foreign.data.error.code, "CONVERSATION_NOT_FOUND");
});

test("find attendees by interest posts interest ids and reports matches", async () => {
  const routes = [
    ...base,
    on("POST", "/events/HTW2026/attendees", {
      data: [
        {
          id: "42",
          type: "attendee",
          attributes: { "first-name": "Valentin", "last-name": "Radu", "company-name": "Omniconvert" },
          relationships: { "selected-interests": { data: [{ id: "x", type: "selected-interest" }] } },
        },
      ],
      included: [{ id: "x", type: "selected-interest", relationships: { interest: { data: { id: "31", type: "interest" } } } }],
      meta: { "total-pages": 1, "total-count": 1 },
    }),
  ];
  const { call, calls } = await setup(routes);
  const r = await call("brella_find_attendees_by_interest", { event: "HTW2026", interests: ["ai search", "Underwater basket weaving"] });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(r.data.matched_interests, { "42": ["AI search"] });
  assert.deepEqual(r.data.unknown_interests, ["Underwater basket weaving"]);
  assert.deepEqual(calls.find((c) => c.method === "POST")!.body.interest_ids, [31]);
});

test("list_accounts returns metadata only", async () => {
  const { call } = await setup([], {
    accounts: [
      { email: "body@genez.io", alias: "work", is_default: true, created_at: "x" },
      { email: "bogdanripa@gmail.com", alias: "personal", is_default: false, created_at: "x" },
    ],
  });
  const r = await call("brella_list_accounts");
  assert.equal(r.data.accounts.length, 2);
  assert.equal(r.data.accounts[0].setup_required, false);
  assert.doesNotMatch(JSON.stringify(r.data), /tok-1|cli/);
});

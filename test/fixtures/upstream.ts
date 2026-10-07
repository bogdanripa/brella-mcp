/**
 * SYNTHETIC fixtures shaped like Brella's v4 JSON:API (dasherized keys,
 * relationships + included). Route paths are pinned from the web app bundle;
 * attribute names follow public scrapers and the web app's own field usage.
 * Replace with redacted captures when available (spec §10).
 */

export const ME_USER = { data: { id: "501", type: "user", attributes: { "first-name": "Bogdan", "last-name": "Ripa", email: "body@genez.io" } } };

export const EVENT = {
  data: {
    id: "9001",
    type: "event",
    attributes: {
      slug: "HTW2026",
      name: "How to Web Conference 2026",
      "start-time": "2026-10-06T00:00:00+03:00",
      "end-time": "2026-10-08T23:59:59+03:00",
      "time-zone": "Europe/Bucharest",
      "venue-name": "Face Convention Center",
      address: "Piața Presei Libere 3–5",
      city: "Bucharest",
      "event-type": "physical",
    },
  },
};

export const ME_ATTENDEE = {
  data: {
    id: "777",
    type: "attendee",
    attributes: { "first-name": "Bogdan", "last-name": "Ripa", "company-title": "CEO", "company-name": "Genezio", "user-id": 501 },
    relationships: { "selected-interests": { data: [{ id: "s1", type: "selected-interest" }] } },
  },
  included: [{ id: "s1", type: "selected-interest", attributes: {}, relationships: { interest: { data: { id: "31", type: "interest" } } } }],
};

export const INTERESTS = {
  data: [{ id: "30", type: "interest", attributes: { name: "Growth" }, relationships: { children: { data: [{ id: "31", type: "interest" }, { id: "32", type: "interest" }] } } }],
  included: [
    { id: "31", type: "interest", attributes: { name: "AI search" } },
    { id: "32", type: "interest", attributes: { name: "Product Strategy" } },
  ],
};

export const SCHEDULE = {
  data: {
    id: "sched",
    type: "schedule",
    attributes: {},
    relationships: { timeslots: { data: [{ id: "12345", type: "timeslot" }, { id: "12346", type: "timeslot" }] } },
  },
  included: [
    {
      id: "12345",
      type: "timeslot",
      attributes: { title: "Product Strategy When Anyone Can Ship", "start-time": "2026-10-07T09:40:00.000Z", "end-time": "2026-10-07T10:00:00.000Z" },
      relationships: { stage: { data: { id: "st1", type: "stage" } }, speakers: { data: [{ id: "sp1", type: "speaker" }] } },
    },
    {
      id: "12346",
      type: "timeslot",
      attributes: { title: "Growth Loops", "start-time": "2026-10-07T09:50:00.000Z", "end-time": "2026-10-07T10:20:00.000Z" },
      relationships: { stage: { data: { id: "st2", type: "stage" } } },
    },
    { id: "st1", type: "stage", attributes: { name: "Build & Grow Stage" } },
    { id: "st2", type: "stage", attributes: { name: "Main Stage" } },
    { id: "sp1", type: "speaker", attributes: { "first-name": "Avinav", "last-name": "Pashine", "company-title": "Head of Product Management", "company-name": "Spotify" } },
  ],
};

export const BOOKMARKS_EMPTY = { data: [] };
export const BOOKMARKS_ONE = {
  data: [{ id: "b1", type: "timeslot-bookmark", attributes: {}, relationships: { timeslot: { data: { id: "12345", type: "timeslot" } } } }],
};

export function meeting(id: string, status: string, opts: { sender?: string; receiver?: string; start?: string; conv?: string; counterpart?: string } = {}) {
  return {
    id,
    type: "meeting",
    attributes: { status, "created-at": "2026-10-07T05:50:00Z", "updated-at": "2026-10-07T05:52:00Z", message: "Let's meet" },
    relationships: {
      sender: { data: { id: opts.sender ?? "654", type: "user" } },
      receiver: { data: { id: opts.receiver ?? "501", type: "user" } },
      timeslot: { data: { id: `ts-${id}`, type: "timeslot" } },
      "chat-conversation": { data: { id: opts.conv ?? `c-${id}`, type: "chat-conversation" } },
      "other-attendee": { data: { id: opts.counterpart ?? "654", type: "attendee" } },
      event: { data: { id: "9001", type: "event" } },
    },
  };
}

export function meetingIncluded(id: string, start = "2026-10-07T10:45:00.000Z", end = "2026-10-07T11:00:00.000Z", unread = 1) {
  return [
    { id: `ts-${id}`, type: "timeslot", attributes: { "start-time": start, "end-time": end } },
    { id: `c-${id}`, type: "chat-conversation", attributes: { "unread-count": unread, "last-message-at": "2026-10-07T05:52:00Z" } },
    { id: "654", type: "attendee", attributes: { "first-name": "Zein", "last-name": "Darwesh", "company-name": "Endeavor Romania", "user-id": 654 } },
    { id: "9001", type: "event", attributes: { slug: "HTW2026" } },
  ];
}

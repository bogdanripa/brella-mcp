import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deserialize } from "../src/brella/jsonapi.js";
import { eventStatus, mapMeetingStatus, mapNotificationType, parseEventSlug } from "../src/brella/mappers.js";
import { loadConfig } from "../src/config.js";
import { redact, SetupError } from "../src/errors.js";
import { SecretBox } from "../src/store/crypto.js";
import { FileStore } from "../src/store/file.js";
import { ATTEMPT_TTL_MS, MAX_CODE_TRIES, SetupFlow } from "../src/setup/flow.js";
import { MemoryStore } from "./helpers.js";

test("jsonapi: camelCases, inlines included, survives cycles", () => {
  const doc = deserialize({
    data: [{ id: 1, type: "meetings", attributes: { "start-time": "x" }, relationships: { "other-user": { data: { id: "2", type: "users" } } } }],
    included: [{ id: "2", type: "users", attributes: { first_name: "A" }, relationships: { meeting: { data: { id: "1", type: "meetings" } } } }],
    meta: { "total-pages": 3 },
  });
  assert.equal(doc.data[0].type, "meeting");
  assert.equal(doc.data[0].startTime, "x");
  assert.equal(doc.data[0].otherUser.firstName, "A");
  assert.equal(doc.data[0].otherUser.meeting.id, "1");
  assert.equal(doc.meta.totalPages, 3);
});

test("status maps are total with raw fallback", () => {
  assert.equal(mapMeetingStatus("rejected"), "declined");
  assert.equal(mapMeetingStatus("canceled"), "cancelled");
  assert.equal(mapMeetingStatus("weird"), "unknown");
  assert.equal(mapNotificationType("meeting_request"), "meeting_request_received");
  assert.equal(mapNotificationType("meeting_rejected"), "meeting_declined");
  assert.equal(mapNotificationType("new_chat_message"), "chat_message");
});

test("event slug + status", () => {
  assert.equal(parseEventSlug("https://next.brella.io/events/HTW2026/home"), "HTW2026");
  assert.equal(parseEventSlug(" HTW2026 "), "HTW2026");
  const now = new Date("2026-10-07T10:00:00Z");
  assert.equal(eventStatus("2026-10-06", "2026-10-08", now), "ongoing");
  assert.equal(eventStatus("2026-10-06", "2026-10-07", now), "ongoing");
  assert.equal(eventStatus("2025-10-06", "2025-10-08", now), "past");
  assert.equal(eventStatus("2027-01-01", null, now), "upcoming");
});

test("redaction strips credentials", () => {
  const out = redact('access-token: abc123 client="xyz" code=123456');
  assert.doesNotMatch(out, /abc123|xyz|123456/);
});

test("file store: encrypted at rest, 0600", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bmcp-"));
  const file = path.join(dir, "store.json");
  const store = new FileStore(file, new SecretBox("correct horse battery staple"));
  await store.init();
  await store.upsertAccount({ email: "A@x.io", is_default: false, created_at: "t" });
  await store.putSession("a@x.io", { "access-token": "SECRET-TOKEN", updated_at: "t" });
  assert.equal((await store.getSession("a@x.io"))!["access-token"], "SECRET-TOKEN");
  assert.doesNotMatch(readFileSync(file, "utf8"), /SECRET-TOKEN/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await store.listAccounts())[0].is_default, true);
  await store.removeAccount("a@x.io");
  assert.equal(await store.getSession("a@x.io"), null);
});

function flowWith(api: Partial<ConstructorParameters<typeof SetupFlow>[3]> = {}) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const verifyCalls: string[] = [];
  const flow = new SetupFlow(loadConfig({}), store, () => now, {
    requestCode: async () => ({ sent: false, reason: "captcha_required", status: 422 }) as const,
    verifyCode: async (_c: any, _e: string, code: string) => {
      verifyCalls.push(code);
      if (code !== "123456") throw new SetupError("INVALID_CODE", "bad");
      return { session: { "access-token": "t", client: "c", uid: "u", updated_at: "x" }, user: { id: "501", name: "B" } };
    },
    validateSession: async () => ({ id: "501", name: "Bogdan" }),
    signOut: async () => ({ ok: true, status: 200 }),
    ...api,
  } as any);
  (flow as any).listEvents = async () => [{ slug: "HTW2026", name: "HTW", status: "ongoing" }];
  return { flow, store, advance: (ms: number) => (now += ms), verifyCalls };
}

test("setup: captcha fallback, verify stores session + metadata only", async () => {
  const { flow, store } = flowWith();
  const s = await flow.start("Body@Genez.io", { alias: "work", makeDefault: true });
  assert.equal(s.manual_request_needed, true);
  assert.match(s.instructions, /next\.brella\.io\/login/);
  const ready = await flow.verify(s.attempt_id, "123456");
  assert.equal(ready.email, "body@genez.io");
  assert.equal(ready.is_default, true);
  assert.equal(ready.events[0].slug, "HTW2026");
  assert.equal(store.sessions.get("body@genez.io")!["access-token"], "t");
  assert.doesNotMatch(JSON.stringify(store.accounts), /123456|"t"/);
  await assert.rejects(flow.verify(s.attempt_id, "123456"), { code: "SETUP_ATTEMPT_NOT_FOUND" });
});

test("setup: attempt limit, expiry, and new attempt invalidates old", async () => {
  const { flow, advance } = flowWith();
  const s = await flow.start("a@b.io");
  for (let i = 0; i < MAX_CODE_TRIES; i++) await assert.rejects(flow.verify(s.attempt_id, "000000"), { code: "INVALID_CODE" });
  await assert.rejects(flow.verify(s.attempt_id, "123456"), { code: "TOO_MANY_ATTEMPTS" });

  const s2 = await flow.start("a@b.io");
  advance(ATTEMPT_TTL_MS + 1);
  await assert.rejects(flow.verify(s2.attempt_id, "123456"), { code: "SETUP_ATTEMPT_EXPIRED" });

  const s3 = await flow.start("a@b.io");
  const s4 = await flow.start("a@b.io");
  await assert.rejects(flow.verify(s3.attempt_id, "123456"), { code: "SETUP_ATTEMPT_NOT_FOUND" });
  assert.equal((await flow.verify(s4.attempt_id, "123456")).email, "a@b.io");
});

test("setup: remove reports upstream and local outcomes separately", async () => {
  const { flow, store } = flowWith({ signOut: async () => ({ ok: false, status: 500 }) } as any);
  const s = await flow.start("a@b.io");
  await flow.verify(s.attempt_id, "123456");
  const r = await flow.remove("a@b.io");
  assert.equal(r.upstream_sign_out, "failed (500)");
  assert.equal(r.local_removed, true);
  assert.equal(store.accounts.length, 0);
});

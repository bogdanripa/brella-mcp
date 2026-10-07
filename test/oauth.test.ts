import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SetupError } from "../src/errors.js";
import { SetupFlow } from "../src/setup/flow.js";
import { EVENT, ME_USER } from "./fixtures/upstream.js";
import { fakeFetch, MemoryStore, on } from "./helpers.js";

async function start() {
  const store = new MemoryStore();
  const cfg = { ...loadConfig({}), requestsPerSecond: 1000 };
  const requested: string[] = [];
  const flow = new SetupFlow(cfg, store, Date.now, {
    passwordSignIn: async (_c: any, email: string, pw: string) => {
      requested.push(email);
      if (pw !== "hunter2-test") throw new SetupError("INVALID_CREDENTIALS", "Wrong email or password");
      return { session: { "access-token": "brella-pw-tok", client: "c", uid: "u", updated_at: "x" }, user: { id: "777", name: "P" } };
    },
    verifyCode: async (_c: any, _e: string, code: string) => {
      if (code !== "ABC123") throw new SetupError("INVALID_CODE", "The code is invalid or expired");
      return { session: { "access-token": "brella-tok", client: "c", uid: "u", updated_at: "x" }, user: { id: "501", name: "B" } };
    },
    validateSession: async () => ({ id: "501", name: "Bogdan" }),
    signOut: async () => ({ ok: true, status: 200 }),
  } as any);
  (flow as any).listEvents = async () => [];
  const fetchImpl = fakeFetch([on("GET", "/me/user", ME_USER), on("GET", "/events/HTW2026", EVENT)]);
  // Listen first so the issuer URL matches the real port.
  const holder: { url?: URL } = {};
  const http = await import("node:http");
  const srv = http.createServer((req, res) => app(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  holder.url = new URL(`http://localhost:${(srv.address() as AddressInfo).port}`);
  const app = createApp({ cfg, store, publicUrl: holder.url, staticToken: "static-admin-token-0123456789", fetchImpl, flow });
  return { store, base: holder.url.origin, requested, close: () => srv.close() };
}

const mcpInit = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

test("OAuth: discovery → register → authorize → /login → token → bound MCP access", async () => {
  const { base, store, requested, close } = await start();
  try {
    const home = await fetch(`${base}/`);
    assert.match(home.headers.get("content-type")!, /html/);
    assert.match(await home.text(), /github\.com\/bogdanripa\/brella-mcp/);
    assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);

    // Unauthenticated MCP call advertises the resource metadata.
    const r401 = await fetch(`${base}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify(mcpInit) });
    assert.equal(r401.status, 401);
    assert.match(r401.headers.get("www-authenticate")!, /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${base.replace("127.0.0.1", "localhost")}/mcp`);
    const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.ok(asm.registration_endpoint && asm.authorization_endpoint && asm.token_endpoint);

    // Dynamic client registration (what ChatGPT / Claude do).
    const reg = await (
      await fetch(asm.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/cb"], token_endpoint_auth_method: "none" }),
      })
    ).json();
    assert.ok(reg.client_id);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authUrl = new URL(asm.authorization_endpoint);
    Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://chatgpt.com/connector/oauth/cb", code_challenge: challenge, code_challenge_method: "S256", state: "st8", scope: "brella" }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
    const authRes = await fetch(authUrl, { redirect: "manual" });
    assert.equal(authRes.status, 302);
    const loginUrl = new URL(authRes.headers.get("location")!, base);
    assert.equal(loginUrl.pathname, "/login");
    const req = loginUrl.searchParams.get("req")!;
    const html = await (await fetch(new URL(loginUrl.pathname + loginUrl.search, base))).text();
    assert.match(html, /ChatGPT/);

    const post = (p: string, b: object) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ req, ...b }) });
    const s1 = await (await post("/login/email", { email: "Body@Genez.io" })).json();
    assert.equal(s1.email, "body@genez.io");
    assert.equal(s1.brella_login_url, "https://next.brella.io/login");
    const bad = await post("/login/verify", { code: "WRONG1" });
    assert.equal(bad.status, 400);
    const ok = await (await post("/login/verify", { code: "ABC123" })).json();
    const back = new URL(ok.redirect);
    assert.equal(back.origin + back.pathname, "https://chatgpt.com/connector/oauth/cb");
    assert.equal(back.searchParams.get("state"), "st8");

    const tok = await (
      await fetch(asm.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "https://chatgpt.com/connector/oauth/cb" }),
      })
    ).json();
    assert.ok(tok.access_token && tok.refresh_token, JSON.stringify(tok));
    assert.equal(store.sessions.get("body@genez.io")!["access-token"], "brella-tok");

    // Another account exists in the store but is invisible to this token.
    store.accounts.push({ email: "other@x.io", is_default: false, created_at: "x" });
    const call = (name: string, args = {}) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...mcpHeaders, authorization: `Bearer ${tok.access_token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
      });
    const accts = await (await call("brella_list_accounts")).json();
    const listed = JSON.parse(accts.result.content[0].text).accounts.map((a: any) => a.email);
    assert.deepEqual(listed, ["body@genez.io"]);
    const ev = await (await call("brella_get_event", { event: "HTW2026" })).json();
    assert.equal(JSON.parse(ev.result.content[0].text).event.slug, "HTW2026");
    const denied = await (await call("brella_get_event", { event: "HTW2026", account: "other@x.io" })).json();
    assert.equal(JSON.parse(denied.result.content[0].text).error.code, "ACCOUNT_NOT_FOUND");

    // Refresh rotates.
    const ref = await (
      await fetch(asm.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }),
      })
    ).json();
    assert.ok(ref.access_token && ref.access_token !== tok.access_token);

    // A dead Brella session turns the token into a 401 so the client re-runs login.
    store.sessions.set("body@genez.io", { ...store.sessions.get("body@genez.io")!, invalid_at: "now" });
    assert.equal((await call("brella_list_accounts")).status, 401);

    // Static admin token still works.
    const admin = await fetch(`${base}/mcp/static-admin-token-0123456789`, { method: "POST", headers: mcpHeaders, body: JSON.stringify(mcpInit) });
    assert.equal(admin.status, 200);
  } finally {
    close();
  }
});

test("OAuth: optional password sign-in completes authorization; wrong password is counted", async () => {
  const { base, store, requested, close } = await start();
  try {
    const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    const reg = await (
      await fetch(asm.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" }),
      })
    ).json();
    const verifier = randomBytes(32).toString("base64url");
    const authUrl = new URL(asm.authorization_endpoint);
    Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
    const req = new URL((await fetch(authUrl, { redirect: "manual" })).headers.get("location")!, base).searchParams.get("req")!;
    const post = (b: object) => fetch(`${base}/login/password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ req, ...b }) });
    const bad = await post({ email: "pw@x.io", password: "nope" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "INVALID_CREDENTIALS");
    const ok = await (await post({ email: "PW@x.io", password: "hunter2-test" })).json();
    assert.ok(new URL(ok.redirect).searchParams.get("code"));
    assert.deepEqual(requested, ["pw@x.io", "pw@x.io"]);
    assert.equal(store.sessions.get("pw@x.io")!["access-token"], "brella-pw-tok");
    // The password itself is never persisted anywhere in the store.
    assert.doesNotMatch(JSON.stringify([...store.kv.values(), ...store.sessions.values(), store.accounts]), /hunter2/);
  } finally {
    close();
  }
});

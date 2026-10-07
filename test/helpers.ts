import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccountRegistry } from "../src/brella/service.js";
import { loadConfig } from "../src/config.js";
import type { AccountMeta, Store, StoredSession } from "../src/store/types.js";
import { buildServer } from "../src/tools/index.js";

export class MemoryStore implements Store {
  accounts: AccountMeta[] = [];
  sessions = new Map<string, StoredSession>();
  puts = 0;
  async init() {}
  async listAccounts() {
    return this.accounts.map((a) => ({ ...a }));
  }
  async upsertAccount(meta: AccountMeta) {
    if (meta.is_default) this.accounts.forEach((a) => (a.is_default = false));
    const i = this.accounts.findIndex((a) => a.email === meta.email);
    if (i >= 0) this.accounts[i] = meta;
    else this.accounts.push(meta);
    if (!this.accounts.some((a) => a.is_default) && this.accounts[0]) this.accounts[0].is_default = true;
  }
  async removeAccount(email: string) {
    this.accounts = this.accounts.filter((a) => a.email !== email);
    this.sessions.delete(email);
  }
  async setDefault(email: string) {
    this.accounts.forEach((a) => (a.is_default = a.email === email));
  }
  async getSession(email: string) {
    return this.sessions.get(email) ?? null;
  }
  async putSession(email: string, s: StoredSession) {
    this.puts++;
    this.sessions.set(email, s);
  }
  async deleteSession(email: string) {
    this.sessions.delete(email);
  }
  async close() {}
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  headers: Record<string, string>;
}

export type Route = (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** Fake upstream: routes are tried in order; unmatched → 404. */
export function fakeFetch(routes: Route[], calls: Call[] = []): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const call: Call = {
      method: init.method ?? "GET",
      path: url.pathname.replace(/^\/api/, ""),
      query: url.searchParams,
      body: init.body ? JSON.parse(init.body) : undefined,
      headers,
    };
    calls.push(call);
    for (const r of routes) {
      const out = r(call);
      if (out) {
        return new Response(out.body === undefined ? "" : JSON.stringify(out.body), {
          status: out.status ?? 200,
          headers: { "content-type": "application/json", ...(out.headers ?? {}) },
        });
      }
    }
    return new Response(JSON.stringify({ errors: [{ title: "Not found" }] }), { status: 404 });
  }) as typeof fetch;
}

export function on(method: string, path: string | RegExp, body: unknown, extra: { status?: number; headers?: Record<string, string> } = {}): Route {
  return (c) => {
    const pathOk = typeof path === "string" ? c.path === path : path.test(c.path);
    return c.method === method && pathOk ? { body, ...extra } : undefined;
  };
}

export async function setup(routes: Route[], opts: { accounts?: AccountMeta[]; session?: boolean } = {}) {
  const store = new MemoryStore();
  store.accounts = opts.accounts ?? [{ email: "body@genez.io", alias: "work", is_default: true, created_at: "2026-10-01T00:00:00Z" }];
  if (opts.session !== false) {
    for (const a of store.accounts) store.sessions.set(a.email, { "access-token": "tok-1", client: "cli", uid: a.email, updated_at: "x" });
  }
  const calls: Call[] = [];
  const cfg = { ...loadConfig({}), requestsPerSecond: 1000 };
  const registry = new AccountRegistry(store, cfg, fakeFetch(routes, calls));
  const server = buildServer({ registry });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
  };
  return { store, calls, client, call };
}

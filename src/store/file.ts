import { promises as fs } from "node:fs";
import path from "node:path";
import type { AccountMeta, Store, StoredSession } from "./types.js";

interface FileShape {
  accounts: AccountMeta[];
  sessions: Record<string, StoredSession>;
  kv: Record<string, { v: unknown; exp?: number }>;
}

/** Single JSON file (mode 0600), for local use. Writes are atomic and serialized. */
export class FileStore implements Store {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
  }

  private async read(): Promise<FileShape> {
    try {
      const p = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<FileShape>;
      return { accounts: p.accounts ?? [], sessions: p.sessions ?? {}, kv: p.kv ?? {} };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { accounts: [], sessions: {}, kv: {} };
      throw e;
    }
  }

  private async write(d: FileShape): Promise<void> {
    const now = Date.now();
    for (const [k, v] of Object.entries(d.kv)) if (v.exp && v.exp < now) delete d.kv[k];
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  private mutate(fn: (d: FileShape) => void): Promise<void> {
    const next = this.chain.then(async () => {
      const d = await this.read();
      fn(d);
      await this.write(d);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async listAccounts(): Promise<AccountMeta[]> {
    return (await this.read()).accounts;
  }

  upsertAccount(meta: AccountMeta): Promise<void> {
    return this.mutate((d) => {
      const key = meta.email.toLowerCase();
      if (meta.is_default) d.accounts.forEach((a) => (a.is_default = false));
      const i = d.accounts.findIndex((a) => a.email.toLowerCase() === key);
      if (i >= 0) d.accounts[i] = meta;
      else d.accounts.push(meta);
      if (!d.accounts.some((a) => a.is_default) && d.accounts[0]) d.accounts[0].is_default = true;
    });
  }

  removeAccount(email: string): Promise<void> {
    return this.mutate((d) => {
      const key = email.toLowerCase();
      d.accounts = d.accounts.filter((a) => a.email.toLowerCase() !== key);
      delete d.sessions[key];
      if (!d.accounts.some((a) => a.is_default) && d.accounts[0]) d.accounts[0].is_default = true;
    });
  }

  setDefault(email: string): Promise<void> {
    return this.mutate((d) => {
      const key = email.toLowerCase();
      d.accounts.forEach((a) => (a.is_default = a.email.toLowerCase() === key));
    });
  }

  async getSession(email: string): Promise<StoredSession | null> {
    return (await this.read()).sessions[email.toLowerCase()] ?? null;
  }

  putSession(email: string, session: StoredSession): Promise<void> {
    return this.mutate((d) => {
      d.sessions[email.toLowerCase()] = session;
    });
  }

  deleteSession(email: string): Promise<void> {
    return this.mutate((d) => {
      delete d.sessions[email.toLowerCase()];
    });
  }

  async kvGet<T>(ns: string, key: string): Promise<T | null> {
    const e = (await this.read()).kv[`${ns}:${key}`];
    if (!e || (e.exp && e.exp < Date.now())) return null;
    return e.v as T;
  }

  kvPut(ns: string, key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    return this.mutate((d) => {
      d.kv[`${ns}:${key}`] = { v: value, ...(ttlSeconds ? { exp: Date.now() + ttlSeconds * 1000 } : {}) };
    });
  }

  kvDelete(ns: string, key: string): Promise<void> {
    return this.mutate((d) => {
      delete d.kv[`${ns}:${key}`];
    });
  }

  async close(): Promise<void> {
    await this.chain;
  }
}

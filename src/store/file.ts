import { promises as fs } from "node:fs";
import path from "node:path";
import { SecretBox } from "./crypto.js";
import type { AccountMeta, Store, StoredSession } from "./types.js";

interface FileShape {
  accounts: AccountMeta[];
  secrets: Record<string, string>;
}

/**
 * Single-file store. Accounts are plain metadata; sessions are sealed with
 * SecretBox. The file is written atomically with mode 0600.
 */
export class FileStore implements Store {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly box: SecretBox,
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
  }

  private async read(): Promise<FileShape> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      return { accounts: parsed.accounts ?? [], secrets: parsed.secrets ?? {} };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { accounts: [], secrets: {} };
      throw e;
    }
  }

  private async write(data: FileShape): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600);
  }

  /** Serialize read-modify-write cycles within this process. */
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
      delete d.secrets[key];
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
    const sealed = (await this.read()).secrets[email.toLowerCase()];
    return sealed ? this.box.open<StoredSession>(sealed) : null;
  }

  putSession(email: string, session: StoredSession): Promise<void> {
    return this.mutate((d) => {
      d.secrets[email.toLowerCase()] = this.box.seal(session);
    });
  }

  deleteSession(email: string): Promise<void> {
    return this.mutate((d) => {
      delete d.secrets[email.toLowerCase()];
    });
  }

  async close(): Promise<void> {
    await this.chain;
  }
}

import pg from "pg";
import type { AccountMeta, Store, StoredSession } from "./types.js";

/** Postgres store for container deployments (no persistent volume needed). */
export class PgStore implements Store {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS brella_accounts (email TEXT PRIMARY KEY, meta JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS brella_sessions (email TEXT PRIMARY KEY, session JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS brella_kv (ns TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL, expires_at TIMESTAMPTZ, PRIMARY KEY (ns, key));
    `);
    await this.pool.query("DELETE FROM brella_kv WHERE expires_at < now()");
  }

  async listAccounts(): Promise<AccountMeta[]> {
    const r = await this.pool.query<{ meta: AccountMeta }>("SELECT meta FROM brella_accounts ORDER BY email");
    return r.rows.map((x) => x.meta);
  }

  private async tx(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await fn(c);
      await ensureOneDefault(c);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  upsertAccount(meta: AccountMeta): Promise<void> {
    return this.tx(async (c) => {
      if (meta.is_default) await c.query(`UPDATE brella_accounts SET meta = jsonb_set(meta, '{is_default}', 'false')`);
      await c.query(
        `INSERT INTO brella_accounts (email, meta) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET meta = EXCLUDED.meta`,
        [meta.email.toLowerCase(), meta],
      );
    });
  }

  removeAccount(email: string): Promise<void> {
    const key = email.toLowerCase();
    return this.tx(async (c) => {
      await c.query("DELETE FROM brella_sessions WHERE email = $1", [key]);
      await c.query("DELETE FROM brella_accounts WHERE email = $1", [key]);
    });
  }

  async setDefault(email: string): Promise<void> {
    await this.pool.query(`UPDATE brella_accounts SET meta = jsonb_set(meta, '{is_default}', to_jsonb(email = $1))`, [email.toLowerCase()]);
  }

  async getSession(email: string): Promise<StoredSession | null> {
    const r = await this.pool.query<{ session: StoredSession }>("SELECT session FROM brella_sessions WHERE email = $1", [email.toLowerCase()]);
    return r.rows[0]?.session ?? null;
  }

  async putSession(email: string, session: StoredSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO brella_sessions (email, session, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (email) DO UPDATE SET session = EXCLUDED.session, updated_at = now()`,
      [email.toLowerCase(), session],
    );
  }

  async deleteSession(email: string): Promise<void> {
    await this.pool.query("DELETE FROM brella_sessions WHERE email = $1", [email.toLowerCase()]);
  }

  async kvGet<T>(ns: string, key: string): Promise<T | null> {
    const r = await this.pool.query<{ value: T }>(
      "SELECT value FROM brella_kv WHERE ns = $1 AND key = $2 AND (expires_at IS NULL OR expires_at > now())",
      [ns, key],
    );
    return r.rows[0]?.value ?? null;
  }

  async kvPut(ns: string, key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO brella_kv (ns, key, value, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (ns, key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [ns, key, JSON.stringify(value), ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null],
    );
  }

  async kvDelete(ns: string, key: string): Promise<void> {
    await this.pool.query("DELETE FROM brella_kv WHERE ns = $1 AND key = $2", [ns, key]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

async function ensureOneDefault(c: pg.PoolClient): Promise<void> {
  const r = await c.query("SELECT count(*)::int AS n FROM brella_accounts WHERE (meta->>'is_default')::boolean");
  if (r.rows[0].n === 0) {
    await c.query(
      `UPDATE brella_accounts SET meta = jsonb_set(meta, '{is_default}', 'true')
       WHERE email = (SELECT email FROM brella_accounts ORDER BY email LIMIT 1)`,
    );
  }
}

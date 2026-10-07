import pg from "pg";
import { SecretBox } from "./crypto.js";
import type { AccountMeta, Store, StoredSession } from "./types.js";

/**
 * Postgres-backed store for container deployments without a persistent
 * volume. Account metadata and sealed sessions live in separate tables so the
 * secret column is never selected by metadata reads.
 */
export class PgStore implements Store {
  private readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly box: SecretBox,
  ) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS brella_accounts (
        email TEXT PRIMARY KEY,
        meta JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS brella_sessions (
        email TEXT PRIMARY KEY,
        sealed TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async listAccounts(): Promise<AccountMeta[]> {
    const r = await this.pool.query<{ meta: AccountMeta }>("SELECT meta FROM brella_accounts ORDER BY email");
    return r.rows.map((x) => x.meta);
  }

  async upsertAccount(meta: AccountMeta): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (meta.is_default) {
        await client.query(`UPDATE brella_accounts SET meta = jsonb_set(meta, '{is_default}', 'false')`);
      }
      await client.query(
        `INSERT INTO brella_accounts (email, meta) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET meta = EXCLUDED.meta`,
        [meta.email.toLowerCase(), meta],
      );
      await ensureOneDefault(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async removeAccount(email: string): Promise<void> {
    const key = email.toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM brella_sessions WHERE email = $1", [key]);
      await client.query("DELETE FROM brella_accounts WHERE email = $1", [key]);
      await ensureOneDefault(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async setDefault(email: string): Promise<void> {
    await this.pool.query(
      `UPDATE brella_accounts SET meta = jsonb_set(meta, '{is_default}', to_jsonb(email = $1))`,
      [email.toLowerCase()],
    );
  }

  async getSession(email: string): Promise<StoredSession | null> {
    const r = await this.pool.query<{ sealed: string }>("SELECT sealed FROM brella_sessions WHERE email = $1", [
      email.toLowerCase(),
    ]);
    return r.rows[0] ? this.box.open<StoredSession>(r.rows[0].sealed) : null;
  }

  async putSession(email: string, session: StoredSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO brella_sessions (email, sealed, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (email) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()`,
      [email.toLowerCase(), this.box.seal(session)],
    );
  }

  async deleteSession(email: string): Promise<void> {
    await this.pool.query("DELETE FROM brella_sessions WHERE email = $1", [email.toLowerCase()]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

async function ensureOneDefault(client: pg.PoolClient): Promise<void> {
  const r = await client.query("SELECT count(*)::int AS n FROM brella_accounts WHERE (meta->>'is_default')::boolean");
  if (r.rows[0].n === 0) {
    await client.query(
      `UPDATE brella_accounts SET meta = jsonb_set(meta, '{is_default}', 'true')
       WHERE email = (SELECT email FROM brella_accounts ORDER BY email LIMIT 1)`,
    );
  }
}

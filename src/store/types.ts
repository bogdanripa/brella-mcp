/** Non-secret account metadata. */
export interface AccountMeta {
  email: string;
  alias?: string;
  is_default: boolean;
  user_id?: string;
  display_name?: string;
  created_at: string;
  verified_at?: string;
}

/** Brella session material for one account. Never leaves the store/client. */
export interface StoredSession {
  "access-token"?: string;
  client?: string;
  uid?: string;
  expiry?: string;
  "token-type"?: string;
  cookies?: string[];
  updated_at: string;
  /** Set when Brella answered 401: the account must sign in again. */
  invalid_at?: string;
}

export interface Store {
  init(): Promise<void>;
  listAccounts(): Promise<AccountMeta[]>;
  upsertAccount(meta: AccountMeta): Promise<void>;
  removeAccount(email: string): Promise<void>;
  setDefault(email: string): Promise<void>;
  getSession(email: string): Promise<StoredSession | null>;
  putSession(email: string, session: StoredSession): Promise<void>;
  deleteSession(email: string): Promise<void>;
  /** Small key/value space with optional expiry (OAuth clients, codes, tokens). */
  kvGet<T>(ns: string, key: string): Promise<T | null>;
  kvPut(ns: string, key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  kvDelete(ns: string, key: string): Promise<void>;
  close(): Promise<void>;
}

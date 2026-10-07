/** Non-secret account metadata written by setup (spec §4.1 step 4). */
export interface AccountMeta {
  email: string;
  alias?: string;
  is_default: boolean;
  user_id?: string;
  display_name?: string;
  created_at: string;
  verified_at?: string;
}

/** Secret session material for one account. Never leaves the store/client. */
export interface StoredSession {
  "access-token"?: string;
  client?: string;
  uid?: string;
  expiry?: string;
  "token-type"?: string;
  cookies?: string[];
  updated_at: string;
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
  close(): Promise<void>;
}

import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Store } from "../store/types.js";

/**
 * OAuth 2.1 authorization server for MCP clients (ChatGPT, Claude, …).
 * "Logging in" means signing in to Brella with an emailed code on our own
 * /login page; the issued access token is bound to that Brella account.
 * All state lives in the store, so any instance can serve any request.
 */

export const ACCESS_TTL = 7 * 24 * 3600;
export const REFRESH_TTL = 90 * 24 * 3600;
export const PENDING_TTL = 15 * 60;
export const CODE_TTL = 5 * 60;

export const newSecret = (bytes = 32) => randomBytes(bytes).toString("base64url");
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** An authorization request waiting for the user to finish the Brella login. */
export interface PendingAuth {
  client_id: string;
  client_name?: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  email?: string;
  tries: number;
  code_sent?: boolean;
}

interface CodeRecord {
  client_id: string;
  email: string;
  code_challenge: string;
  redirect_uri: string;
  scopes: string[];
  resource?: string;
}

interface TokenRecord {
  client_id: string;
  email: string;
  scopes: string[];
  resource?: string;
  expires_at: number;
}

export class BrellaOAuthProvider implements OAuthServerProvider {
  constructor(private readonly store: Store) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (id) => (await this.store.kvGet<OAuthClientInformationFull>("client", id)) ?? undefined,
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        await this.store.kvPut("client", full.client_id, full);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = newSecret(18);
    const pending: PendingAuth = {
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.toString(),
      tries: 0,
    };
    await this.store.kvPut("pending", id, pending, PENDING_TTL);
    res.redirect(302, `/login?req=${encodeURIComponent(id)}`);
  }

  /** Called by the login page once Brella accepted the code. Returns the client redirect URL. */
  async completeAuthorization(pendingId: string, pending: PendingAuth, email: string): Promise<string> {
    const code = newSecret();
    const rec: CodeRecord = {
      client_id: pending.client_id,
      email,
      code_challenge: pending.code_challenge,
      redirect_uri: pending.redirect_uri,
      scopes: pending.scopes,
      resource: pending.resource,
    };
    await this.store.kvPut("code", hash(code), rec, CODE_TTL);
    await this.store.kvDelete("pending", pendingId);
    const url = new URL(pending.redirect_uri);
    url.searchParams.set("code", code);
    if (pending.state) url.searchParams.set("state", pending.state);
    return url.toString();
  }

  private async codeFor(client: OAuthClientInformationFull, code: string): Promise<CodeRecord> {
    const rec = await this.store.kvGet<CodeRecord>("code", hash(code));
    if (!rec || rec.client_id !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return rec;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return (await this.codeFor(client, code)).code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const rec = await this.codeFor(client, code);
    if (redirectUri && redirectUri !== rec.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
    await this.store.kvDelete("code", hash(code));
    return this.issue(client.client_id, rec.email, rec.scopes, rec.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const rec = await this.store.kvGet<TokenRecord>("rt", hash(refreshToken));
    if (!rec || rec.client_id !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    const session = await this.store.getSession(rec.email);
    if (!session || session.invalid_at) {
      await this.store.kvDelete("rt", hash(refreshToken));
      throw new InvalidGrantError("The Brella session expired; sign in again");
    }
    await this.store.kvDelete("rt", hash(refreshToken)); // rotate
    return this.issue(client.client_id, rec.email, scopes?.length ? scopes : rec.scopes, rec.resource);
  }

  private async issue(clientId: string, email: string, scopes: string[], resource?: string): Promise<OAuthTokens> {
    const access = newSecret();
    const refresh = newSecret();
    const now = Math.floor(Date.now() / 1000);
    await this.store.kvPut("at", hash(access), { client_id: clientId, email, scopes, resource, expires_at: now + ACCESS_TTL } satisfies TokenRecord, ACCESS_TTL);
    await this.store.kvPut("rt", hash(refresh), { client_id: clientId, email, scopes, resource, expires_at: now + REFRESH_TTL } satisfies TokenRecord, REFRESH_TTL);
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") || undefined };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = await this.store.kvGet<TokenRecord>("at", hash(token));
    if (!rec) throw new InvalidTokenError("Invalid or expired access token");
    // A dead Brella session makes the token useless: 401 sends the client back through login.
    const session = await this.store.getSession(rec.email);
    if (!session || session.invalid_at) throw new InvalidTokenError("Brella session expired; sign in again");
    return {
      token,
      clientId: rec.client_id,
      scopes: rec.scopes,
      expiresAt: rec.expires_at,
      resource: rec.resource ? new URL(rec.resource) : undefined,
      extra: { email: rec.email },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.store.kvDelete("at", hash(request.token));
    await this.store.kvDelete("rt", hash(request.token));
  }
}

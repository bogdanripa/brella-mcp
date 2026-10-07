import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * AES-256-GCM envelope for secrets at rest. The key is derived from
 * BRELLA_SECRETS_KEY; without one, secrets are stored as plain JSON and the
 * file store falls back to 0600 permissions (spec §4.4).
 */
export class SecretBox {
  private readonly key: Buffer | null;

  constructor(passphrase: string | undefined) {
    this.key = passphrase ? scryptSync(passphrase, "brella-mcp/v1", 32) : null;
  }

  get encrypted(): boolean {
    return this.key !== null;
  }

  seal(value: unknown): string {
    const json = JSON.stringify(value);
    if (!this.key) return `plain:${Buffer.from(json).toString("base64")}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
  }

  open<T>(sealed: string): T {
    if (sealed.startsWith("plain:")) {
      return JSON.parse(Buffer.from(sealed.slice(6), "base64").toString("utf8")) as T;
    }
    if (!sealed.startsWith("v1:")) throw new Error("Unknown secret envelope");
    if (!this.key) throw new Error("Secret is encrypted but BRELLA_SECRETS_KEY is not set");
    const buf = Buffer.from(sealed.slice(3), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    return JSON.parse(json) as T;
  }
}

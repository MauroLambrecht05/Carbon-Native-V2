import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { MessageProtector } from "../application/ports/AccountNotification.ts";

/** Explicit self-hosted key adapter. Hosted KMS custody can implement the same port.
 * Every message gets an independent data key; AAD binds it to the outbox row. */
export class EnvelopeMessageProtector implements MessageProtector {
  private readonly keys: ReadonlyMap<string, Buffer>;
  constructor(private readonly activeKeyId: string, keys: Readonly<Record<string, string>>) {
    this.keys = new Map(Object.entries(keys).map(([id, encoded]) => {
      const key = Buffer.from(encoded, "base64");
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || key.length !== 32 || key.toString("base64") !== encoded) throw new Error("Invalid notification encryption key configuration");
      return [id, key];
    }));
    if (!this.keys.has(activeKeyId)) throw new Error("Active notification encryption key is missing");
  }

  private encrypt(key: Buffer, plaintext: Buffer, aad: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }

  private decrypt(key: Buffer, ciphertext: string, aad: string): Buffer {
    const data = Buffer.from(ciphertext, "base64");
    if (data.length < 28 || data.toString("base64") !== ciphertext) throw new Error("Invalid message envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
  }

  async seal(plaintext: string, context: string): Promise<string> {
    if (Buffer.byteLength(plaintext) > 16384) throw new Error("Account message exceeds limit");
    const dataKey = randomBytes(32);
    try {
      const wrapped = this.encrypt(this.keys.get(this.activeKeyId)!, dataKey, `carbon-mail-key:v1:${this.activeKeyId}:${context}`);
      const payload = this.encrypt(dataKey, Buffer.from(plaintext), `carbon-mail:v1:${context}`);
      return JSON.stringify({ version: 1, keyId: this.activeKeyId, wrapped, payload });
    } finally { dataKey.fill(0); }
  }

  async open(ciphertext: string, context: string): Promise<string> {
    try {
      if (ciphertext.length > 32768) throw new Error();
      const envelope = JSON.parse(ciphertext);
      const key = this.keys.get(envelope.keyId);
      if (envelope.version !== 1 || !key || typeof envelope.wrapped !== "string" || typeof envelope.payload !== "string") throw new Error();
      const dataKey = this.decrypt(key, envelope.wrapped, `carbon-mail-key:v1:${envelope.keyId}:${context}`);
      try { return this.decrypt(dataKey, envelope.payload, `carbon-mail:v1:${context}`).toString("utf8"); }
      finally { dataKey.fill(0); }
    } catch { throw new Error("Cannot decrypt account notification"); }
  }
}

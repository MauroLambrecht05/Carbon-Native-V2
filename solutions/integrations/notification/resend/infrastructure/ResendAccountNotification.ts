import type { AccountEmail, AccountNotification } from "../../../../capabilities/cloud/identity/application/ports/AccountNotification.ts";

export class ResendAccountNotification implements AccountNotification {
  constructor(private readonly apiKey: string, private readonly from: string, private readonly transport: typeof fetch = fetch) {
    if (!apiKey || !from || /[\r\n]/.test(from)) throw new Error("Resend email configuration is incomplete");
  }
  async send(message: AccountEmail, idempotencyKey: string): Promise<void> {
    const response = await this.transport("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
    });
    // Do not return/log provider bodies: they may contain addresses or request data.
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Account email provider failed (${response.status})`); }
    await response.body?.cancel();
  }
}

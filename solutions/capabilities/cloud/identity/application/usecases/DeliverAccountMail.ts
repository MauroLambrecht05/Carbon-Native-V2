import type { AccountEmail, AccountMailQueue, AccountNotification, MessageProtector } from "../ports/AccountNotification.ts";

export class DeliverAccountMail {
  constructor(private readonly queue: AccountMailQueue, private readonly protector: MessageProtector, private readonly notifications: AccountNotification) {}

  async execute(): Promise<boolean> {
    const job = await this.queue.claim();
    if (!job) return false;
    try {
      const message: AccountEmail = JSON.parse(await this.protector.open(job.protectedMessage, job.id));
      if (typeof message.to !== "string" || typeof message.subject !== "string" || typeof message.text !== "string") throw new Error("Invalid account notification");
      await this.notifications.send(message, `account-challenge-${job.id}`);
      await this.queue.delivered(job);
    } catch {
      // Provider exceptions can contain recipient addresses and message content.
      await this.queue.retry(job);
    }
    return true;
  }
}

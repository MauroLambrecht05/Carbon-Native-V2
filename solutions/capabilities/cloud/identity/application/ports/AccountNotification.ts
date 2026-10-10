export interface AccountEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface AccountNotification {
  send(message: AccountEmail, idempotencyKey: string): Promise<void>;
}

export interface MessageProtector {
  seal(plaintext: string, context: string): Promise<string>;
  open(ciphertext: string, context: string): Promise<string>;
}

export interface AccountMailJob {
  readonly id: string;
  readonly leaseId: string;
  readonly protectedMessage: string;
}

export interface AccountMailQueue {
  claim(): Promise<AccountMailJob | null>;
  delivered(job: AccountMailJob): Promise<void>;
  retry(job: AccountMailJob): Promise<void>;
}

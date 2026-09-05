// A signed-in end user, from consuming a MagicLinkToken until this expires
// or the app revokes it. What `VerifyEndUserSessionUseCase` checks on
// every authenticated end-user request.

import { hashToken } from "../value-objects/TokenHash.ts";

/** 30 days — a typical "stay signed in" web session length, not tuned against anything more specific yet. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionProps {
  readonly id: string;
  readonly endUserId: string;
  readonly orgId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export class Session {
  private constructor(private readonly props: SessionProps) {}

  static issue(input: { id: string; endUserId: string; orgId: string; plaintext: string; now?: Date }): Session {
    const now = input.now ?? new Date();
    return new Session({
      id: input.id,
      endUserId: input.endUserId,
      orgId: input.orgId,
      tokenHash: hashToken(input.plaintext),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      createdAt: now,
    });
  }

  static fromProps(props: SessionProps): Session {
    return new Session(props);
  }

  toProps(): SessionProps {
    return this.props;
  }

  get endUserId(): string {
    return this.props.endUserId;
  }

  get orgId(): string {
    return this.props.orgId;
  }

  isValid(now: Date = new Date()): boolean {
    return now < this.props.expiresAt;
  }
}

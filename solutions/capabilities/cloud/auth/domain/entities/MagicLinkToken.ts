// A single-use, short-lived credential proving control of an email address
// — the entire "OAuth/magic-link sign-in" step this v1 implements is
// magic-link only (see this capability's own index.ts header for why
// OAuth is deliberately out of scope here). Consuming one issues a
// Session; the token itself is never reusable, expired or not.

import { hashToken } from "../value-objects/TokenHash.ts";

/** 15 minutes — long enough to switch to an email client, short enough that a leaked/logged link is a narrow window. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export interface MagicLinkTokenProps {
  readonly id: string;
  readonly endUserId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export class MagicLinkToken {
  private constructor(private readonly props: MagicLinkTokenProps) {}

  static issue(input: { id: string; endUserId: string; plaintext: string; now?: Date }): MagicLinkToken {
    const now = input.now ?? new Date();
    return new MagicLinkToken({
      id: input.id,
      endUserId: input.endUserId,
      tokenHash: hashToken(input.plaintext),
      expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS),
      consumedAt: null,
      createdAt: now,
    });
  }

  static fromProps(props: MagicLinkTokenProps): MagicLinkToken {
    return new MagicLinkToken(props);
  }

  toProps(): MagicLinkTokenProps {
    return this.props;
  }

  get id(): string {
    return this.props.id;
  }

  get endUserId(): string {
    return this.props.endUserId;
  }

  /** False for an already-used token OR one past its TTL — a caller does not get to tell which, same reasoning as an invalid-password error not saying which half was wrong. */
  isUsable(now: Date = new Date()): boolean {
    return this.props.consumedAt === null && now < this.props.expiresAt;
  }
}

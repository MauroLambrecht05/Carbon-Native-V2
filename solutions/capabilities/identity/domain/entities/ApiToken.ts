import { hashToken } from "../value-objects/TokenHash.ts";

export interface ApiTokenProps {
  readonly id: string;
  readonly orgId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
}

export class ApiToken {
  private constructor(private readonly props: ApiTokenProps) {}

  /** The plaintext is returned once, by the caller, and never stored. */
  static issue(input: { id: string; orgId: string; plaintext: string }): ApiToken {
    return new ApiToken({
      id: input.id,
      orgId: input.orgId,
      tokenHash: hashToken(input.plaintext),
      createdAt: new Date(),
    });
  }

  static fromProps(props: ApiTokenProps): ApiToken {
    return new ApiToken(props);
  }

  toProps(): ApiTokenProps {
    return this.props;
  }

  get orgId(): string {
    return this.props.orgId;
  }
}

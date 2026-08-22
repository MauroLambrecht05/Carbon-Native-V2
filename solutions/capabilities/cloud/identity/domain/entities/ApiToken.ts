import { hashToken } from "../value-objects/TokenHash.ts";

// org: what carbon-cli authenticates as — create a build, read the org's own
// usage/builds. worker: what a build worker authenticates as — claim and
// complete builds, for ANY org, because a worker fleet is shared
// infrastructure, not tenant-scoped. Conflating the two was the gap this
// splits: before, one token could both queue work as an org AND pull any
// org's queued work off the shared queue, which is only safe when you also
// happen to be the only tenant.
export type TokenScope = "org" | "worker";

export interface ApiTokenProps {
  readonly id: string;
  readonly orgId: string;
  readonly scope: TokenScope;
  readonly tokenHash: string;
  readonly createdAt: Date;
}

export class ApiToken {
  private constructor(private readonly props: ApiTokenProps) {}

  /** The plaintext is returned once, by the caller, and never stored. */
  static issue(input: { id: string; orgId: string; scope: TokenScope; plaintext: string }): ApiToken {
    return new ApiToken({
      id: input.id,
      orgId: input.orgId,
      scope: input.scope,
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

  get scope(): TokenScope {
    return this.props.scope;
  }
}

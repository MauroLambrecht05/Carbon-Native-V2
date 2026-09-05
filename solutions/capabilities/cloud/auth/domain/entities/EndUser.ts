// An app's OWN end user — distinct from @carbon/identity's Organization
// (the app DEVELOPER'S account). Scoped to one org because two different
// apps' end users with the same email are two different people as far as
// this system is concerned; the org boundary is what a real deployment's
// row-level isolation would enforce.

export interface EndUserProps {
  readonly id: string;
  readonly orgId: string;
  readonly email: string;
  readonly createdAt: Date;
}

export class EndUser {
  private constructor(private readonly props: EndUserProps) {}

  static create(input: { id: string; orgId: string; email: string }): EndUser {
    return new EndUser({ ...input, createdAt: new Date() });
  }

  static fromProps(props: EndUserProps): EndUser {
    return new EndUser(props);
  }

  toProps(): EndUserProps {
    return this.props;
  }

  get id(): string {
    return this.props.id;
  }

  get orgId(): string {
    return this.props.orgId;
  }

  get email(): string {
    return this.props.email;
  }
}

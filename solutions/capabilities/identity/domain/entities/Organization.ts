export interface OrganizationProps {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

export class Organization {
  private constructor(private readonly props: OrganizationProps) {}

  static create(input: { id: string; name: string }): Organization {
    return new Organization({ ...input, createdAt: new Date() });
  }

  static fromProps(props: OrganizationProps): Organization {
    return new Organization(props);
  }

  toProps(): OrganizationProps {
    return this.props;
  }

  get id(): string {
    return this.props.id;
  }
}

// In-memory index of community-reported issues, supporting creation,
// autocomplete search, and status updates.

export interface CommunityIssue {
  readonly id: string;
  readonly title: string;
  readonly component: string;
  readonly environment: string;
  readonly details: string;
  readonly authorId: string;
  readonly authorTag: string;
  status: "Open" | "Confirmed" | "Needs Info" | "Resolved";
  readonly createdAt: Date;
}

export class IssueStore {
  private static instance: IssueStore;
  private readonly issues = new Map<string, CommunityIssue>();

  static getInstance(): IssueStore {
    if (!IssueStore.instance) {
      IssueStore.instance = new IssueStore();
    }
    return IssueStore.instance;
  }

  addIssue(issue: CommunityIssue): void {
    this.issues.set(issue.id, issue);
  }

  getIssue(id: string): CommunityIssue | undefined {
    return this.issues.get(id);
  }

  searchIssues(query: string): CommunityIssue[] {
    const lower = query.toLowerCase().trim();
    const all = Array.from(this.issues.values());
    if (!lower) return all.slice(0, 25);

    return all
      .filter(
        (i) =>
          i.title.toLowerCase().includes(lower) ||
          i.component.toLowerCase().includes(lower) ||
          i.id.toLowerCase().includes(lower),
      )
      .slice(0, 25);
  }

  updateStatus(id: string, status: CommunityIssue["status"]): boolean {
    const issue = this.issues.get(id);
    if (!issue) return false;
    issue.status = status;
    return true;
  }

  clear(): void {
    this.issues.clear();
  }
}

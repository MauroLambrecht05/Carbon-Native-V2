import type { AccountContext, CommandOptions, Environment, Operation, Page, PageRequest, Permission, RequestContext, Result, Role, Scope, Session } from "./contracts";

export type Account = Readonly<{
  id: string; name: string; email: string; avatar: string; revision: string;
  status: "pending" | "active" | "deleted"; termsVersion: string;
  verifiedAt?: string; pendingEmail?: string; methods: readonly ("email" | "github")[];
  mfa: boolean; recoveryCodesRemaining: number; notifications: boolean;
}>;
export type AccountSession = Session & Readonly<{ current: boolean; revoked: boolean; createdAt: string; lastActivityAt: string }>;
export type AuthRequest = Readonly<{ email: string; name?: string; termsAccepted?: boolean; purpose: "signup" | "signin" | "github" | "recovery"; returnTo?: string }>;
export type AuthReceipt = Readonly<{ message: string }>;
export type AuthCompletion = Readonly<{ returnTo: string }>;
export type AccountCommand =
  | { kind: "profile"; name: string; avatar: string }
  | { kind: "email"; email: string }
  | { kind: "link-github"; email: string }
  | { kind: "unlink"; method: "email" | "github" }
  | { kind: "mfa-start" }
  | { kind: "mfa-confirm"; code: string }
  | { kind: "mfa-disable"; code: string }
  | { kind: "recovery-reset"; code: string }
  | { kind: "revoke-session"; sessionId: string }
  | { kind: "revoke-others" }
  | { kind: "notifications"; enabled: boolean }
  | { kind: "delete"; confirmation: string };
export type CommandReceipt = Readonly<{ message: string; recoveryCodes?: readonly string[]; secretValue?: string; resourceId?: string; operation?: Operation; operationId?: string }>;
export type Member = Readonly<{ id: string; name: string; email: string; accountId: string; role: Role; projects: readonly string[]; grants: readonly { permission: Permission; scope: Scope }[]; revision: string }>;
export type Invitation = Readonly<{ id: string; name: string; email: string; orgId: string; role: Role; projects: readonly string[]; status: "pending" | "accepted" | "declined" | "cancelled" | "expired"; expiresAt: string; revision: string; href?: string }>;
export type Transfer = Readonly<{ id: string; orgId: string; from: string; to: string; previousRole: Exclude<Role, "Owner">; status: "pending" | "accepted" | "cancelled"; revision: string }>;
export type OrganizationDetails = Readonly<{ namespace: string; billingContact: string; requireMfa: boolean; revision: string; transfers: readonly Transfer[]; serviceAccountPolicy: string }>;
export type PlatformCommand =
  | { kind: "organization-create"; name: string; namespace: string }
  | { kind: "organization-update"; name: string; namespace: string }
  | { kind: "billing-contact"; email: string }
  | { kind: "organization-policy"; requireMfa: boolean }
  | { kind: "invite"; email: string; role: Exclude<Role, "Owner">; projects: string[] }
  | { kind: "invite-resend" | "invite-cancel"; invitationId: string }
  | { kind: "member-update"; memberId: string; role: Exclude<Role, "Owner">; projects: string[]; grants: { permission: Permission; scope: Scope }[] }
  | { kind: "member-remove"; memberId: string }
  | { kind: "leave" }
  | { kind: "transfer"; memberId: string; previousRole: Exclude<Role, "Owner"> }
  | { kind: "transfer-accept"; transferId: string }
  | { kind: "project-create"; name: string; slug: string; mode: "data" | "builds" | "both"; environment: Environment["kind"] }
  | { kind: "project-archive"; archived: boolean; confirmation: string }
  | { kind: "environment-create"; name: string; environment: Environment["kind"] }
  | { kind: "environment-configure"; name: string; requireProductionConfirmation: boolean }
  | { kind: "environment-pause"; paused: boolean; confirmation: string }
  | { kind: "provision"; services: ("database" | "auth" | "functions")[]; confirmation?: string };
export type Notification = Readonly<{ id: string; name: string; accountId: string; href: string; read: boolean; createdAt: string }>;
export interface IdentityService {
  request(input: AuthRequest): Promise<Result<AuthReceipt>>;
  complete(token: string, code?: string): Promise<Result<AuthCompletion>>;
  recover(email: string, code: string): Promise<Result<AuthReceipt>>;
  getAccount(context?: AccountContext): Promise<Result<Account>>;
  listSessions(page?: PageRequest, context?: AccountContext): Promise<Result<Page<AccountSession>>>;
  command(input: AccountCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  listNotifications(page?: PageRequest, context?: AccountContext): Promise<Result<Page<Notification>>>;
  markRead(id: string): Promise<Result<void>>;
}
export interface PlatformService {
  command(context: RequestContext | undefined, input: PlatformCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  getOrganization(context: RequestContext): Promise<Result<OrganizationDetails>>;
  listMembers(context: RequestContext, page?: PageRequest): Promise<Result<Page<Member>>>;
  listInvitations(context?: RequestContext, page?: PageRequest): Promise<Result<Page<Invitation>>>;
  previewInvitation(token: string): Promise<Result<{ organization: string; role: Role; status: Invitation["status"]; expiresAt: string }>>;
  respondInvitation(token: string, accept: boolean): Promise<Result<{ orgId: string }>>;
}

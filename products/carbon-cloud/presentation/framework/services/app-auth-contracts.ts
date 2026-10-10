import type { CommandOptions, Page, PageRequest, RequestContext, Result, Scope } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";
import type { DataRow, LocalDownload, RowCommand, RowQuery, RowValues } from "./data-contracts";

export type Realm = { id: string; scope: Scope; revision: string; signup: boolean; magicLink: boolean; redirects: string[]; sessionMinutes: number; delivery: "unconfigured" | "verified" | "failed"; sender: string; template: { subject: string; body: string }; oauth: { enabled: boolean; clientId: string; secretId: string; callback: string; linking: "deny" | "verified-email" }; password: { available: false; version: 1; reason: string } };
export type AppUser = { id: string; realmId: string; email: string; status: "pending" | "active" | "suspended" | "deleted"; verified: boolean; providers: string[]; profile: RowValues; claims: RowValues; createdAt: string; revision: string; sessionCount: number };
export type AppSession = { id: string; realmId: string; projectId: string; environmentId: string; userId: string; audience: "app"; createdAt: string; expiresAt: string; revoked: boolean; revision: string };
export type AppAuthEvent = { id: string; realmId: string; userId?: string; provider: string; kind: string; outcome: "succeeded" | "failed"; reason: string; correlationId: string; createdAt: string };
export type AppUserQuery = PageRequest & { email?: string; userId?: string; status?: string; provider?: string; since?: string };
export type UserCommand = { kind: "create"; email: string; active: boolean } | { kind: "invite"; email: string; active: boolean } | { kind: "metadata"; userId: string; profile: RowValues; claims: RowValues } | { kind: "suspend" | "resume" | "revoke-sessions"; userId: string } | { kind: "revoke-session"; userId: string; sessionId: string } | { kind: "delete"; userId: string; confirmation: string; orphanPolicy: "retain" };
export interface AppAuthService {
  getRealm(context: RequestContext): Promise<Result<Realm>>;
  configureRealm(context: RequestContext, input: Omit<Realm, "id" | "scope" | "revision" | "password"> & { invalidateSessions: boolean }, confirmation: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  listUsers(context: RequestContext, query?: AppUserQuery): Promise<Result<Page<AppUser>>>;
  getUser(context: RequestContext, id: string): Promise<Result<{ user: AppUser; sessions: AppSession[]; ownedRows: number; retention: string }>>;
  userCommand(context: RequestContext, command: UserCommand, confirmation: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  exportUsers(context: RequestContext, query: AppUserQuery, fields: string[], options: CommandOptions): Promise<Result<CommandReceipt>>;
  events(context: RequestContext, page?: PageRequest & { provider?: string; outcome?: string; userId?: string }): Promise<Result<Page<AppAuthEvent>>>;
  inbox(context: RequestContext, page?: PageRequest): Promise<Result<Page<{ id: string; email: string; subject: string; body: string; href: string; expiresAt: string; consumed: boolean }>>>;
  previewEmail(context: RequestContext, email: string): Promise<Result<{ subject: string; body: string }>>;
  // Public hosted app-client simulation. It never replaces the dashboard session.
  publicRealm(realmId: string): Promise<Result<{ id: string; signup: boolean; magicLink: boolean; oauth: boolean; redirects: string[]; passwordReason: string }>>;
  requestChallenge(realmId: string, input: { email: string; redirect: string; provider: "email" | "oauth"; outcome?: "success" | "denied" | "error" }, options: CommandOptions): Promise<Result<CommandReceipt>>;
  consumeChallenge(realmId: string, challengeId: string): Promise<Result<{ redirect: string }>>;
  currentSession(realmId: string): Promise<Result<{ session: AppSession; user: Pick<AppUser, "id" | "email" | "profile"> } | null>>;
  sessionCommand(realmId: string, command: "signout" | "rotate" | "profile", profile?: RowValues): Promise<Result<CommandReceipt>>;
  queryRows(realmId: string, tableId: string, query: RowQuery): Promise<Result<Page<DataRow>>>;
  rowCommand(realmId: string, tableId: string, command: RowCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  clientTables(realmId: string): Promise<Result<{ id: string; name: string }[]>>;
}

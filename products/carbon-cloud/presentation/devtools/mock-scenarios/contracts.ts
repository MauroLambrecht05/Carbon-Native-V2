import type {
  CommandOptions,
  ErrorCode,
  Operation,
  Result,
  Scope,
} from "../../framework/services/contracts";
export interface MockTools {
  deliveryScenario(scenario: "success" | "build_failure" | "lease_expiry" | "lease_exhaustion" | "timeout" | "publish_failure" | "quota" | "no_capacity" | "plugin_revoked" | "plugin_incompatible" | "signing_invalid" | "signing_unknown" | "signing_expired" | "stale_ref" | "lost_response"): Promise<Result<void>>;
  advanceDeliverySource(scope: Scope, version: string): Promise<Result<void>>;
  setDeliveryEvidence(scope: Scope, status: "not_reported" | "simulated" | "offline" | "stale"): Promise<Result<void>>;
  inbox(): Promise<Result<{ messages: readonly { id: string; email: string; purpose: string; href: string; status: string; expiresAt: string }[]; authenticators: readonly { accountId: string; email: string; code: string }[]; provisionFailure: boolean }>>;
  failNextProvision(): Promise<Result<void>>;
  inspect(): Promise<
    Result<{
      now: string;
      paused: boolean;
      latencyMs: number;
      failure: string | null;
      deliveryScenario: string;
      identities: readonly { id: string; name: string }[];
    }>
  >;
  selectIdentity(id: string | null): Promise<Result<void>>;
  setClock(paused: boolean, advanceMs?: number): Promise<Result<void>>;
  setLatency(ms: number): Promise<Result<void>>;
  revokeMembership(scope: Scope): Promise<Result<void>>;
  injectFailure(
    target: "catalog.resolve" | "foundation.start",
    code: ErrorCode | null,
    phase?: "before" | "after",
  ): Promise<Result<void>>;
  startCheck(
    scope: Scope,
    outcome: "success" | "partial_failure",
    options: CommandOptions,
  ): Promise<Result<Operation>>;
  reset(confirmation: string): Promise<Result<void>>;
}

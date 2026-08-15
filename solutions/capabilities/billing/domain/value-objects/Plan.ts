// Plans are a lookup table, not user data — same reasoning as the backend
// registry in solutions/contracts/app/types/Backend.ts: the CLI/dashboard
// picks a plan from it, usage-limit checks branch on it, there is exactly
// one answer.

export type PlanId = "free" | "pro";

export interface Plan {
  readonly id: PlanId;
  readonly includedBuildMinutesPerMonth: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", includedBuildMinutesPerMonth: 60 },
  pro: { id: "pro", includedBuildMinutesPerMonth: 6000 },
};

export const DEFAULT_PLAN: PlanId = "free";

import type { CloudFunction, Deployment, FunctionSchedule, Invocation, InvocationInput } from "../../../presentation/framework/services/function-contracts";
import type { Scope } from "../../../presentation/framework/services/contracts";
import type { MockState } from "./store";

export type FunctionJob = { scope: Scope; sessionId: string; deadline: number; functionRevision: string; production: string; deployment: Deployment; simulateFailure: boolean };
export type StoredInvocation = { record: Invocation; input: InvocationInput; sessionId?: string; appSessionId?: string; deadline: number; production: string };
export interface FunctionState {
  functions: Record<string, CloudFunction>; deployments: Record<string, Deployment>; jobs: Record<string, FunctionJob>;
  invocations: Record<string, StoredInvocation>; schedules: Record<string, FunctionSchedule>;
  usage: Record<string, { scope: Scope; invocationId: string; durationMs: number; occurredAt: string }>;
}
export const functions = (state: MockState): FunctionState => state.functions ??= { functions: {}, deployments: {}, jobs: {}, invocations: {}, schedules: {}, usage: {} };

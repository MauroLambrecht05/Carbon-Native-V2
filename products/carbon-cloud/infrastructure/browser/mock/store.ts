import type {
  Audit,
  Binding,
  Environment,
  Operation,
  Organization,
  Permission,
  PlatformEvent,
  Project,
  Role,
  Scope,
  Session,
  ServiceError,
} from "../../../presentation/framework/services/contracts";
import type { ClockState } from "./clock";

export const STORE_VERSION = 1;
export interface Membership {
  revision?: string;
  id: string;
  orgId: string;
  accountId: string;
  role: Role;
  projects: string[];
  grants: { permission: Permission; scope: Scope }[];
  active: boolean;
}
export interface StoredOperation {
  record: Operation;
  deadline: number;
  failStep: number | null;
}
export interface MockState {
  registry?: import("./registry-state").RegistryState;
  functions?: import("./function-state").FunctionState;
  extensions?: import("./extension-state").ExtensionState;
  identity?: import("./identity-state").IdentityState;
  configuration?: import("./configuration-state").ConfigurationState;
  delivery?: import("./delivery-state").DeliveryState;
  data?: import("./data-state").DataState;
  operationsAdmin?: import("./operations-state").OperationsState;
  schemaVersion: number;
  revision: number;
  nextId: number;
  sequence: number;
  accessRevision: number;
  scenario: string;
  clock: ClockState;
  latencyMs: number;
  accounts: Record<string, { id: string; name: string }>;
  sessions: Record<string, Session & { revoked: boolean }>;
  activeSessionId: string | null;
  organizations: Record<string, Organization>;
  memberships: Record<string, Membership>;
  projects: Record<string, Project>;
  environments: Record<string, Environment>;
  bindings: Record<string, Binding>;
  operations: Record<string, StoredOperation>;
  events: Record<string, PlatformEvent>;
  audits: Record<string, Audit>;
  idempotency: Record<string, { fingerprint: string; value: unknown }>;
  failure: {
    target: "catalog.resolve" | "foundation.start";
    error: ServiceError;
    phase: "before" | "after";
  } | null;
}
export interface TransactionResult<T> {
  value: T;
  changed: boolean;
}
export interface Persistence {
  // Callback is synchronous: a single serialized read/modify/write transaction.
  transact<T>(update: (state: MockState) => TransactionResult<T>): Promise<T>;
  reset(seed: MockState): Promise<void>;
  close(): void;
}
export function validateState(value: unknown): MockState {
  if (!value || typeof value !== "object")
    throw new Error(
      "Mock data is invalid. Reset the local workspace to recover.",
    );
  const state = value as MockState;
  if (state.schemaVersion !== STORE_VERSION)
    throw new Error(
      "Incompatible mock schema. Reset explicitly; existing data was not overwritten.",
    );
  for (const field of [
    "accounts",
    "sessions",
    "organizations",
    "memberships",
    "projects",
    "environments",
    "bindings",
    "operations",
    "events",
    "audits",
    "idempotency",
  ] as const) {
    if (
      !state[field] ||
      typeof state[field] !== "object" ||
      Array.isArray(state[field])
    )
      throw new Error(`Invalid mock collection: ${field}. Reset to recover.`);
  }
  if (
    ![
      state.revision,
      state.nextId,
      state.sequence,
      state.accessRevision,
      state.latencyMs,
      state.clock?.anchor,
      state.clock?.wallAnchor,
    ].every(Number.isFinite)
  )
    throw new Error("Invalid mock counters or clock. Reset to recover.");
  if (typeof state.clock.paused !== "boolean")
    throw new Error("Invalid mock clock. Reset to recover.");
  return state;
}

export async function openIndexedDb(
  seed: MockState,
  factory: IDBFactory = indexedDB,
  name = "carbon-cloud-mock-v1",
): Promise<Persistence> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("workspace");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(
        new Error(
          "Mock database upgrade is blocked by another tab. Close it and retry.",
        ),
      );
  });
  db.onversionchange = () => db.close();
  const persistence: Persistence = {
    transact: <T>(update: (state: MockState) => TransactionResult<T>) =>
      new Promise<T>((resolve, reject) => {
        // IndexedDB serializes overlapping readwrite transactions across tabs.
        const tx = db.transaction("workspace", "readwrite");
        const table = tx.objectStore("workspace");
        let result: T;
        let error: unknown;
        const read = table.get("state");
        read.onsuccess = () => {
          try {
            const state = validateState(read.result ?? structuredClone(seed));
            const outcome = update(state);
            result = structuredClone(outcome.value);
            if (outcome.changed || read.result === undefined)
              table.put(state, "state");
          } catch (cause) {
            error = cause;
            tx.abort();
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () =>
          reject(
            error ??
              tx.error ??
              new Error("Mock persistence failed; no change was saved."),
          );
      }),
    reset: (state) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction("workspace", "readwrite");
        tx.objectStore("workspace").put(structuredClone(state), "state");
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error);
      }),
    close: () => db.close(),
  };
  return persistence;
}

// Same transaction semantics, injected by contract checks; never a browser fallback.
export class MemoryPersistence implements Persistence {
  private state: MockState;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(seed: MockState) {
    this.state = structuredClone(seed);
  }
  transact<T>(update: (state: MockState) => TransactionResult<T>): Promise<T> {
    const pending = this.queue.then(() => {
      const draft = structuredClone(validateState(this.state));
      const outcome = update(draft);
      if (outcome.changed) this.state = draft;
      return structuredClone(outcome.value);
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  async reset(seed: MockState) {
    await this.queue;
    this.state = structuredClone(seed);
  }
  close() {}
}

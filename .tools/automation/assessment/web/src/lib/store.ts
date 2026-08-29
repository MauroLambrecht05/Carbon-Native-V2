/**
 * Simple React context-based store.
 * Holds the loaded model, indexes, human overrides, and UI state.
 */
import { createContext, useContext } from "react";
import type { ArchitectureModel, ModelIndexes, HumanModel } from "./types";

export interface AppState {
  model: ArchitectureModel | null;
  indexes: ModelIndexes | null;
  overrides: HumanModel;
  loading: boolean;
  error: string | null;
  // Navigation state
  selectedEntityId: string | null;
  selectedRuleId: string | null;
  selectedFlowId: string | null;
  focusEntityId: string | null;
  traceFrom: string | null;
  traceTo: string | null;
}

export type AppAction =
  | { type: "SET_MODEL"; model: ArchitectureModel; indexes: ModelIndexes }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_ERROR"; error: string }
  | { type: "SELECT_ENTITY"; id: string | null }
  | { type: "SELECT_RULE"; id: string | null }
  | { type: "SELECT_FLOW"; id: string | null }
  | { type: "SET_FOCUS"; id: string | null }
  | { type: "SET_TRACE"; from: string | null; to: string | null }
  | { type: "SET_OVERRIDES"; overrides: HumanModel };

export const initialState: AppState = {
  model:            null,
  indexes:          null,
  overrides:        { version: "1", lastModified: "", overrides: [], additions: {} },
  loading:          true,
  error:            null,
  selectedEntityId: null,
  selectedRuleId:   null,
  selectedFlowId:   null,
  focusEntityId:    null,
  traceFrom:        null,
  traceTo:          null,
};

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_MODEL":
      return { ...state, model: action.model, indexes: action.indexes, loading: false, error: null };
    case "SET_LOADING":
      return { ...state, loading: action.loading };
    case "SET_ERROR":
      return { ...state, error: action.error, loading: false };
    case "SELECT_ENTITY":
      return { ...state, selectedEntityId: action.id, selectedRuleId: null, selectedFlowId: null };
    case "SELECT_RULE":
      return { ...state, selectedRuleId: action.id, selectedEntityId: null, selectedFlowId: null };
    case "SELECT_FLOW":
      return { ...state, selectedFlowId: action.id, selectedEntityId: null, selectedRuleId: null };
    case "SET_FOCUS":
      return { ...state, focusEntityId: action.id };
    case "SET_TRACE":
      return { ...state, traceFrom: action.from, traceTo: action.to };
    case "SET_OVERRIDES":
      return { ...state, overrides: action.overrides };
    default:
      return state;
  }
}

export const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
} | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be inside AppProvider");
  return ctx;
}

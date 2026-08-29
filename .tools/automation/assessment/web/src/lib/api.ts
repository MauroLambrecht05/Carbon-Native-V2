import type { ArchitectureModel, HumanModel, HumanOverride } from "./types";

const BASE = "";

export async function fetchModel(): Promise<ArchitectureModel> {
  const res = await fetch(`${BASE}/api/model`);
  if (!res.ok) throw new Error(`Failed to load model: ${res.statusText}`);
  return res.json() as Promise<ArchitectureModel>;
}

export async function fetchOverrides(): Promise<HumanModel> {
  const res = await fetch(`${BASE}/api/overrides`);
  if (!res.ok) return { version: "1", lastModified: "", overrides: [], additions: {} };
  return res.json() as Promise<HumanModel>;
}

export async function saveOverrides(model: HumanModel): Promise<void> {
  await fetch(`${BASE}/api/overrides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(model, null, 2),
  });
}

export async function fetchCoverage(): Promise<unknown> {
  const res = await fetch(`${BASE}/api/coverage`);
  if (!res.ok) return null;
  return res.json();
}

export function addOverride(
  model: HumanModel,
  override: Omit<HumanOverride, "id">,
): HumanModel {
  const existing = model.overrides.findIndex(o => o.targetId === override.targetId && o.targetKind === override.targetKind);
  const newOverride: HumanOverride = { ...override, id: `human-${Date.now()}` };
  const overrides = existing >= 0
    ? model.overrides.map((o, i) => i === existing ? newOverride : o)
    : [...model.overrides, newOverride];
  return { ...model, overrides, lastModified: new Date().toISOString() };
}

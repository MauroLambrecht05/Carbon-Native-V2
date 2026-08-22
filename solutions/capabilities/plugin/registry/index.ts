// @carbon/registry — the registry of everything a plugin can plug
// into, and the three renderings generated from it.
//
// The source of truth is Zig:
//
//   solutions/contracts/plugin/registry/extension-points.zig
//
// A plugin `@import`s that file directly and needs nothing from here. This
// capability exists for the two parties that cannot read Zig — the Rust
// runtime and the TypeScript toolchain — and its whole job is to render the
// registry into their languages and then prove the renderings still agree.
//
//   domain/          the model, the Zig parser, and one renderer per target
//   application/     ports/ArtifactStore, and render / generate / check
//   infrastructure/  the real filesystem
//
// Why a capability rather than tooling in .tools/: this is business logic about
// a contract, it has a model with rules, and it is consumed by a product
// (carbon-ext) and by the CLI. .tools/ holds automation that never ships.

export {
  ExtensionPoint,
  ExtensionPointRegistry,
  type Arity,
  type Param,
  type Stability,
} from "./domain/entities/ExtensionPoint.ts";
export {
  valueType,
  VALUE_TYPE_IDS,
  type ValueType,
  type ValueTypeId,
} from "./domain/value-objects/ValueType.ts";
export {
  ExtensionPointError,
  GeneratedArtifactStaleError,
  RegistryInvariantError,
  RegistryParseError,
  UnknownExtensionPointError,
} from "./domain/errors/ExtensionPointError.ts";
export { parseZigRegistry } from "./domain/services/ZigRegistryParser.ts";
export { C_HEADER_PATH, renderCHeader } from "./domain/services/renderers/CHeaderRenderer.ts";
export { RUST_PATH, renderRust } from "./domain/services/renderers/RustRenderer.ts";
export {
  TYPESCRIPT_PATH,
  renderTypeScript,
} from "./domain/services/renderers/TypeScriptRenderer.ts";

export type { ArtifactStore } from "./application/ports/ArtifactStore.ts";
export {
  RenderRegistryUseCase,
  type Rendering,
  type RenderResult,
} from "./application/usecases/RenderRegistryUseCase.ts";
export {
  GenerateArtifactsUseCase,
  type GeneratedArtifact,
  type GenerateResult,
} from "./application/usecases/GenerateArtifactsUseCase.ts";
export {
  CheckArtifactsUseCase,
  type ArtifactStatus,
  type CheckedArtifact,
  type CheckResult,
} from "./application/usecases/CheckArtifactsUseCase.ts";

export { NodeArtifactStore, REGISTRY_PATH } from "./infrastructure/NodeArtifactStore.ts";

import { CheckArtifactsUseCase } from "./application/usecases/CheckArtifactsUseCase.ts";
import { GenerateArtifactsUseCase } from "./application/usecases/GenerateArtifactsUseCase.ts";
import { RenderRegistryUseCase } from "./application/usecases/RenderRegistryUseCase.ts";
import { NodeArtifactStore } from "./infrastructure/NodeArtifactStore.ts";

/** The use cases wired to a real workspace on disk. */
export function extensionPointUseCases(workspaceRoot: string) {
  const store = new NodeArtifactStore(workspaceRoot);
  return {
    store,
    render: new RenderRegistryUseCase(store),
    generate: new GenerateArtifactsUseCase(store),
    check: new CheckArtifactsUseCase(store),
  };
}

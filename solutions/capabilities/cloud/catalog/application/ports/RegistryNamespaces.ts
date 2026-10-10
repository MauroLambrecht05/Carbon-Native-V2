import type { EnvironmentScope, RegistryNamespace } from '@carbon/contracts/platform';
export interface RegistryNamespaces {
  get(scope: EnvironmentScope, bindingId: string, stillAuthorized: () => Promise<boolean>): Promise<RegistryNamespace>;
}

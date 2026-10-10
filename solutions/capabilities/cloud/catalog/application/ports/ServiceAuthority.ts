import type { InternalAssertion } from '@carbon/contracts/platform';
export interface ServiceAuthority { isCurrent(assertion: InternalAssertion): Promise<boolean> }

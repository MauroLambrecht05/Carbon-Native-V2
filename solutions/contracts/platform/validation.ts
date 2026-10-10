import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "./schema/platform.schema.json";
import type { Components } from "./types/Platform.ts";

const ajv = new Ajv2020({ strict: true, allErrors: false });
addFormats(ajv);
ajv.addKeyword({ keyword: "x-carbon-sensitive", schemaType: "boolean", valid: true });
ajv.addKeyword({ keyword: "x-carbon-disclosure", schemaType: "string", valid: true });
ajv.addSchema(schema);
export class ContractError extends Error {
  constructor(readonly component: keyof Components) {
    // Never include input or Ajv errors: those may contain credentials/customer data.
    super(`Invalid platform ${component}`);
    this.name = "ContractError";
  }
}
export function parseComponent<K extends keyof Components>(component: K, input: unknown): Components[K] {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${component}`);
  if (!validate || !validate(input)) throw new ContractError(component);
  return input as Components[K];
}

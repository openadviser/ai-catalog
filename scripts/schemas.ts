// Loads the JSON Schemas in schema/ into one validator instance.
//
// ajv is the one dev dependency of the repository. It checks the schemas
// themselves in strict mode, so an unknown keyword or a broken $ref fails here.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

export const ROOT = resolve(import.meta.dirname, "..");

const BASE = "https://github.com/openadviser/ai-catalog/schema/1.0.0/";

export const SCHEMA_IDS = {
  catalog: `${BASE}catalog.schema.json`,
  usage: `${BASE}usage.schema.json`,
  basis: `${BASE}basis.schema.json`,
  vector: `${BASE}vector.schema.json`,
} as const;

export type SchemaName = keyof typeof SCHEMA_IDS;

export interface SchemaProblem {
  path: string;
  message: string;
}

export type Validate = (name: SchemaName, value: unknown) => SchemaProblem[];

export function loadSchemas(root: string = ROOT): Validate {
  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    strictTypes: false,
    allErrors: true,
  });
  for (const name of Object.keys(SCHEMA_IDS) as SchemaName[]) {
    const schema: unknown = JSON.parse(
      readFileSync(resolve(root, `schema/${name}.schema.json`), "utf8"),
    );
    ajv.addSchema(schema as object);
  }
  return (name, value) => {
    const validate = ajv.getSchema(SCHEMA_IDS[name]);
    if (validate === undefined) throw new Error(`schema ${name} did not compile`);
    if (validate(value)) return [];
    return (validate.errors ?? []).map((error) => ({
      path: error.instancePath === "" ? "/" : error.instancePath,
      message: error.message ?? "invalid",
    }));
  };
}

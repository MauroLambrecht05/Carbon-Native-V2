# app

What an application declares about itself: the `carbon.toml` manifest, the
backend registry it selects from, and the errors raised when it is wrong.

**Agreements**
- `schema/carbon.schema.json` — the document an app author writes
- `types/CarbonManifest.ts` — the parsed shape, and the rules
- `types/Backend.ts` — which backends exist and what each supports
- `errors/ConfigError.ts` — the failure vocabulary

**Honoured by** every product that reads a project, and the bundling and
packaging capabilities. **Breaking it** is a config break: projects already on
disk stop loading, and no recompile fixes them — their authors must edit files.

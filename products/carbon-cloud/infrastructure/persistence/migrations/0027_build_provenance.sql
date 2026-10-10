-- One provenance record per successful build: what was built, from what, by
-- which worker, and the artifacts Cloud verified in object storage. Written in
-- the same transaction that marks the build succeeded, and never changed.
CREATE TABLE build_provenance (
  build_id uuid PRIMARY KEY REFERENCES platform_builds(id),
  attempt_id uuid NOT NULL UNIQUE REFERENCES build_attempts(id),
  statement jsonb NOT NULL CHECK (jsonb_typeof(statement) = 'object'),
  -- SHA-256 of the canonical statement bytes; the signature, when present, is over these bytes.
  statement_digest text NOT NULL CHECK (statement_digest ~ '^[a-f0-9]{64}$'),
  canonical_statement text NOT NULL,
  key_id text CHECK (key_id IS NULL OR key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  signature text CHECK (signature IS NULL OR signature ~ '^[A-Za-z0-9_-]{86}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((key_id IS NULL) = (signature IS NULL))
);
CREATE TRIGGER build_provenance_append_only BEFORE UPDATE OR DELETE ON build_provenance FOR EACH ROW EXECUTE FUNCTION forbid_build_record_change();

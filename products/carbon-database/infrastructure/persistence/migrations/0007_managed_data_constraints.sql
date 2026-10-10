CREATE TABLE canonical_data_constraints (
  table_id uuid NOT NULL REFERENCES canonical_data_tables(id),
  constraint_id uuid NOT NULL,
  descriptor jsonb NOT NULL CHECK (jsonb_typeof(descriptor) = 'object'),
  native_signature text NOT NULL,
  PRIMARY KEY (table_id, constraint_id)
);

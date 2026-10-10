CREATE INDEX canonical_data_tables_scope_name_page
  ON canonical_data_tables (org_id, project_id, environment_id, name COLLATE "C", id);

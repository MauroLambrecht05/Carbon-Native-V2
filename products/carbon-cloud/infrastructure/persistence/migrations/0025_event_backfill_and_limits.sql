-- Keyed digests only, as for app sign-in: no network address is stored to limit worker enrollment attempts.
CREATE TABLE worker_rate_limits (
  key_digest text NOT NULL CHECK (key_digest ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (key_digest, window_started_at)
);

-- Backfill: events written before 0023 existed only in their source tables.
-- They are copied into the organization log in the order they happened, using
-- the same mapping as the 0023 triggers.
--
-- They are placed under transaction 3, the lowest normal transaction ID, so
-- they sort before every event the triggers have recorded. Readers order by
-- (transaction_id, sequence); history must not appear newer than the present.
WITH history AS (
  SELECT id, 'organization_security_events' AS source, org_id, NULL::uuid AS project_id, NULL::uuid AS environment_id, actor_account_id AS actor_id, 'account' AS actor_kind,
         action, 'organization' AS resource_kind, org_id AS resource_id, revision, request_id, created_at
    FROM organization_security_events
  UNION ALL
  SELECT id, 'catalog_events', org_id, project_id, environment_id, actor_account_id, 'account', action,
         CASE WHEN environment_id IS NULL THEN 'project' ELSE 'environment' END, COALESCE(environment_id, project_id), revision, request_id, created_at
    FROM catalog_events
  UNION ALL
  SELECT id, 'environment_credential_events', org_id, project_id, environment_id, actor_account_id, 'account', action, 'environment_credential', credential_id, revision, request_id, created_at
    FROM environment_credential_events
  UNION ALL
  SELECT id, 'environment_secret_events', org_id, project_id, environment_id, actor_account_id, 'account', action, 'environment_secret', secret_id, revision, request_id, created_at
    FROM environment_secret_events
  UNION ALL
  SELECT id, 'repository_events', org_id, project_id, NULL, actor_account_id, 'account', action,
         CASE WHEN repository_id IS NOT NULL THEN 'repository' WHEN installation_id IS NOT NULL THEN 'repository_installation' ELSE 'organization' END,
         COALESCE(repository_id, installation_id, org_id), revision, request_id, created_at
    FROM repository_events
  UNION ALL
  SELECT id, 'service_account_events', org_id, project_id, environment_id, actor_account_id, 'account', action, 'service_account', service_account_id, revision, request_id, created_at
    FROM service_account_events
  UNION ALL
  SELECT e.id, 'device_authorization_events', a.org_id, a.project_id, a.environment_id, e.account_id, 'account', e.action,
         CASE WHEN e.credential_id IS NULL THEN 'device_authorization' ELSE 'device_grant' END, COALESCE(e.credential_id, e.authorization_id), NULL, e.request_id, e.created_at
    FROM device_authorization_events e JOIN device_authorizations a ON a.id = e.authorization_id
  UNION ALL
  SELECT e.id, 'personal_credential_events', c.org_id, c.project_id, c.environment_id, e.account_id, 'account', e.action, 'personal_credential', e.credential_id, NULL, e.request_id, e.created_at
    FROM personal_credential_events e JOIN personal_credentials c ON c.id = e.credential_id
  UNION ALL
  SELECT id, 'legacy_token_events', org_id, NULL, NULL, account_id, 'account', action,
         CASE WHEN token_id IS NULL THEN 'organization' ELSE 'legacy_token' END, COALESCE(token_id, org_id), NULL, request_id, created_at
    FROM legacy_token_events
  UNION ALL
  SELECT e.id, 'worker_events', e.org_id, l.project_id, l.environment_id, COALESCE(e.account_id, e.worker_id), CASE WHEN e.account_id IS NULL THEN 'worker' ELSE 'account' END, e.action,
         CASE WHEN e.lease_id IS NULL THEN 'worker' ELSE 'worker_lease' END, COALESCE(e.lease_id, e.worker_id), NULL, e.request_id, e.created_at
    FROM worker_events e LEFT JOIN worker_leases l ON l.id = e.lease_id
  UNION ALL
  SELECT e.id, 'data_import_job_events', j.org_id, j.project_id, j.environment_id, NULL, 'account', e.action, 'data_import', e.operation_id, NULL, j.request_id, e.created_at
    FROM data_import_job_events e JOIN data_import_jobs j ON j.id = e.operation_id
)
INSERT INTO platform_events (transaction_id, id, source, org_id, project_id, environment_id, actor_kind, actor_id, action, resource_kind, resource_id, revision, request_id, occurred_at)
SELECT '3'::xid8, h.id, h.source, h.org_id, h.project_id, h.environment_id, CASE WHEN h.actor_id IS NULL THEN 'system' ELSE h.actor_kind END, h.actor_id, h.action,
       h.resource_kind, h.resource_id, h.revision, h.request_id, h.created_at
FROM history h
WHERE h.org_id IS NOT NULL AND h.resource_id IS NOT NULL AND h.request_id IS NOT NULL AND h.action ~ '^[a-z][a-z0-9_.-]{0,99}$'
  AND NOT EXISTS (SELECT 1 FROM platform_events p WHERE p.id = h.id)
ORDER BY h.created_at, h.id;

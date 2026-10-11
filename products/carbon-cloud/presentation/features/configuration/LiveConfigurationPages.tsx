import { useServices } from "../../framework/services/context";
import type { ResolvedScope, Scope } from "../../framework/services/contracts";
import type { LiveConfigurationService, LiveCredentialPermission } from "../../framework/services/live-configuration-contracts";
import { CommandForm, choices } from "../identity/Forms";
import { QueryView, useDataParams, useDataQuery } from "../data/shared";

// Environment secrets, environment credentials and organization workers against Carbon Cloud. A value that is
// written or issued here is shown once, in the answer to the command that made it, and never again.

type Props = { scope: Scope; resolved: ResolvedScope };
const when = (value: string | null) => (value ? new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "never");
const allowed = (resolved: ResolvedScope, permission: "resources.configure" | "organization.manage") => (resolved.permissions[permission].allowed ? undefined : resolved.permissions[permission].reason ?? "Your role does not include this.");
const PERMISSIONS: readonly LiveCredentialPermission[] = ["metadata.read", "data.read", "data.write", "resources.configure", "release.publish"];
/** A whole number of days from now, as the instant the service wants. */
const inDays = (days: string) => new Date(Date.now() + Math.max(1, Math.min(365, Math.floor(Number(days)) || 0)) * 86_400_000).toISOString();

function useLive(): LiveConfigurationService {
  const service = useServices().liveConfiguration;
  if (!service) throw new Error("Configuration is not available in this composition.");
  return service;
}

export function LiveSecretsPage({ scope, resolved }: Props) {
  const live = useLive(); const { cursor, pager } = useDataParams();
  const secrets = useDataQuery(scope, ["live-secrets", cursor], (_services, context) => live.secrets(context, { cursor, limit: 50 }));
  const configure = allowed(resolved, "resources.configure");
  return (
    <section>
      <h2>Secrets</h2>
      <p>A secret's value is stored encrypted and is never shown again, here or anywhere. Builds and functions that name a secret receive its current value when they run.</p>
      <QueryView query={secrets}>
        {secrets.data && !secrets.data.items.length && <p>No secrets in this environment.</p>}
        {secrets.data?.items.map(secret => (
          <article key={secret.id}>
            <h3>{secret.name}</h3>
            <p>{secret.state === "active" ? "Active" : "Disabled: nothing that names it can run"} · version {secret.currentVersion} · changed {when(secret.updatedAt)}</p>
            <CommandForm title={`Set a new value for ${secret.name}`} sensitive revision={secret.revision} disabled={configure} fields={[{ name: "value", label: "New value", secret: true, type: "textarea", maxLength: 65536 }]}
              submit={(values, options) => live.rotateSecret({ scope }, secret.id, values.value!, options)}>
              <p>The next build or execution gets the new value. Nothing that is already running is told.</p>
            </CommandForm>
            <CommandForm title={secret.state === "active" ? `Disable ${secret.name}` : `Enable ${secret.name}`} revision={secret.revision} disabled={configure}
              submit={(_values, options) => live.setSecretDisabled({ scope }, secret.id, secret.state === "active", options)} />
          </article>
        ))}
        {secrets.data && pager(secrets.data.nextCursor)}
      </QueryView>
      <CommandForm title="Add a secret" sensitive revision={resolved.environment?.revision} disabled={configure}
        fields={[{ name: "name", label: "Name: upper-case letters, digits and underscores. Example: API_KEY", maxLength: 100 }, { name: "value", label: "Value", secret: true, type: "textarea", maxLength: 65536 }]}
        submit={(values, options) => live.createSecret({ scope }, { name: values.name!, value: values.value! }, options)} />
    </section>
  );
}

export function LiveCredentialsPage({ scope, resolved }: Props) {
  const live = useLive(); const { cursor, pager } = useDataParams();
  const credentials = useDataQuery(scope, ["live-credentials", cursor], (_services, context) => live.credentials(context, { cursor, limit: 50 }));
  const configure = allowed(resolved, "resources.configure");
  return (
    <section>
      <h2>Environment credentials</h2>
      <p>A credential lets automation act in this one environment with the permissions listed, and nothing else. Its value is shown once, when it is created or rotated.</p>
      <QueryView query={credentials}>
        {credentials.data && !credentials.data.items.length && <p>No credentials for this environment.</p>}
        {credentials.data?.items.map(credential => (
          <article key={credential.id}>
            <h3>{credential.name}</h3>
            <p>{credential.prefix}… · {credential.status} · {credential.permissions.join(", ")} · expires {when(credential.expiresAt)}</p>
            {credential.status === "active" && (
              <>
                <CommandForm title={`Rotate ${credential.name}`} revision={credential.revision} disabled={configure}
                  fields={[{ name: "days", label: "Days until the new value expires, 1 to 365", type: "number", value: "90" }, { name: "overlap", label: "Seconds the old value keeps working, 0 to 86400", type: "number", value: "0" }]}
                  submit={(values, options) => live.credentialCommand({ scope }, credential.id, { kind: "rotate", expiresAt: inDays(values.days ?? "90"), overlapSeconds: Math.max(0, Math.min(86400, Math.floor(Number(values.overlap)) || 0)) }, options)} />
                <CommandForm title={`Revoke ${credential.name}`} revision={credential.revision} disabled={configure} submit={(_values, options) => live.credentialCommand({ scope }, credential.id, { kind: "revoke" }, options)}>
                  <p>It stops working on its next use and cannot be brought back.</p>
                </CommandForm>
              </>
            )}
          </article>
        ))}
        {credentials.data && pager(credentials.data.nextCursor)}
      </QueryView>
      <CommandForm title="Create a credential" revision={resolved.environment?.revision} disabled={configure}
        fields={[{ name: "name", label: "Name, to recognise it by", maxLength: 100 }, { name: "permission", label: "Permission", value: "metadata.read", options: choices(PERMISSIONS) },
          { name: "days", label: "Days until it expires, 1 to 365", type: "number", value: "90" }]}
        submit={(values, options) => live.createCredential({ scope }, { name: values.name!, permissions: [values.permission as LiveCredentialPermission], expiresAt: inDays(values.days ?? "90") }, options)}>
        <p>One permission per credential here; a credential for more is made with the API.</p>
      </CommandForm>
    </section>
  );
}

export function LiveWorkersPage({ scope, resolved }: Props) {
  const live = useLive(); const { cursor, pager } = useDataParams(); const organization = { orgId: scope.orgId };
  const workers = useDataQuery(organization, ["live-workers", cursor], (_services, context) => live.workers(context, { cursor, limit: 50 }));
  const manage = allowed(resolved, "organization.manage");
  return (
    <section>
      <h2>Workers</h2>
      <p>A worker is a machine you run that takes this organization's builds or function executions. It runs your code as its own user, with no isolation between jobs: enroll only machines kept for this purpose.</p>
      <QueryView query={workers}>
        {workers.data && !workers.data.items.length && <p>No workers. Builds and executions stay queued until one is enrolled.</p>}
        {workers.data?.items.map(worker => (
          <article key={worker.id}>
            <h3>{worker.name}</h3>
            <p>{worker.status} · takes {worker.purposes.join(" and ")} work{worker.platform ? ` · ${worker.platform}` : ""} · last seen {when(worker.lastSeenAt)}</p>
            {worker.status === "pending" && <p>Waiting for the machine to start with its enrollment code.</p>}
            {(worker.status === "active" || worker.status === "disabled") && <CommandForm title={worker.status === "active" ? `Disable ${worker.name}` : `Enable ${worker.name}`} revision={worker.revision} disabled={manage}
              submit={(_values, options) => live.workerCommand({ scope: organization }, worker.id, worker.status === "active" ? "disable" : "enable", options)} />}
            {worker.status !== "revoked" && <CommandForm title={`Revoke ${worker.name}`} revision={worker.revision} disabled={manage} submit={(_values, options) => live.workerCommand({ scope: organization }, worker.id, "revoke", options)}>
              <p>Its credential stops working, and work it was holding is offered to another worker once its lease runs out. It cannot be brought back.</p>
            </CommandForm>}
          </article>
        ))}
        {workers.data && pager(workers.data.nextCursor)}
      </QueryView>
      <CommandForm title="Enroll a worker" disabled={manage}
        fields={[{ name: "name", label: "Name, to recognise the machine by", maxLength: 100 }, { name: "purpose", label: "What it takes", value: "build", options: [{ value: "build", label: "Builds" }, { value: "function", label: "Function executions" }] }]}
        submit={(values, options) => live.enrollWorker({ scope: organization }, { name: values.name!, purposes: [values.purpose as "build" | "function"] }, options)}>
        <p>The answer is a one-time enrollment code and when it expires. Start the worker with it before then; it then gets a credential of its own.</p>
      </CommandForm>
    </section>
  );
}

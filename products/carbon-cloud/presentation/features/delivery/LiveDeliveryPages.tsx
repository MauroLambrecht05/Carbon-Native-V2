import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { resolveRoute, scopePath } from "../../framework/routing/routes";
import { useServices } from "../../framework/services/context";
import type { ResolvedScope, Scope } from "../../framework/services/contracts";
import type { LiveBuild, LiveChannelRevision, LiveDeliveryService } from "../../framework/services/live-delivery-contracts";
import { CommandForm, type Field } from "../identity/Forms";
import { QueryView, useDataParams, useDataQuery } from "../data/shared";

// Builds, signing, releases and update channels against Carbon Cloud. The console files these under a project;
// the service keeps them per environment. So each page first asks which environment, and everything below it is
// that environment's and nothing else's.

type Props = { scope: Scope; resolved: ResolvedScope };
type InEnvironment = { scope: Scope; resolved: ResolvedScope; base: string; query: string };
const when = (value: string | null) => (value ? new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "not yet");
const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`);
const allowed = (resolved: ResolvedScope, permission: "release.publish" | "signing.manage") => (resolved.permissions[permission].allowed ? undefined : resolved.permissions[permission].reason ?? "Your role does not include this.");
const list = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);

function useLive(): LiveDeliveryService {
  const service = useServices().liveDelivery;
  if (!service) throw new Error("Builds and releases are not available in this composition.");
  return service;
}

export function LiveDeliveryPages({ scope, resolved }: Props) {
  const { catalog } = useServices(); const location = useLocation(); const [params, setParams] = useSearchParams();
  const project = { orgId: scope.orgId, projectId: scope.projectId }; const projectBase = scopePath(project);
  const environments = useDataQuery(project, ["live-delivery-environments"], (_services, context) => catalog.listEnvironments(context, { limit: 50 }));
  const chosen = params.get("environment") ?? environments.data?.items[0]?.id; const environment = environments.data?.items.find(item => item.id === chosen);
  const route = resolveRoute(location.pathname); const path = route?.route.path ?? ""; const ids = route?.params ?? {};
  const query = chosen ? `?environment=${encodeURIComponent(chosen)}` : "";
  const inside: InEnvironment | undefined = environment ? { scope: { ...project, environmentId: environment.id }, resolved, base: projectBase, query } : undefined;
  return (
    <section>
      <p>Builds, signing profiles, releases and update channels each belong to one environment.</p>
      <QueryView query={environments}>
        {environments.data && !environments.data.items.length && <p>This project has no environments yet. Create one from the project overview.</p>}
        {!!environments.data?.items.length && (
          <label>Environment
            <select value={chosen ?? ""} onChange={event => setParams({ environment: event.target.value })}>
              {environments.data.items.map(item => <option key={item.id} value={item.id}>{item.name} ({item.kind})</option>)}
            </select>
          </label>
        )}
        {chosen && !environment && environments.data && <p role="alert">That environment is not in this project.</p>}
        <nav aria-label="Delivery">
          <Link to={`${projectBase}/builds${query}`}>Builds</Link> · <Link to={`${projectBase}/releases${query}`}>Releases</Link> · <Link to={`${projectBase}/channels${query}`}>Update channels</Link> · <Link to={`${projectBase}/settings/signing${query}`}>Signing</Link>
        </nav>
        {inside && (path.endsWith("/builds/:buildId") ? <Build {...inside} buildId={ids.buildId!} />
          : path.endsWith("/builds") ? <Builds {...inside} />
          : path.endsWith("/releases/:releaseId") ? <Release {...inside} releaseId={ids.releaseId!} />
          : path.endsWith("/releases") ? <Releases {...inside} />
          : path.endsWith("/channels/:channelId") ? <Channel {...inside} name={ids.channelId!} />
          : path.endsWith("/channels") ? <Channels {...inside} />
          : <Signing {...inside} />)}
      </QueryView>
    </section>
  );
}

const describeBuild = (build: LiveBuild) => `${build.state}${build.errorCategory ? ` (${build.errorCategory})` : ""} · ${build.commitSha.slice(0, 12)} · ${build.targets.join(", ")} on ${build.platform}`;

function Builds({ scope, resolved, base, query }: InEnvironment) {
  const live = useLive(); const navigate = useNavigate(); const { cursor, pager } = useDataParams();
  const builds = useDataQuery(scope, ["live-builds", cursor], (_services, context) => live.builds(context, { cursor, limit: 25 }));
  const fields: Field[] = [
    { name: "repository", label: "Repository URL (https)", maxLength: 500 }, { name: "commit", label: "Commit: the full 40-character SHA. A build is pinned to one commit", maxLength: 40 },
    { name: "targets", label: "Installer targets, comma-separated. Example: nsis, wix", value: "nsis" }, { name: "platform", label: "Platform", value: "windows", options: [{ value: "windows", label: "windows" }, { value: "linux", label: "linux" }, { value: "macos", label: "macos" }] },
    { name: "secrets", label: "Secret names the build may read, comma-separated (optional)", required: false },
  ];
  return (
    <>
      <h2>Builds</h2>
      <QueryView query={builds}>
        {builds.data && !builds.data.items.length && <p>No builds in this environment yet.</p>}
        <ul>{builds.data?.items.map(build => <li key={build.id}><Link to={`${base}/builds/${build.id}${query}`}>{when(build.createdAt)}</Link> · {describeBuild(build)}</li>)}</ul>
        {builds.data && pager(builds.data.nextCursor)}
      </QueryView>
      <CommandForm title="Queue a build" fields={fields} disabled={allowed(resolved, "release.publish")} after={receipt => receipt.resourceId && navigate(`${base}/builds/${receipt.resourceId}${query}`)}
        submit={(values, options) => live.createBuild({ scope }, { repositoryUrl: values.repository!, commitSha: values.commit!.trim().toLowerCase(), targets: list(values.targets ?? ""), platform: values.platform!, secretNames: list(values.secrets ?? "") }, options)}>
        <p>A worker enrolled for this organization builds the commit in a workspace of its own and uploads the installers. Cloud accepts the build only after reading each one back.</p>
      </CommandForm>
    </>
  );
}

function Build({ scope, resolved, base, query, buildId }: InEnvironment & { buildId: string }) {
  const live = useLive(); const navigate = useNavigate();
  const details = useDataQuery(scope, ["live-build", buildId], (_services, context) => live.build(context, buildId));
  const build = details.data?.build; const open = build ? ["queued", "running"].includes(build.state) : false;
  const log = useDataQuery(scope, ["live-build-log", buildId, build?.revision], (_services, context) => live.buildLog(context, buildId), !!build);
  const profiles = useDataQuery(scope, ["live-signing-profiles"], (_services, context) => live.signingProfiles(context), build?.state === "succeeded");
  const publish = allowed(resolved, "release.publish"); const targets = details.data?.artifacts.map(artifact => artifact.target) ?? [];
  return (
    <QueryView query={details}>
      {build && (
        <>
          <h2>Build</h2>
          <Link to={`${base}/builds${query}`}>All builds</Link>
          <p>{describeBuild(build)}</p>
          <p>{build.repositoryUrl} at {build.commitSha}</p>
          <p>Queued {when(build.createdAt)} · started {when(build.startedAt)} · finished {when(build.completedAt)} · attempt {build.attempt} · {build.usedMinutes === null ? `${build.reservedMinutes} minutes reserved` : `${build.usedMinutes} minutes used`}</p>
          {open && <p role="status">This build has not finished. <button type="button" onClick={() => { void details.refetch(); void log.refetch(); }}>Refresh</button></p>}
          {open && <CommandForm title="Cancel this build" revision={build.revision} disabled={publish} submit={(_values, options) => live.cancelBuild({ scope }, buildId, options)} />}

          <h3>Installers</h3>
          {details.data!.artifacts.length
            ? <ul>{details.data!.artifacts.map(artifact => <li key={artifact.id}>{artifact.target} · {size(artifact.sizeBytes)} · sha256 {artifact.sha256}</li>)}</ul>
            : <p>{build.state === "succeeded" ? "This build produced no installers." : "Installers are listed once the build succeeds and each has been read back and checked."}</p>}

          <h3>Log</h3>
          <QueryView query={log}>{log.data?.text ? <pre>{log.data.text}</pre> : <p>{open ? "Nothing logged yet." : "This build logged nothing."}</p>}{log.data?.nextSequence !== null && log.data && <p>The log continues; refresh to read further.</p>}</QueryView>

          {build.state === "succeeded" && !!targets.length && (
            <QueryView query={profiles}>
              {profiles.data && !profiles.data.length
                ? <p>To release this build, first create a signing profile under <Link to={`${base}/settings/signing${query}`}>Signing</Link>.</p>
                : profiles.data && (
                  <CommandForm title="Release this build" disabled={publish} after={receipt => receipt.resourceId && navigate(`${base}/releases/${receipt.resourceId}${query}`)}
                    fields={[{ name: "version", label: "Version, as major.minor.patch", maxLength: 64 }, { name: "notes", label: "Release notes", type: "textarea", required: false, maxLength: 4000 },
                      { name: "minimum", label: "Oldest version that may update straight to this one (optional)", required: false },
                      { name: "profile", label: "Signing profile", value: profiles.data[0]!.id, options: profiles.data.map(profile => ({ value: profile.id, label: profile.name })) },
                      ...targets.map((target): Field => ({ name: `platform:${target}`, label: `Update platform for the ${target} installer. Example: x86_64-pc-windows-msvc`, maxLength: 100 }))]}
                    submit={(values, options) => live.createRelease({ scope }, { buildId, version: values.version!, notes: values.notes ?? "", minVersion: values.minimum?.trim() || null, signingProfileId: values.profile!,
                      artifacts: targets.map(target => ({ target, platform: values[`platform:${target}`]! })) }, options)}>
                    <p>A release is signed with the profile's key and never changes afterwards. Each installer is published for one update platform; two installers cannot share one.</p>
                  </CommandForm>
                )}
            </QueryView>
          )}
        </>
      )}
    </QueryView>
  );
}

function Signing({ scope, resolved }: InEnvironment) {
  const live = useLive(); const profiles = useDataQuery(scope, ["live-signing-profiles"], (_services, context) => live.signingProfiles(context));
  return (
    <>
      <h2>Signing profiles</h2>
      <p>A profile names the environment secret that holds an update signing key, and records the key's public half. The private key is never shown and never leaves the secret.</p>
      <QueryView query={profiles}>
        {profiles.data && !profiles.data.length && <p>No signing profiles.</p>}
        <ul>{profiles.data?.map(profile => <li key={profile.id}>{profile.name} · secret {profile.secretName} · public key {profile.publicKey}</li>)}</ul>
      </QueryView>
      <CommandForm title="Create a signing profile" disabled={allowed(resolved, "signing.manage")}
        fields={[{ name: "name", label: "Name: lower-case letters, digits and dashes", maxLength: 63 }, { name: "secret", label: "Name of the environment secret holding the key: a base64 32-byte Ed25519 seed", maxLength: 128 }]}
        submit={(values, options) => live.createSigningProfile({ scope }, { name: values.name!, secretName: values.secret! }, options)} />
    </>
  );
}

function Releases({ scope, base, query }: InEnvironment) {
  const live = useLive(); const { cursor, pager } = useDataParams();
  const releases = useDataQuery(scope, ["live-releases", cursor], (_services, context) => live.releases(context, { cursor, limit: 25 }));
  return (
    <>
      <h2>Releases</h2>
      <p>A release is made from a build that succeeded: open the build to release it.</p>
      <QueryView query={releases}>
        {releases.data && !releases.data.items.length && <p>No releases in this environment yet.</p>}
        <ul>{releases.data?.items.map(release => <li key={release.id}><Link to={`${base}/releases/${release.id}${query}`}>{release.version}</Link> · {release.state} · {when(release.createdAt)}</li>)}</ul>
        {releases.data && pager(releases.data.nextCursor)}
      </QueryView>
    </>
  );
}

function Release({ scope, resolved, base, query, releaseId }: InEnvironment & { releaseId: string }) {
  const live = useLive(); const details = useDataQuery(scope, ["live-release", releaseId], (_services, context) => live.release(context, releaseId));
  const release = details.data; const publish = allowed(resolved, "release.publish");
  return (
    <QueryView query={details}>
      {release && (
        <>
          <h2>Release {release.version}</h2>
          <Link to={`${base}/releases${query}`}>All releases</Link>
          <p>{release.state === "published" ? "Published" : `Withdrawn ${when(release.withdrawnAt)}: ${release.withdrawnReason}`} · created {when(release.createdAt)} · from <Link to={`${base}/builds/${release.buildId}${query}`}>its build</Link></p>
          {release.minVersion && <p>Installs older than {release.minVersion} cannot update straight to this release.</p>}
          {release.notes && <pre>{release.notes}</pre>}
          <h3>Installers</h3>
          <ul>{release.artifacts.map(artifact => <li key={artifact.platform}>{artifact.platform} · {artifact.target} · {size(artifact.sizeBytes)} · sha256 {artifact.sha256}</li>)}</ul>
          {release.state === "published" && (
            <>
              <CommandForm title="Publish to a channel" disabled={publish}
                fields={[{ name: "channel", label: "Channel name. Example: stable. A channel exists from its first publish", value: "stable", maxLength: 63 }, { name: "rollout", label: "Percentage of installs to offer it to, 0 to 100", type: "number", value: "100" }]}
                submit={async (values, options) => {
                  // An existing channel is changed at the revision it has now. A new one has none to name.
                  const existing = await live.channel({ scope }, values.channel!);
                  if (!existing.ok && existing.error.code !== "not_found") return existing;
                  return live.channelCommand({ scope }, values.channel!, { kind: "publish", releaseId, rollout: Number(values.rollout) }, { ...options, expectedRevision: existing.ok ? existing.value.channel.revision : undefined });
                }} />
              <CommandForm title="Withdraw this release" revision={release.revision} disabled={publish} fields={[{ name: "reason", label: "Reason. It is recorded with the release", maxLength: 500 }]}
                submit={(values, options) => live.withdrawRelease({ scope }, releaseId, values.reason!, options)}>
                <p>A withdrawn release is put on every channel's stop list, so installs that have it are told. It cannot be published again.</p>
              </CommandForm>
            </>
          )}
        </>
      )}
    </QueryView>
  );
}

const describeRevision = (revision: LiveChannelRevision) => `revision ${revision.number} · version ${revision.version} · offered to ${revision.rollout}% · ${when(revision.createdAt)}${revision.reason ? ` · ${revision.reason}` : ""}`;

function Channels({ scope, base, query }: InEnvironment) {
  const live = useLive(); const channels = useDataQuery(scope, ["live-channels"], (_services, context) => live.channels(context));
  return (
    <>
      <h2>Update channels</h2>
      <p>Installed apps read a channel's feed to learn which release they should be on. A channel is created by publishing a release to it.</p>
      <QueryView query={channels}>
        {channels.data && !channels.data.length && <p>No channels yet. Publish a release to create one.</p>}
        <ul>{channels.data?.map(channel => <li key={channel.name}><Link to={`${base}/channels/${channel.name}${query}`}>{channel.name}</Link> · version {channel.current.version} · offered to {channel.current.rollout}%</li>)}</ul>
      </QueryView>
    </>
  );
}

function Channel({ scope, resolved, base, query, name }: InEnvironment & { name: string }) {
  const live = useLive(); const details = useDataQuery(scope, ["live-channel", name], (_services, context) => live.channel(context, name));
  const channel = details.data?.channel;
  return (
    <QueryView query={details}>
      {channel && (
        <>
          <h2>Channel {channel.name}</h2>
          <Link to={`${base}/channels${query}`}>All channels</Link>
          <p>Now: version {channel.current.version}, offered to {channel.current.rollout}% of installs. <Link to={`${base}/releases/${channel.current.releaseId}${query}`}>Open the release</Link></p>
          <p>Feed: <code>{channel.feedUrl}</code></p>
          <CommandForm title="Change the rollout" revision={channel.revision} disabled={allowed(resolved, "release.publish")}
            fields={[{ name: "rollout", label: "Percentage of installs to offer the current release to, 0 to 100", type: "number", value: String(channel.current.rollout) }]}
            submit={(values, options) => live.channelCommand({ scope }, name, { kind: "rollout", rollout: Number(values.rollout) }, options)}>
            <p>Lowering the percentage does not take the release back from installs that already have it.</p>
          </CommandForm>
          <h3>History</h3>
          <p>Each change is a new signed revision. Earlier ones are kept.</p>
          <ol reversed>{details.data!.revisions.map(revision => <li key={revision.number}>{describeRevision(revision)}</li>)}</ol>
        </>
      )}
    </QueryView>
  );
}

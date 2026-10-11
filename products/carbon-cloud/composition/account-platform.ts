import { resolve } from "node:path";
import { AccountCatalog, AccountEnvironmentCredentials, AccountEnvironmentSecrets, AccountRepositories, EnvelopeSecretProtector, LocalAesSecretKeyCustodian, AwsKmsSecretKeyCustodian, CatalogLifecycle, PostgresProviderSecretReader, AccountWorkers, WorkerLeases, WorkerProtocol, PostgresWorkerRepository, PostgresCatalogRepository, PostgresEnvironmentCredentialRepository, PostgresEnvironmentSecretRepository, PostgresRepositoryIntegrationRepository } from '@carbon/catalog';
import { AccountBlobs, type BlobTransport, AccountData, AccountExports, AccountImports, ExportDownloads, PostgresExportJobs, PostgresImportJobs, RunExportJobs, RunImportJobs, PostgresAccountDataAuthority, type DataTransport, type ExportStore, type ImportTransport } from '@carbon/data';
import { blobClientFromEnv, dataClientFromEnv, exportStoreFromEnv, importClientFromEnv } from './data-platform.ts';
import { createExportRoutes } from '../infrastructure/http/export-routes.ts';
import {
  AccountAuthentication, AccountDeviceAuthorization, AccountServiceAccounts, DeliverAccountMail, DeviceCredentialAuthentication, EnvelopeMessageProtector, PostgresAccountIdentityRepository, PostgresDeviceAuthorizationRepository, PostgresServiceAccountRepository, AccountPersonalCredentials, PostgresPersonalCredentialRepository, PersonalCredentialAuthentication, PersonalCredentialExchange, AccountAudit, OrganizationLifecycle, PostgresAuditLog, AccountLegacyTokens, PostgresLegacyTokenRepository,
  PostgresAccountMailQueue, type AccountNotification,
  AccountSecurity, PostgresAccountSecurityRepository, PostgresMfaVerification, Rfc6238Totp,
  AccountProfile, PostgresAccountProfileRepository,
  OrganizationAccess, PostgresOrganizationRepository, OrganizationInvitations, PostgresOrganizationInvitationsRepository,
  ExternalAccountAuthentication, PostgresExternalAccountRepository, AccountAuthorization, PostgresPlatformAuthority,
} from "@carbon/identity";
import { GitHubAccountProvider } from "@carbon/github-identity";
import { GitHubAppRepositoryProvider } from '@carbon/github-repository';
import { ResendAccountNotification } from "@carbon/resend-notification";
import { DevelopmentInboxNotification } from "../infrastructure/notifications/DevelopmentInboxNotification.ts";
import { AccountRealms, AppAuthentication, HttpOidcClient, PostgresAppAuthRepository, PostgresAppMailQueue } from '@carbon/auth';
import { createAppRoutes } from '../infrastructure/http/app-routes.ts';
import { AccountBuilds, AccountReleases, BuildOrchestration, Ed25519ProvenanceSigner, PostgresPlatformBuildRepository, PostgresPlatformReleaseRepository, PublicUpdateFeed, S3ArtifactReader, S3ArtifactVerifier, SecretReleaseSigner, WorkerBuilds } from '@carbon/orchestration';
import { createUpdateRoutes } from '../infrastructure/http/update-routes.ts';
import { createWorkerRoutes } from '../infrastructure/http/worker-routes.ts';
import { createAccountRoutes } from "../infrastructure/http/account-routes.ts";
import { serviceAssertionIssuerFromEnv } from './service-assertion-signing.ts';

export interface AccountPlatformConfig {
  readonly data?: DataTransport;
  readonly imports?: ImportTransport;
  /** Transport for blob commands to the service that owns blob storage. */
  readonly blobs?: BlobTransport;
  /** Private storage for table exports. Exports exist when this and the data transport are both configured. */
  readonly exportStore?: ExportStore;
  readonly origin: string;
  readonly termsVersion: string;
  readonly rateLimitKey: string;
  readonly activeKeyId: string;
  readonly encryptionKeys: Readonly<Record<string, string>>;
  readonly notification: { kind: "resend"; apiKey: string; from: string } | { kind: "development-inbox"; directory: string };
  readonly github?: { readonly clientId: string; readonly clientSecret: string };
  readonly secrets?: { readonly custody?: 'local'; readonly activeKeyId: string; readonly encryptionKeys: Readonly<Record<string, string>> }
    | { readonly custody: 'aws-kms'; readonly region: string; readonly activeKeyId: string; readonly keys: Readonly<Record<string, string>>; readonly credentials: import('@carbon/catalog').AwsCredentials };
  /** Enrolled workers, leases, lease-bound secret delivery and builds. Requires secrets and the artifact store. */
  readonly workers?: boolean;
  /** Where workers upload artifacts; Cloud reads them back to verify declarations. */
  readonly artifactStore?: import('@carbon/orchestration').ArtifactStoreConfig;
  /** The public address of the artifact bucket: where installed apps download released artifacts. */
  readonly artifactPublicBaseUrl?: string;
  /** Signs build provenance. Without it provenance is recorded unsigned. */
  readonly provenance?: { readonly keyId: string; readonly privateKey: string };
  readonly githubRepositories?: { readonly appId: string; readonly privateKey: string; readonly webhookSecret: string };
  readonly serviceAccountAssertions?: import('@carbon/identity').ServiceAssertionIssuer;
  readonly deviceAssertions?: import('@carbon/identity').ServiceAssertionIssuer;
  readonly legacyTokens?: LegacyTokenConfig;
  /** Signs request-bound Database assertions for app sessions. */
  readonly appAssertions?: import('@carbon/identity').ServiceAssertionIssuer;
  /** Signs request-bound assertions for personal (pt_) credentials. */
  readonly personalAssertions?: import('@carbon/identity').ServiceAssertionIssuer;
}
export interface LegacyTokenConfig { readonly policy: import('@carbon/contracts/platform').LegacyTokenPolicy; readonly sunset?: string }
/** CARBON_LEGACY_TOKENS stages the cc_ deprecation; unset keeps today's behavior ("issue"). */
export function legacyTokenConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LegacyTokenConfig {
  const policy = env.CARBON_LEGACY_TOKENS ?? 'issue';
  if (policy !== 'issue' && policy !== 'accept' && policy !== 'warn' && policy !== 'reject') throw new Error('CARBON_LEGACY_TOKENS must be issue, accept, warn or reject');
  if (!env.CARBON_LEGACY_TOKEN_SUNSET) return { policy };
  const sunset = new Date(env.CARBON_LEGACY_TOKEN_SUNSET);
  if (Number.isNaN(sunset.getTime())) throw new Error('CARBON_LEGACY_TOKEN_SUNSET must be a date');
  return { policy, sunset: sunset.toUTCString() };
}

export function accountPlatformConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AccountPlatformConfig | undefined {
  if (!env.CARBON_ACCOUNT_AUTH || env.CARBON_ACCOUNT_AUTH === "disabled") return undefined;
  if (env.CARBON_ACCOUNT_AUTH !== "enabled") throw new Error("CARBON_ACCOUNT_AUTH must be enabled or disabled");
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`Missing required account configuration: ${name}`); return value; };
  const provider = required("CARBON_ACCOUNT_EMAIL_PROVIDER");
  let notification: AccountPlatformConfig["notification"];
  if (provider === "resend") notification = { kind: "resend", apiKey: required("RESEND_API_KEY"), from: required("CARBON_ACCOUNT_EMAIL_FROM") };
  else if (provider === "development-inbox" && env.NODE_ENV === "development") notification = { kind: "development-inbox", directory: resolve(required("CARBON_ACCOUNT_INBOX_DIRECTORY")) };
  else throw new Error("Configure Resend, or explicitly enable the development inbox in NODE_ENV=development");
  let keys: unknown;
  try { keys = JSON.parse(required("CARBON_ACCOUNT_ENCRYPTION_KEYS")); }
  catch { throw new Error("CARBON_ACCOUNT_ENCRYPTION_KEYS must be a key-ID to base64-key JSON object"); }
  if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.values(keys).some(value => typeof value !== "string")) throw new Error("Invalid account encryption keyring");
  const rateLimitKey = required("CARBON_ACCOUNT_RATE_KEY");
  if (Buffer.from(rateLimitKey, "base64").length !== 32 || Buffer.from(rateLimitKey, "base64").toString("base64") !== rateLimitKey) throw new Error("CARBON_ACCOUNT_RATE_KEY must contain 32 random bytes encoded as base64");
  const origin = required("CARBON_PUBLIC_ORIGIN");
  if (env.NODE_ENV === "production" && new URL(origin).protocol !== "https:") throw new Error("Production account authentication requires an HTTPS public origin");
  if (env.CARBON_ACCOUNT_GITHUB && !["enabled", "disabled"].includes(env.CARBON_ACCOUNT_GITHUB)) throw new Error("CARBON_ACCOUNT_GITHUB must be enabled or disabled");
  const github = env.CARBON_ACCOUNT_GITHUB === "enabled" ? { clientId: required("GITHUB_ACCOUNT_CLIENT_ID"), clientSecret: required("GITHUB_ACCOUNT_CLIENT_SECRET") } : undefined;
  if (env.CARBON_GITHUB_REPOSITORIES && !['enabled', 'disabled'].includes(env.CARBON_GITHUB_REPOSITORIES)) throw new Error('CARBON_GITHUB_REPOSITORIES must be enabled or disabled');
  const githubRepositories = env.CARBON_GITHUB_REPOSITORIES === 'enabled' ? { appId: required('GITHUB_APP_ID'), privateKey: required('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'), webhookSecret: required('GITHUB_APP_WEBHOOK_SECRET') } : undefined;
  if (env.CARBON_SECRETS && !['enabled', 'disabled'].includes(env.CARBON_SECRETS)) throw new Error('CARBON_SECRETS must be enabled or disabled');
  let secrets: AccountPlatformConfig['secrets'];
  if (env.CARBON_SECRETS === 'enabled') {
    const custody = env.CARBON_SECRET_CUSTODY ?? 'local';
    if (custody !== 'local' && custody !== 'aws-kms') throw new Error('CARBON_SECRET_CUSTODY must be local or aws-kms');
    const keyring = (name: string): Record<string, string> => {
      let parsed: unknown;
      try { parsed = JSON.parse(required(name)); } catch { throw new Error(`${name} must be a key-ID JSON object`); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('Invalid secret encryption keyring');
      return parsed as Record<string, string>;
    };
    // There is no fallback between custody modes: the selected one must be fully configured.
    secrets = custody === 'aws-kms'
      ? { custody, region: required('CARBON_SECRET_KMS_REGION'), activeKeyId: required('CARBON_SECRET_ACTIVE_KEY_ID'), keys: keyring('CARBON_SECRET_KMS_KEYS'),
          credentials: { accessKeyId: required('AWS_ACCESS_KEY_ID'), secretAccessKey: required('AWS_SECRET_ACCESS_KEY'), sessionToken: env.AWS_SESSION_TOKEN || undefined } }
      : { custody, encryptionKeys: keyring('CARBON_SECRET_ENCRYPTION_KEYS'), activeKeyId: required('CARBON_SECRET_ACTIVE_KEY_ID') };
  }
  if (env.CARBON_WORKERS && !['enabled', 'disabled'].includes(env.CARBON_WORKERS)) throw new Error('CARBON_WORKERS must be enabled or disabled');
  const workers = env.CARBON_WORKERS === 'enabled';
  if (workers && !secrets) throw new Error('CARBON_WORKERS requires CARBON_SECRETS=enabled');
  // Builds cannot succeed without reading artifacts back, so the store is required with workers, not optional.
  const artifactStore = workers ? { endpoint: required('OBJECT_STORE_ENDPOINT'), bucket: required('OBJECT_STORE_BUCKET'), accessKeyId: required('OBJECT_STORE_ACCESS_KEY_ID'), secretAccessKey: required('OBJECT_STORE_SECRET_ACCESS_KEY') } : undefined;
  const artifactPublicBaseUrl = workers ? required('OBJECT_STORE_PUBLIC_BASE_URL') : undefined;
  if (artifactPublicBaseUrl && !/^https?:\/\/[^\s]+$/.test(artifactPublicBaseUrl)) throw new Error('OBJECT_STORE_PUBLIC_BASE_URL must be an http(s) URL');
  const provenance = env.CARBON_PROVENANCE_PRIVATE_KEY ? { keyId: required('CARBON_PROVENANCE_KEY_ID'), privateKey: env.CARBON_PROVENANCE_PRIVATE_KEY.replace(/\\n/g, '\n') } : undefined;
  if(env.CARBON_SERVICE_ACCOUNT_ASSERTIONS&& !['enabled','disabled'].includes(env.CARBON_SERVICE_ACCOUNT_ASSERTIONS))throw new Error('CARBON_SERVICE_ACCOUNT_ASSERTIONS must be enabled or disabled');
  const serviceAccountAssertions=env.CARBON_SERVICE_ACCOUNT_ASSERTIONS==='enabled'?serviceAssertionIssuerFromEnv(env):undefined;
  if(env.CARBON_DEVICE_ASSERTIONS&& !['enabled','disabled'].includes(env.CARBON_DEVICE_ASSERTIONS))throw new Error('CARBON_DEVICE_ASSERTIONS must be enabled or disabled');
  const deviceAssertions=env.CARBON_DEVICE_ASSERTIONS==='enabled'?serviceAssertionIssuerFromEnv(env):undefined;
  if (env.CARBON_APP_ASSERTIONS && !['enabled', 'disabled'].includes(env.CARBON_APP_ASSERTIONS)) throw new Error('CARBON_APP_ASSERTIONS must be enabled or disabled');
  const appAssertions = env.CARBON_APP_ASSERTIONS === 'enabled' ? serviceAssertionIssuerFromEnv(env) : undefined;
  if (env.CARBON_PERSONAL_ASSERTIONS && !['enabled', 'disabled'].includes(env.CARBON_PERSONAL_ASSERTIONS)) throw new Error('CARBON_PERSONAL_ASSERTIONS must be enabled or disabled');
  const personalAssertions = env.CARBON_PERSONAL_ASSERTIONS === 'enabled' ? serviceAssertionIssuerFromEnv(env) : undefined;
  return {
    origin, termsVersion: required("CARBON_TERMS_VERSION"), rateLimitKey,
    activeKeyId: required("CARBON_ACCOUNT_ACTIVE_KEY_ID"), encryptionKeys: keys as Record<string, string>, notification, github, githubRepositories, secrets, workers, artifactStore, artifactPublicBaseUrl, provenance, serviceAccountAssertions, deviceAssertions, legacyTokens: legacyTokenConfigFromEnv(env), appAssertions, personalAssertions, data: dataClientFromEnv(env), imports: importClientFromEnv(env), exportStore: exportStoreFromEnv(env), blobs: blobClientFromEnv(env),
  };
}

export function composeAccountPlatform(sql: Bun.SQL, config: AccountPlatformConfig) {
  const protector = new EnvelopeMessageProtector(config.activeKeyId, config.encryptionKeys);
  const totp = new Rfc6238Totp();
  const importJobs = config.imports ? new PostgresImportJobs(sql, protector) : undefined;
  const exportJobs = config.exportStore && config.data ? new PostgresExportJobs(sql) : undefined;
  const mfa = new PostgresMfaVerification(protector, totp);
  const repository = new PostgresAccountIdentityRepository(sql, mfa);
  const auth = new AccountAuthentication(repository, protector, config);
  const security = new AccountSecurity(auth, new PostgresAccountSecurityRepository(sql, mfa), protector, totp);
  const externalAccounts = new PostgresExternalAccountRepository(sql, mfa);
  const environmentCredentials = new PostgresEnvironmentCredentialRepository(sql);
  const secretProtector = config.secrets ? new EnvelopeSecretProtector(config.secrets.custody === 'aws-kms'
    ? new AwsKmsSecretKeyCustodian(config.secrets.region, config.secrets.activeKeyId, config.secrets.keys, config.secrets.credentials)
    : new LocalAesSecretKeyCustodian(config.secrets.activeKeyId, config.secrets.encryptionKeys)) : undefined;
  const environmentSecrets = secretProtector ? new PostgresEnvironmentSecretRepository(sql, secretProtector) : undefined;
  const auditLog = new PostgresAuditLog(sql);
  const appRepository = new PostgresAppAuthRepository(sql);
  const workerRepository = config.workers && secretProtector ? new PostgresWorkerRepository(sql, secretProtector) : undefined;
  // Builds run on worker leases, so they exist exactly when workers do.
  const buildRepository = workerRepository && config.artifactStore ? new PostgresPlatformBuildRepository(sql, workerRepository,
    config.provenance ? new Ed25519ProvenanceSigner(config.provenance.keyId, config.provenance.privateKey) : undefined) : undefined;
  // Releases are made from builds and signed with keys held as environment secrets, so they need both.
  const releaseRepository = buildRepository && secretProtector && config.artifactStore && config.artifactPublicBaseUrl ? new PostgresPlatformReleaseRepository(sql, config.origin) : undefined;
  const accountReleases = releaseRepository ? new AccountReleases(auth, releaseRepository, new SecretReleaseSigner(new PostgresProviderSecretReader(sql, secretProtector!)), new S3ArtifactReader(config.artifactStore!),
    protector, { artifactBaseUrl: config.artifactPublicBaseUrl! }) : undefined;
  const github = config.github ? new ExternalAccountAuthentication(auth, externalAccounts,
    new GitHubAccountProvider(config.github.clientId, config.github.clientSecret, config.origin + "/platform/v1/auth/github/callback"), protector, config) : undefined;
  const accountRepositories = config.githubRepositories ? new AccountRepositories(auth, new PostgresRepositoryIntegrationRepository(sql),
    new GitHubAppRepositoryProvider(config.githubRepositories.appId, config.githubRepositories.privateKey, config.githubRepositories.webhookSecret), protector) : undefined;
  const notification: AccountNotification = config.notification.kind === "resend"
    ? new ResendAccountNotification(config.notification.apiKey, config.notification.from)
    : new DevelopmentInboxNotification(config.notification.directory);
  return {
    handler: createAccountRoutes(auth, config.origin, security, new AccountProfile(auth, new PostgresAccountProfileRepository(sql, mfa), protector, config), new OrganizationAccess(auth, new PostgresOrganizationRepository(sql), protector), new OrganizationInvitations(auth, new PostgresOrganizationInvitationsRepository(sql), new PostgresOrganizationRepository(sql), protector, config), github, new AccountAuthorization(auth, new PostgresPlatformAuthority(sql)), new AccountCatalog(auth, new PostgresCatalogRepository(sql), protector), config.data ? new AccountData(auth, new PostgresAccountDataAuthority(sql), config.data, protector) : undefined, importJobs ? new AccountImports(auth, importJobs) : undefined, new AccountEnvironmentCredentials(auth, environmentCredentials, protector), environmentSecrets ? new AccountEnvironmentSecrets(auth, environmentSecrets, protector) : undefined, accountRepositories, new AccountDeviceAuthorization(auth,new PostgresDeviceAuthorizationRepository(sql),protector,config.origin,config.rateLimitKey,new DeviceCredentialAuthentication(sql),config.deviceAssertions),new AccountServiceAccounts(auth,new PostgresServiceAccountRepository(sql),protector,config.serviceAccountAssertions),new AccountPersonalCredentials(auth,new PostgresPersonalCredentialRepository(sql),protector),new AccountLegacyTokens(auth,new PostgresLegacyTokenRepository(sql),protector,config.legacyTokens?.policy??'issue'),workerRepository?new AccountWorkers(auth,workerRepository,protector):undefined,new AccountAudit(auth,auditLog,protector),new AccountRealms(auth,appRepository,protector),new PersonalCredentialExchange(new PersonalCredentialAuthentication(sql),config.personalAssertions),buildRepository?new AccountBuilds(auth,buildRepository,protector):undefined,accountReleases,exportJobs?new AccountExports(auth,exportJobs,config.origin):undefined,config.blobs?new AccountBlobs(auth,new PostgresAccountDataAuthority(sql),config.blobs):undefined),
    buildOrchestration: buildRepository ? new BuildOrchestration(buildRepository) : undefined,
    updateHandler: releaseRepository ? createUpdateRoutes(new PublicUpdateFeed(releaseRepository)) : undefined,
    appHandler: createAppRoutes(new AppAuthentication(appRepository, protector, { rateLimitKey: config.rateLimitKey }, new HttpOidcClient(),
      secretProtector ? new PostgresProviderSecretReader(sql, secretProtector) : undefined, config.appAssertions), config.origin),
    deliverAppMail: new DeliverAccountMail(new PostgresAppMailQueue(sql), protector, notification),
    organizationLifecycle: new OrganizationLifecycle(auditLog),
    catalogLifecycle: new CatalogLifecycle(new PostgresCatalogRepository(sql)),
    workerHandler: workerRepository ? createWorkerRoutes(new WorkerProtocol(workerRepository, config.rateLimitKey), config.origin, buildRepository && config.artifactStore ? new WorkerBuilds(buildRepository, new S3ArtifactVerifier(config.artifactStore)) : undefined) : undefined,
    workerLeases: workerRepository ? new WorkerLeases(workerRepository) : undefined,
    runImports: importJobs && config.imports ? new RunImportJobs(importJobs, config.imports) : undefined,
    runExports: exportJobs ? new RunExportJobs(exportJobs, config.data!, config.exportStore!) : undefined,
    exportDownloadHandler: exportJobs ? createExportRoutes(new ExportDownloads(exportJobs, config.exportStore!)) : undefined,
    deliverMail: new DeliverAccountMail(new PostgresAccountMailQueue(sql), protector, notification),
    expireAccountProofs: () => externalAccounts.expire(),
  };
}

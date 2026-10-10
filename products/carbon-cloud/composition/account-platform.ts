import { resolve } from "node:path";
import { AccountCatalog, AccountEnvironmentCredentials, AccountEnvironmentSecrets, AccountRepositories, EnvelopeSecretProtector, LocalAesSecretKeyCustodian, PostgresCatalogRepository, PostgresEnvironmentCredentialRepository, PostgresEnvironmentSecretRepository, PostgresRepositoryIntegrationRepository } from '@carbon/catalog';
import { AccountData, AccountImports, PostgresImportJobs, RunImportJobs, PostgresAccountDataAuthority, type DataTransport, type ImportTransport } from '@carbon/data';
import { dataClientFromEnv, importClientFromEnv } from './data-platform.ts';
import {
  AccountAuthentication, AccountDeviceAuthorization, AccountServiceAccounts, DeliverAccountMail, DeviceCredentialAuthentication, EnvelopeMessageProtector, PostgresAccountIdentityRepository, PostgresDeviceAuthorizationRepository, PostgresServiceAccountRepository,
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
import { createAccountRoutes } from "../presentation/http/account-routes.ts";
import { serviceAssertionIssuerFromEnv } from './service-assertion-signing.ts';

export interface AccountPlatformConfig {
  readonly data?: DataTransport;
  readonly imports?: ImportTransport;
  readonly origin: string;
  readonly termsVersion: string;
  readonly rateLimitKey: string;
  readonly activeKeyId: string;
  readonly encryptionKeys: Readonly<Record<string, string>>;
  readonly notification: { kind: "resend"; apiKey: string; from: string } | { kind: "development-inbox"; directory: string };
  readonly github?: { readonly clientId: string; readonly clientSecret: string };
  readonly secrets?: { readonly activeKeyId: string; readonly encryptionKeys: Readonly<Record<string, string>> };
  readonly githubRepositories?: { readonly appId: string; readonly privateKey: string; readonly webhookSecret: string };
  readonly serviceAccountAssertions?: import('@carbon/identity').ServiceAssertionIssuer;
  readonly deviceAssertions?: import('@carbon/identity').ServiceAssertionIssuer;
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
    let secretKeys: unknown;
    try { secretKeys = JSON.parse(required('CARBON_SECRET_ENCRYPTION_KEYS')); }
    catch { throw new Error('CARBON_SECRET_ENCRYPTION_KEYS must be a key-ID to base64-key JSON object'); }
    if (!secretKeys || typeof secretKeys !== 'object' || Array.isArray(secretKeys) || Object.values(secretKeys).some(value => typeof value !== 'string')) throw new Error('Invalid secret encryption keyring');
    secrets = { activeKeyId: required('CARBON_SECRET_ACTIVE_KEY_ID'), encryptionKeys: secretKeys as Record<string, string> };
  }
  if(env.CARBON_SERVICE_ACCOUNT_ASSERTIONS&& !['enabled','disabled'].includes(env.CARBON_SERVICE_ACCOUNT_ASSERTIONS))throw new Error('CARBON_SERVICE_ACCOUNT_ASSERTIONS must be enabled or disabled');
  const serviceAccountAssertions=env.CARBON_SERVICE_ACCOUNT_ASSERTIONS==='enabled'?serviceAssertionIssuerFromEnv(env):undefined;
  if(env.CARBON_DEVICE_ASSERTIONS&& !['enabled','disabled'].includes(env.CARBON_DEVICE_ASSERTIONS))throw new Error('CARBON_DEVICE_ASSERTIONS must be enabled or disabled');
  const deviceAssertions=env.CARBON_DEVICE_ASSERTIONS==='enabled'?serviceAssertionIssuerFromEnv(env):undefined;
  return {
    origin, termsVersion: required("CARBON_TERMS_VERSION"), rateLimitKey,
    activeKeyId: required("CARBON_ACCOUNT_ACTIVE_KEY_ID"), encryptionKeys: keys as Record<string, string>, notification, github, githubRepositories, secrets, serviceAccountAssertions, deviceAssertions, data: dataClientFromEnv(env), imports: importClientFromEnv(env),
  };
}

export function composeAccountPlatform(sql: Bun.SQL, config: AccountPlatformConfig) {
  const protector = new EnvelopeMessageProtector(config.activeKeyId, config.encryptionKeys);
  const totp = new Rfc6238Totp();
  const importJobs = config.imports ? new PostgresImportJobs(sql, protector) : undefined;
  const mfa = new PostgresMfaVerification(protector, totp);
  const repository = new PostgresAccountIdentityRepository(sql, mfa);
  const auth = new AccountAuthentication(repository, protector, config);
  const security = new AccountSecurity(auth, new PostgresAccountSecurityRepository(sql, mfa), protector, totp);
  const externalAccounts = new PostgresExternalAccountRepository(sql, mfa);
  const environmentCredentials = new PostgresEnvironmentCredentialRepository(sql);
  const environmentSecrets = config.secrets ? new PostgresEnvironmentSecretRepository(sql,
    new EnvelopeSecretProtector(new LocalAesSecretKeyCustodian(config.secrets.activeKeyId, config.secrets.encryptionKeys))) : undefined;
  const github = config.github ? new ExternalAccountAuthentication(auth, externalAccounts,
    new GitHubAccountProvider(config.github.clientId, config.github.clientSecret, config.origin + "/platform/v1/auth/github/callback"), protector, config) : undefined;
  const accountRepositories = config.githubRepositories ? new AccountRepositories(auth, new PostgresRepositoryIntegrationRepository(sql),
    new GitHubAppRepositoryProvider(config.githubRepositories.appId, config.githubRepositories.privateKey, config.githubRepositories.webhookSecret), protector) : undefined;
  const notification: AccountNotification = config.notification.kind === "resend"
    ? new ResendAccountNotification(config.notification.apiKey, config.notification.from)
    : new DevelopmentInboxNotification(config.notification.directory);
  return {
    handler: createAccountRoutes(auth, config.origin, security, new AccountProfile(auth, new PostgresAccountProfileRepository(sql, mfa), protector, config), new OrganizationAccess(auth, new PostgresOrganizationRepository(sql), protector), new OrganizationInvitations(auth, new PostgresOrganizationInvitationsRepository(sql), new PostgresOrganizationRepository(sql), protector, config), github, new AccountAuthorization(auth, new PostgresPlatformAuthority(sql)), new AccountCatalog(auth, new PostgresCatalogRepository(sql), protector), config.data ? new AccountData(auth, new PostgresAccountDataAuthority(sql), config.data, protector) : undefined, importJobs ? new AccountImports(auth, importJobs) : undefined, new AccountEnvironmentCredentials(auth, environmentCredentials, protector), environmentSecrets ? new AccountEnvironmentSecrets(auth, environmentSecrets, protector) : undefined, accountRepositories, new AccountDeviceAuthorization(auth,new PostgresDeviceAuthorizationRepository(sql),protector,config.origin,config.rateLimitKey,new DeviceCredentialAuthentication(sql),config.deviceAssertions),new AccountServiceAccounts(auth,new PostgresServiceAccountRepository(sql),protector,config.serviceAccountAssertions)),
    runImports: importJobs && config.imports ? new RunImportJobs(importJobs, config.imports) : undefined,
    deliverMail: new DeliverAccountMail(new PostgresAccountMailQueue(sql), protector, notification),
    expireAccountProofs: () => externalAccounts.expire(),
  };
}

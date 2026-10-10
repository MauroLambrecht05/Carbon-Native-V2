import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseComponent, type DeviceGrant } from "@carbon/contracts/platform";

const SERVICE = "carbon-cli.device";

export interface SecretStore {
  get(options: { readonly service: string; readonly name: string }): Promise<string | null>;
  set(options: { readonly service: string; readonly name: string; readonly value: string }): Promise<void>;
  delete(options: { readonly service: string; readonly name: string }): Promise<boolean>;
}

const systemSecrets: SecretStore = {
  get: options => Bun.secrets.get(options),
  set: async options => { await Bun.secrets.set(options); },
  delete: options => Bun.secrets.delete(options),
};

export interface DeviceProfile {
  readonly id: string;
  readonly controlPlaneUrl: string;
  readonly grant: DeviceGrant;
}

interface ProfileDocument {
  readonly version: 1;
  readonly activeProfile: DeviceProfile | null;
}

function credentialName(profile: DeviceProfile): string {
  return createHash("sha256").update(`${profile.controlPlaneUrl}\n${profile.grant.id}`).digest("hex");
}

function validateOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Carbon Cloud URL must be an HTTPS or loopback origin");
  }
  return url.origin;
}

export class DeviceCredentialStore {
  private readonly directory: string;
  private readonly metadataPath: string;

  constructor(directory = process.env.CARBON_CLI_HOME || join(homedir(), ".carbon"), private readonly secrets: SecretStore = systemSecrets) {
    this.directory = directory;
    this.metadataPath = join(directory, "device-profile.json");
  }

  async save(controlPlaneUrl: string, token: string, grantValue: DeviceGrant): Promise<DeviceProfile> {
    if (!/^dc_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Cloud returned an invalid device credential");
    const grant = parseComponent("DeviceGrant", grantValue);
    if (grant.status !== "active" || new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error("Cloud returned an inactive device grant");
    const profile: DeviceProfile = { id: randomUUID(), controlPlaneUrl: validateOrigin(controlPlaneUrl), grant };
    const previous = this.readDocument().activeProfile;
    const name = credentialName(profile);
    await this.secrets.set({ service: SERVICE, name, value: token });
    try { this.writeDocument({ version: 1, activeProfile: profile }); }
    catch (error) { await this.secrets.delete({ service: SERVICE, name }).catch(() => false); throw error; }
    if (previous) await this.secrets.delete({ service: SERVICE, name: credentialName(previous) }).catch(() => false);
    return profile;
  }

  async active(): Promise<{ readonly profile: DeviceProfile; readonly token: string } | null> {
    const profile = this.readDocument().activeProfile;
    if (!profile || profile.grant.status !== "active" || new Date(profile.grant.expiresAt).getTime() <= Date.now()) return null;
    const token = await this.secrets.get({ service: SERVICE, name: credentialName(profile) });
    if (!token || !/^dc_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return { profile, token };
  }

  async clear(): Promise<boolean> {
    const profile = this.readDocument().activeProfile;
    if (!profile) return false;
    await this.secrets.delete({ service: SERVICE, name: credentialName(profile) });
    this.writeDocument({ version: 1, activeProfile: null });
    return true;
  }

  private readDocument(): ProfileDocument {
    if (!existsSync(this.metadataPath)) return { version: 1, activeProfile: null };
    try {
      const value = JSON.parse(readFileSync(this.metadataPath, "utf8")) as Record<string, unknown>;
      if (value.version !== 1 || !Object.hasOwn(value, "activeProfile")) throw new Error();
      if (value.activeProfile === null) return { version: 1, activeProfile: null };
      const raw = value.activeProfile as Record<string, unknown>;
      const profile: DeviceProfile = {
        id: parseComponent("Id", raw.id),
        controlPlaneUrl: validateOrigin(String(raw.controlPlaneUrl ?? "")),
        grant: parseComponent("DeviceGrant", raw.grant),
      };
      return { version: 1, activeProfile: profile };
    } catch { throw new Error("Carbon CLI device profile metadata is invalid"); }
  }

  private writeDocument(document: ProfileDocument): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.metadataPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.metadataPath);
      chmodSync(this.metadataPath, 0o600);
    } finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
  }
}

import { PlatformFault } from "@carbon/contracts/platform";
import type { ExternalAccountIdentity, ExternalAccountProvider } from "../../../../capabilities/cloud/identity/application/ports/ExternalAccountProvider.ts";

/** GitHub OAuth web flow with PKCE; no provider tokens are persisted or returned. */
export class GitHubAccountProvider implements ExternalAccountProvider {
  readonly provider = "github" as const;
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly redirectUri: string,
    private readonly request: typeof fetch = fetch) {
    const redirect = new URL(redirectUri);
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(clientId) || !clientSecret || /[\u0000-\u0020\u007f]/.test(clientSecret)) throw new Error("Invalid GitHub OAuth client configuration");
    if (redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== "/platform/v1/auth/github/callback"
      || (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)))) throw new Error("Invalid GitHub OAuth callback configuration");
  }
  authorizationUrl(state: string, codeChallenge: string): string {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new PlatformFault("validation", "Invalid authorization request");
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.redirectUri, state, scope: "user:email",
      code_challenge: codeChallenge, code_challenge_method: "S256", prompt: "select_account" }).toString();
    return url.href;
  }
  private async json(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(url, { ...init, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 400 || response.status === 401) throw new PlatformFault("unauthenticated", "GitHub authorization was not accepted; start again");
      throw new PlatformFault("unavailable", "GitHub identity is temporarily unavailable; start again");
    }
    const reader = response.body?.getReader(); if (!reader) throw new PlatformFault("unavailable", "GitHub returned an invalid identity response");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 262144) { await reader.cancel(); throw new PlatformFault("unavailable", "GitHub returned an invalid identity response"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async exchange(code: string, codeVerifier: string): Promise<ExternalAccountIdentity> {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new PlatformFault("validation", "Invalid authorization proof");
    try {
      const signal = AbortSignal.timeout(15000);
      const result = await this.json("https://github.com/login/oauth/access_token", { method: "POST", signal,
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "Carbon-Identity" },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, code, code_verifier: codeVerifier, redirect_uri: this.redirectUri }).toString() }) as Record<string, unknown>;
      if (!result || result.error || typeof result.access_token !== "string" || result.access_token.length > 4096
        || !/^[-A-Za-z0-9._~+/]+=*$/.test(result.access_token) || String(result.token_type).toLowerCase() !== "bearer") throw new PlatformFault("unauthenticated", "GitHub authorization was not accepted; start again");
      const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${result.access_token}`, "user-agent": "Carbon-Identity", "x-github-api-version": "2026-03-10" };
      const user = await this.json("https://api.github.com/user", { headers, signal }) as Record<string, unknown>;
      if (!user || user.type !== "User" || typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) throw new PlatformFault("unauthenticated", "A GitHub user identity is required");
      const emails: { email: string; primary: boolean }[] = []; let complete = false;
      for (let page = 1; page <= 10; page++) {
        const rows = await this.json(`https://api.github.com/user/emails?per_page=100&page=${page}`, { headers, signal });
        if (!Array.isArray(rows) || rows.length > 100) throw new PlatformFault("unavailable", "GitHub returned an invalid identity response");
        for (const row of rows) {
          if (!row || typeof row !== "object" || typeof row.email !== "string" || typeof row.verified !== "boolean" || typeof row.primary !== "boolean") throw new PlatformFault("unavailable", "GitHub returned an invalid identity response");
          const email = row.email.trim().toLowerCase();
          if (row.verified && email.length <= 254 && /^[^\s@<>\u0000-\u001f]+@[^\s@<>\u0000-\u001f]+\.[^\s@<>\u0000-\u001f]+$/.test(email)) emails.push({ email, primary: row.primary });
        }
        if (rows.length < 100) { complete = true; break; }
      }
      if (!complete) throw new PlatformFault("unavailable", "GitHub returned too many identity records");
      const primary = emails.filter(email => email.primary);
      if (primary.length !== 1) throw new PlatformFault("forbidden", "Verify your primary GitHub email before continuing");
      const rawName = typeof user.name === "string" && user.name.trim() ? user.name : typeof user.login === "string" ? user.login : "GitHub member";
      const name = Array.from(rawName.replace(/[\u0000-\u001f\u007f]/g, "").trim()).slice(0, 100).join("") || "GitHub member";
      return { provider: this.provider, subject: String(user.id), name, primaryEmail: primary[0]!.email,
        verifiedEmails: [...new Set(emails.map(email => email.email))].sort() };
    } catch (error) {
      if (error instanceof PlatformFault) throw error;
      // Fetch, provider bodies and parsing errors may embed codes or credentials.
      throw new PlatformFault("unavailable", "GitHub identity is temporarily unavailable; start again");
    }
  }
}

// The v1 dashboard. Real API throughout, no mocked data — thin because the
// product is young, not because anything here is fake. A token typed or
// pasted in lives in localStorage for the tab's session; there's no cookie
// session yet (see products/carbon-cloud/README.md's "not yet" list).

import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, ApiError } from "./api.ts";

interface UsageStatus {
  withinLimit: boolean;
  usedMinutes: number;
  includedMinutes: number;
}

interface BuildProps {
  id: string;
  status: string;
  repoUrl: string;
  commitSha: string;
  targets: string[];
  error: string | null;
}

const TOKEN_KEY = "carbon-cloud-token";

function useToken() {
  const [token, setTokenState] = useState(() => localStorage.getItem(TOKEN_KEY));
  const setToken = (value: string | null) => {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
    setTokenState(value);
  };
  return [token, setToken] as const;
}

function SignupForm({ onSignedUp }: { onSignedUp: (token: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await apiFetch<{ orgId: string; apiToken: string }>("/v1/orgs", null, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      onSignedUp(result.apiToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h2>Sign up</h2>
      <p>No accounts yet, no email — an org and a token is the whole flow (self-hosted v1).</p>
      <form onSubmit={onSubmit}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="org name" required />
        <button type="submit" disabled={pending}>{pending ? "..." : "Create org"}</button>
      </form>
      {error && <p style={{ color: "#b3261e" }}>{error}</p>}
      <p>
        Already have a token? <a href="#" onClick={(e) => { e.preventDefault(); onSignedUp(""); }}>Paste one instead</a>
      </p>
    </section>
  );
}

function UsagePanel({ token }: { token: string }) {
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<UsageStatus>("/v1/usage", token).then(setUsage).catch((err) => setError(String(err)));
  }, [token]);

  if (error) return <p style={{ color: "#b3261e" }}>{error}</p>;
  if (!usage) return <p>loading usage…</p>;

  return (
    <p>
      {usage.usedMinutes.toFixed(1)} / {usage.includedMinutes} build-minutes used this period
      {!usage.withinLimit && <strong style={{ color: "#b3261e" }}> — over limit, new builds will be refused (402)</strong>}
    </p>
  );
}

function DeployForm({ token }: { token: string }) {
  const [repoUrl, setRepoUrl] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [targets, setTargets] = useState("deb");
  const [result, setResult] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setResult("queuing...");
    try {
      const build = await apiFetch<BuildProps>("/v1/builds", token, {
        method: "POST",
        body: JSON.stringify({
          repoUrl,
          commitSha,
          targets: targets.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      setResult(`queued: ${build.id}`);
    } catch (err) {
      setResult(err instanceof ApiError ? `${err.status}: ${err.message}` : String(err));
    }
  }

  return (
    <section>
      <h2>Deploy</h2>
      <form onSubmit={onSubmit} style={{ display: "grid", gap: "0.5rem", maxWidth: "28rem" }}>
        <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="repo URL" required />
        <input value={commitSha} onChange={(e) => setCommitSha(e.target.value)} placeholder="commit sha" required />
        <input value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="targets, comma-separated (deb, appimage, nsis, wix)" />
        <button type="submit">Queue build</button>
      </form>
      {result && <pre style={{ background: "#f4f4f4", padding: "0.5rem" }}>{result}</pre>}
    </section>
  );
}

function StatusLookup({ token }: { token: string }) {
  const [buildId, setBuildId] = useState("");
  const [result, setResult] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setResult("loading...");
    try {
      const build = await apiFetch<BuildProps>(`/v1/builds/${encodeURIComponent(buildId.trim())}`, token);
      setResult(JSON.stringify(build, null, 2));
    } catch (err) {
      setResult(err instanceof ApiError ? `${err.status}: ${err.message}` : String(err));
    }
  }

  return (
    <section>
      <h2>Build status</h2>
      <form onSubmit={onSubmit}>
        <input value={buildId} onChange={(e) => setBuildId(e.target.value)} placeholder="build id" required />
        <button type="submit">Check</button>
      </form>
      {result && <pre style={{ background: "#f4f4f4", padding: "1rem", overflowX: "auto" }}>{result}</pre>}
    </section>
  );
}

export function App() {
  const [token, setToken] = useToken();
  const [tokenInput, setTokenInput] = useState("");

  if (!token) {
    return (
      <main style={{ font: "14px/1.5 -apple-system, system-ui, sans-serif", maxWidth: "40rem", margin: "3rem auto", padding: "0 1rem" }}>
        <h1>Carbon Cloud</h1>
        <SignupForm onSignedUp={(apiToken) => (apiToken ? setToken(apiToken) : setToken(""))} />
      </main>
    );
  }

  // "" from SignupForm's "paste one instead" — a real token hasn't been
  // entered yet, so show the paste box instead of calling the API with an
  // empty Authorization header.
  if (token === "") {
    return (
      <main style={{ font: "14px/1.5 -apple-system, system-ui, sans-serif", maxWidth: "40rem", margin: "3rem auto", padding: "0 1rem" }}>
        <h1>Carbon Cloud</h1>
        <form onSubmit={(e) => { e.preventDefault(); setToken(tokenInput); }}>
          <input value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="cc_..." style={{ width: "22rem" }} />
          <button type="submit">Use token</button>
        </form>
      </main>
    );
  }

  return (
    <main style={{ font: "14px/1.5 -apple-system, system-ui, sans-serif", maxWidth: "40rem", margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Carbon Cloud</h1>
      <p>
        <button onClick={() => setToken(null)}>Log out</button>
      </p>
      <UsagePanel token={token} />
      <DeployForm token={token} />
      <StatusLookup token={token} />
    </main>
  );
}

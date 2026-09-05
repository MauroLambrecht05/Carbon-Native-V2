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
  createdAt: string;
}

const STATUS_COLOR: Record<string, string> = {
  succeeded: "#16794e",
  failed: "#b3261e",
  queued: "#6b6b6b",
  claimed: "#8a6d00",
  running: "#8a6d00",
};

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
  const [upgrading, setUpgrading] = useState(false);

  useEffect(() => {
    apiFetch<UsageStatus>("/v1/usage", token).then(setUsage).catch((err) => setError(String(err)));
  }, [token]);

  // Redirects the whole tab to Stripe's hosted Checkout page (or, if no
  // real Stripe account is configured, FakeCheckoutSessionProvider's fake
  // URL back to this same page) — never collects a card number here.
  // The plan itself only changes once Stripe's webhook confirms payment,
  // not on this redirect returning; see ConfirmPlanUpgradeUseCase's note.
  async function onUpgrade() {
    setUpgrading(true);
    setError(null);
    try {
      const session = await apiFetch<{ url: string }>("/v1/billing/checkout", token, {
        method: "POST",
        body: JSON.stringify({ plan: "pro" }),
      });
      window.location.href = session.url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setUpgrading(false);
    }
  }

  if (error) return <p style={{ color: "#b3261e" }}>{error}</p>;
  if (!usage) return <p>loading usage…</p>;

  return (
    <p>
      {usage.usedMinutes.toFixed(1)} / {usage.includedMinutes} build-minutes used this period
      {!usage.withinLimit && <strong style={{ color: "#b3261e" }}> — over limit, new builds will be refused (402)</strong>}
      {usage.includedMinutes < 6000 && (
        <>
          {" — "}
          <button type="button" onClick={onUpgrade} disabled={upgrading}>
            {upgrading ? "..." : "Upgrade to Pro"}
          </button>
        </>
      )}
    </p>
  );
}

function DeployForm({ token, onQueued }: { token: string; onQueued: () => void }) {
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
      onQueued();
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

function BuildList({ token, refreshKey, onSelect }: { token: string; refreshKey: number; onSelect: (id: string) => void }) {
  const [builds, setBuilds] = useState<BuildProps[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<BuildProps[]>("/v1/builds?limit=20", token)
      .then(setBuilds)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
    // Polled, not pushed: there's no live-update channel yet (see
    // products/carbon-cloud/README.md) — refetching every few seconds is a
    // deliberately simple stand-in until one exists.
    const interval = setInterval(() => {
      apiFetch<BuildProps[]>("/v1/builds?limit=20", token).then(setBuilds).catch(() => {});
    }, 4000);
    return () => clearInterval(interval);
  }, [token, refreshKey]);

  return (
    <section>
      <h2>Recent builds</h2>
      {error && <p style={{ color: "#b3261e" }}>{error}</p>}
      {builds === null && !error && <p>loading…</p>}
      {builds !== null && builds.length === 0 && <p>No builds yet — deploy one above.</p>}
      {builds !== null && builds.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9em" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th>commit</th>
              <th>targets</th>
              <th>status</th>
              <th>created</th>
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <tr
                key={b.id}
                onClick={() => onSelect(b.id)}
                style={{ cursor: "pointer", borderBottom: "1px solid #f0f0f0" }}
              >
                <td>{b.commitSha.slice(0, 8)}</td>
                <td>{b.targets.join(", ")}</td>
                <td style={{ color: STATUS_COLOR[b.status] ?? "inherit", fontWeight: 600 }}>{b.status}</td>
                <td>{new Date(b.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function StatusLookup({ token, selectedId }: { token: string; selectedId: string | null }) {
  const [buildId, setBuildId] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ timestamp: string; stream: string; line: string }[]>([]);
  const [artifacts, setArtifacts] = useState<{ name: string; target: string; sizeBytes: number; downloadUrl: string }[]>([]);

  async function lookup(id: string) {
    setResult("loading...");
    setLogs([]);
    setArtifacts([]);
    try {
      const cleanId = encodeURIComponent(id.trim());
      const build = await apiFetch<BuildProps>(`/v1/builds/${cleanId}`, token);
      setResult(JSON.stringify(build, null, 2));

      // Fetch logs
      try {
        const buildLogs = await apiFetch<{ timestamp: string; stream: string; line: string }[]>(`/v1/builds/${cleanId}/logs`, token);
        setLogs(buildLogs);
      } catch {}

      // Fetch artifacts
      try {
        const buildArtifacts = await apiFetch<{ name: string; target: string; sizeBytes: number; downloadUrl: string }[]>(`/v1/builds/${cleanId}/artifacts`, token);
        setArtifacts(buildArtifacts);
      } catch {}
    } catch (err) {
      setResult(err instanceof ApiError ? `${err.status}: ${err.message}` : String(err));
    }
  }

  // Clicking a row in the build list above sets this; it looks up the same
  // way typing an id in and submitting does, just triggered externally.
  useEffect(() => {
    if (selectedId) {
      setBuildId(selectedId);
      void lookup(selectedId);
    }
  }, [selectedId]);

  return (
    <section>
      <h2>Build status & details</h2>
      <form onSubmit={(e) => { e.preventDefault(); void lookup(buildId); }}>
        <input value={buildId} onChange={(e) => setBuildId(e.target.value)} placeholder="build id" required />
        <button type="submit">Check</button>
      </form>
      {result && <pre style={{ background: "#f4f4f4", padding: "1rem", overflowX: "auto", borderRadius: "4px" }}>{result}</pre>}

      {artifacts.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3>📦 Build Artifacts</h3>
          <ul>
            {artifacts.map((a, i) => (
              <li key={i}>
                <a href={a.downloadUrl} target="_blank" rel="noopener noreferrer"><strong>{a.name}</strong></a> ({a.target}, {(a.sizeBytes / 1024 / 1024).toFixed(1)} MB)
              </li>
            ))}
          </ul>
        </div>
      )}

      {logs.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h3>📋 Build Output & Compilation Logs</h3>
          <pre style={{ background: "#0c0e12", color: "#38bdf8", padding: "1rem", overflowX: "auto", maxHeight: "250px", borderRadius: "6px", fontFamily: "monospace", fontSize: "12px" }}>
            {logs.map((l) => `[${l.timestamp.slice(11, 19)}] ${l.line}`).join("\n")}
          </pre>
        </div>
      )}
    </section>
  );
}

export function App() {
  const [token, setToken] = useToken();
  const [tokenInput, setTokenInput] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  // Where /?checkout=success|cancel lands back after a Checkout redirect —
  // informational only. The plan itself changed (or didn't) from Stripe's
  // webhook independently of this redirect landing at all; usage below
  // reflects the real state once a refresh picks it up.
  const checkoutResult = new URLSearchParams(window.location.search).get("checkout");

  return (
    <main style={{ font: "14px/1.5 -apple-system, system-ui, sans-serif", maxWidth: "40rem", margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Carbon Cloud</h1>
      <p>
        <button onClick={() => setToken(null)}>Log out</button>
      </p>
      {checkoutResult === "success" && (
        <p style={{ color: "#16794e" }}>Checkout complete — the plan updates once payment is confirmed.</p>
      )}
      {checkoutResult === "cancel" && <p>Checkout cancelled — no charge made.</p>}
      <UsagePanel token={token} />
      <DeployForm token={token} onQueued={() => setRefreshKey((k) => k + 1)} />
      <BuildList token={token} refreshKey={refreshKey} onSelect={setSelectedId} />
      <StatusLookup token={token} selectedId={selectedId} />
    </main>
  );
}

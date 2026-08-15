// The v1 dashboard: paste a build id, see its status. Real API, not a mock —
// the full dashboard (org/build lists, auth, live logs) is a later phase;
// this is deliberately thin, not fake.

import { useState, type FormEvent } from "react";

export function App() {
  const [buildId, setBuildId] = useState("");
  const [result, setResult] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setResult("loading...");
    try {
      const res = await fetch(`/v1/builds/${encodeURIComponent(buildId.trim())}`);
      const body = await res.json();
      setResult(JSON.stringify(body, null, 2));
    } catch (error) {
      setResult(`request failed: ${error}`);
    }
  }

  return (
    <main style={{ font: "14px/1.5 -apple-system, system-ui, sans-serif", maxWidth: "40rem", margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Carbon Cloud</h1>
      <p>
        This is the v1 status page: paste a build id to see where it is. The
        full dashboard (org/build lists, auth, live logs) lands in a later
        phase — this is the real API, not a mock, so it's useful today even
        though it's thin.
      </p>
      <form onSubmit={onSubmit}>
        <input
          value={buildId}
          onChange={(e) => setBuildId(e.target.value)}
          placeholder="build id"
          required
          style={{ font: "inherit", padding: "0.4rem 0.6rem", width: "22rem" }}
        />
        <button type="submit" style={{ font: "inherit", padding: "0.4rem 0.6rem" }}>
          Check status
        </button>
      </form>
      {result !== null && (
        <pre style={{ background: "#f4f4f4", padding: "1rem", overflowX: "auto" }}>{result}</pre>
      )}
    </main>
  );
}

import { ServiceFailure } from "../framework/services/contracts";
export function Feedback({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const detail = error instanceof ServiceFailure ? error.detail : undefined;
  return (
    <section role="alert">
      <h2>{detail?.code?.replaceAll("_", " ") ?? "Unable to load"}</h2>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      {detail && (
        <small>
          Request: {detail.requestId}
          {detail.retryAfterMs
            ? ` · Retry after ${detail.retryAfterMs} ms`
            : ""}
        </small>
      )}
      {retry && (
        <p>
          <button onClick={retry}>Reload</button>
        </p>
      )}
    </section>
  );
}

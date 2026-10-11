// What must never reach a log, a metric label or a trace.
//
// The first line of defence is not to log values at all: a request is logged
// by its route, not its path, and never with its query, headers or body. This
// is the second line, for text that has to be logged, such as an error message
// from a dependency.

/** Every credential Carbon issues has a prefix and a fixed shape, so it can be recognized wherever it turns up. */
export const SECRET_SHAPES: readonly RegExp[] = [
  // Carbon's own: account, session, CSRF, browser, email, invitation, device, environment, service, personal, worker, lease, enrollment, operator, upload, transfer, recovery.
  /\b(?:ac|as|csrf|browser|ec|inv|dv|dc|ce|cs|pt|wc|wl|we|op|ru|bt|cr|cc|wk)_[A-Za-z0-9_-]{16,}/g,
  // Providers': Stripe keys and webhook secrets, GitHub tokens, AWS access keys.
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, /\bwhsec_[A-Za-z0-9]{8,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bAKIA[0-9A-Z]{16}\b/g,
  // Signed assertions and other JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // A credential in a URL, a bearer header, or a connection string.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi,
  // A PEM block.
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
];

/** Replaces anything shaped like a credential. Text that holds none comes back unchanged. */
export function redact(text: string): string {
  let result = text;
  for (const shape of SECRET_SHAPES) result = result.replace(shape, (match, first) => (typeof first === "string" && /^(Bearer|Basic)$/i.test(first) ? `${first} [redacted]` : typeof first === "string" && first.includes("://") ? `${first}:[redacted]@` : "[redacted]"));
  return result;
}

/** The fixed path words of Cloud, Database and Registry. A word missing from here only makes a route name coarser. */
const WORDS = new Set(`platform internal worker app operator billing updates registry storage api rest healthz readyz metrics orgs projects environments members settings access invitations preview accept
  account profile session sessions identities security email complete verify auth bootstrap challenges signout github start callback fresh fresh-auth devices device token device-authorizations review
  personal-credentials service-accounts credentials legacy-tokens workers repository-installations repository resolve proposal webhooks stripe audit events stream builds logs provenance artifacts
  signing-profiles releases channels realm users data imports exports list status cancel download changes blobs vectors graph functions executions schedules revisions invoke secrets operations
  registry-assertions service-assertions service-registry-assertions assertions authority lifecycle leases claim enroll function build uploads packages trust transfers public actions`.split(/\s+/));
const FILES = new Set(["manifest.json", "manifest.sig", "yanked.json"]);
const FAMILIES = new Set(["data", "blobs", "vectors", "graph", "registry"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The name of a path for logs and metric labels: identifiers become `:id`, anything shaped like a credential or
 * otherwise unrecognized becomes `:value`, and the query is dropped. A route has a small, fixed set of names
 * whatever is requested, so it can label a metric, and it carries nothing a customer or a credential put in the URL.
 */
export function routeOf(pathname: string): string {
  const segments = pathname.split("?")[0]!.split("/").filter(Boolean).slice(0, 12);
  const named = segments.map((segment, index) => {
    if (UUID.test(segment)) return ":id";
    // Only the API's own words are kept. A name a customer chose (an organization, a package, a channel, an object key) looks like a word too, so anything not on the list is a value.
    if (WORDS.has(segment) || /^v[0-9]{1,2}$/.test(segment) || FILES.has(segment)) return segment;
    // A command kind such as `rows.query`, but only where a command kind goes: straight after its family.
    if (/^[a-z]+\.[a-z]+$/.test(segment) && FAMILIES.has(segments[index - 1] ?? "")) return segment;
    return ":value";
  });
  return `/${named.join("/")}`;
}

// The browser's one way to reach Carbon Cloud. Every adapter goes through
// here, so every request carries the session cookie, the CSRF token and an
// idempotency key the same way, and every failure becomes a ServiceError
// instead of an exception.

import type { CommandOptions, ErrorCode, Result, ServiceError } from "../../../presentation/framework/services/contracts";

export const API = "/platform/v1";
const CODES: Record<string, ErrorCode> = {
  unauthenticated: "unauthenticated", forbidden: "forbidden", not_found: "not_found", conflict: "conflict", validation: "validation", rate_limited: "rate_limited",
  // The server's names for "not built or not switched on here" and "over a limit".
  capability: "unsupported_operation", quota: "quota_exceeded", unavailable: "unavailable", internal: "unavailable",
};
const STATUS: Record<number, ErrorCode> = { 400: "validation", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited", 501: "unsupported_operation" };

/** The part of `fetch` this uses. Narrower than the global, so a test or another runtime can supply it. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface LiveTransportOptions {
  /** Where the API is. Empty for the same origin the page was served from, which is what production uses. */
  readonly origin?: string;
  readonly fetch?: Fetch;
  /** The page's cookie string. The CSRF token is the one cookie the page is allowed to read. */
  readonly cookies?: () => string;
}

export const failure = (code: ErrorCode, message: string, requestId = ""): { ok: false; error: ServiceError } => ({ ok: false, error: { code, message, requestId } });
/** What an adapter answers for something the live service does not offer yet. It is an answer, not a fallback: nothing is simulated. */
export const unsupported = (what: string) => failure("unsupported_operation", `${what} is not connected to the live service yet.`);

export class LiveTransport {
  private readonly origin: string; private readonly send: Fetch; private readonly cookies: () => string;
  private readonly unauthenticated = new Set<() => void>();
  constructor(options: LiveTransportOptions = {}) {
    this.origin = options.origin ?? ""; this.send = options.fetch ?? ((input, init) => fetch(input, init));
    this.cookies = options.cookies ?? (() => (globalThis as { document?: { cookie?: string } }).document?.cookie ?? "");
  }

  /** Called whenever the server says the session is gone, so the page can drop everything it was showing. */
  onUnauthenticated(listener: () => void): () => void { this.unauthenticated.add(listener); return () => this.unauthenticated.delete(listener); }

  private csrf(): string {
    for (const part of this.cookies().split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === "__Host-carbon-csrf" || name === "carbon-csrf") return value.join("=");
    }
    return "";
  }

  private async request<T>(method: "GET" | "POST", path: string, body: unknown, options: Partial<CommandOptions> & { signal?: AbortSignal }): Promise<Result<T>> {
    let response: Response;
    try {
      response = await this.send(this.origin + path, {
        method, credentials: "same-origin", redirect: "error", signal: options.signal, cache: "no-store",
        headers: method === "GET" ? { accept: "application/json" } : {
          accept: "application/json", "content-type": "application/json", "x-csrf-token": this.csrf(),
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}), ...(options.expectedRevision ? { "if-match": options.expectedRevision } : {}),
        },
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      });
    } catch (cause) {
      if ((cause as { name?: string })?.name === "AbortError") return failure("cancelled", "The request was cancelled.");
      return failure("unavailable", "Carbon Cloud could not be reached. Check the connection and try again.");
    }
    const requestId = response.headers.get("x-request-id") ?? "";
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (response.ok) {
      if (payload === undefined) return failure("unavailable", "Carbon Cloud returned an unreadable answer.", requestId);
      return { ok: true, value: payload as T };
    }
    const error = (payload as { error?: { code?: unknown; message?: unknown; requestId?: unknown; fieldErrors?: unknown } } | undefined)?.error;
    const code = (typeof error?.code === "string" && CODES[error.code]) || STATUS[response.status] || "unavailable";
    if (code === "unauthenticated") for (const listener of this.unauthenticated) listener();
    const retry = Number(response.headers.get("retry-after"));
    const fields = error?.fieldErrors && typeof error.fieldErrors === "object" ? Object.fromEntries(Object.entries(error.fieldErrors as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string> : undefined;
    return { ok: false, error: { code, message: typeof error?.message === "string" ? error.message : "The request could not be completed.", requestId: typeof error?.requestId === "string" ? error.requestId : requestId,
      ...(fields && Object.keys(fields).length ? { fieldErrors: fields } : {}), ...(Number.isFinite(retry) && retry > 0 ? { retryAfterMs: retry * 1000 } : {}) } };
  }

  get<T>(path: string, signal?: AbortSignal): Promise<Result<T>> { return this.request<T>("GET", path, undefined, { signal }); }
  post<T>(path: string, body: unknown, options: Partial<CommandOptions> & { signal?: AbortSignal } = {}): Promise<Result<T>> { return this.request<T>("POST", path, body, options); }
}

/** `?limit=&cursor=` for a list. The live API pages by cursor only; sorting and filtering are not sent. */
export function pageQuery(page: { limit?: number; cursor?: string } | undefined, extra: Record<string, string | undefined> = {}): string {
  const query = new URLSearchParams();
  if (page?.limit) query.set("limit", String(page.limit)); if (page?.cursor) query.set("cursor", page.cursor);
  for (const [key, value] of Object.entries(extra)) if (value) query.set(key, value);
  const text = query.toString(); return text ? `?${text}` : "";
}

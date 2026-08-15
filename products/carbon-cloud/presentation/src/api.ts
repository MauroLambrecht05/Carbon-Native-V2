// A thin fetch wrapper — not a client library, just enough to keep the auth
// header and error handling out of every component.

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServices } from "../services/context";
import { useSession } from "../session/SessionProvider";
import type { Scope } from "../services/contracts";
export const scopeKey = (visibility: string, scope?: Scope) =>
  [
    "platform",
    visibility,
    scope?.orgId ?? null,
    scope?.projectId ?? null,
    scope?.environmentId ?? null,
  ] as const;
export function ScopeCache({
  scope,
  children,
}: {
  scope?: Scope;
  children: ReactNode;
}) {
  const services = useServices();
  const cache = useQueryClient();
  const { session } = useSession();
  const key = scopeKey(session?.visibilityKey ?? "visitor", scope);
  const encoded = JSON.stringify(key);
  const [stream, setStream] = useState("disconnected");
  useEffect(() => services.session.subscribe(change => {
    if (!change.security) void cache.invalidateQueries({ queryKey: key });
  }), [services, cache, encoded]);
  useLayoutEffect(
    () => () => {
      void cache.cancelQueries({ queryKey: key });
      cache.removeQueries({ queryKey: key });
    },
    [cache, encoded],
  );
  useEffect(() => {
    if (!scope || !session || session.audience !== "dashboard") return;
    const controller = new AbortController();
    let unsubscribe: (() => void) | undefined;
    // Retained events allow reconnection from the last cursor. Components see
    // invalidations only; customer payloads will stay inside their feature port.
    void services.events
      .subscribe({ scope, signal: controller.signal }, undefined, (message) => {
        setStream(message.state);
        if (message.state === "closed") {
          void cache.cancelQueries({ queryKey: key });
          cache.removeQueries({ queryKey: key });
        } else if (message.events.length || message.state === "gap")
          void cache.invalidateQueries({ queryKey: key });
      })
      .then((result) => {
        if (result.ok) {
          unsubscribe = result.value;
          if (controller.signal.aborted) unsubscribe();
        } else setStream(result.error.code);
      });
    return () => {
      controller.abort();
      unsubscribe?.();
    };
  }, [services, cache, encoded]);
  return (
    <>
      {scope && (
        <p className="muted" aria-live="polite">
          Local event stream: {stream}
        </p>
      )}
      {children}
    </>
  );
}

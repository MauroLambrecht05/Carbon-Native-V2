import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServices } from "../services/context";
import type { ServiceError, Session } from "../services/contracts";
interface SessionState {
  loading: boolean;
  session: Session | null;
  error?: ServiceError;
}
const Context = createContext<SessionState>({ loading: true, session: null });
export const useSession = () => useContext(Context);
export function SessionProvider({ children }: { children: ReactNode }) {
  const services = useServices();
  const cache = useQueryClient();
  const [state, setState] = useState<SessionState>({
    loading: true,
    session: null,
  });
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const reload = async () => {
      const request = ++generation;
      setState({ loading: true, session: null });
      await cache.cancelQueries();
      cache.clear();
      const result = await services.session.getSession();
      if (!disposed && request === generation)
        setState(
          result.ok
            ? { loading: false, session: result.value }
            : { loading: false, session: null, error: result.error },
        );
    };
    const unsubscribe = services.session.subscribe((change) => {
      if (change.security) void reload();
    });
    void reload();
    return () => {
      disposed = true;
      generation++;
      unsubscribe();
    };
  }, [services, cache]);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}

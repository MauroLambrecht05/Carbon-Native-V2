import { createContext, useContext } from "react";
import type { BrowserServices } from "./contracts";
export const ServicesContext = createContext<BrowserServices | null>(null);
export function useServices() {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("Browser services were not composed.");
  return services;
}

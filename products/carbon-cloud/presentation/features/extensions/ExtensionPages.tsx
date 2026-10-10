import { useLocation } from "react-router-dom";
import { resolveRoute } from "../../framework/routing/routes";
import { StoragePage } from "./StoragePages";
import { GraphPage, VectorsPage } from "./VectorGraphPages";
import { BackupsPage, MigrationsPage } from "./RecoveryPages";
import { RealtimePage } from "./RealtimePages";
import type { Props } from "./shared";

export function ExtensionPages(props: Props) {
  const path = useLocation().pathname, route = resolveRoute(path)!;
  if (!props.resolved.bindings.some(b => b.owner === "database" && b.state === "ready")) return <p>Enable and finish provisioning Database in environment overview to use data extensions.</p>;
  if (path.includes("/storage")) return <StoragePage key={path} {...props} bucketId={route.params.bucketId} />;
  if (path.includes("/vectors")) return <VectorsPage key={path} {...props} collectionId={route.params.collectionId} />;
  if (path.endsWith("/graph")) return <GraphPage {...props} />;
  if (path.endsWith("/migrations")) return <MigrationsPage {...props} />;
  if (path.endsWith("/backups")) return <BackupsPage {...props} />;
  return <RealtimePage {...props} />;
}

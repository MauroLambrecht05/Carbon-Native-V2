// AppImage generator for Linux
import { CarbonConfig } from "@carbon/contracts/app";

export async function generateAppImage(
  config: CarbonConfig,
  binaryPath: string,
  outputDir: string,
): Promise<string> {
  const appName = config.app.display_name || config.app.name;
  const version = config.app.version;

  const desktopFile = `[Desktop Entry]
Version=1.0
Type=Application
Name=${appName}
Exec=carbon-mini %U
Icon=${appName}
Categories=Utility;
Comment=${appName} ${version}
Terminal=false
`;

  const appRunScript = `#!/usr/bin/env bash
APPDIR="$(cd "$(dirname "$0")" && pwd)"
export LD_LIBRARY_PATH="$APPDIR/usr/lib:$LD_LIBRARY_PATH"
exec "$APPDIR/usr/bin/launcher" "$@"
`;

  return JSON.stringify({
    appDir: `${appName}.AppDir`,
    version,
    desktopFile,
    appRun: appRunScript,
    outputFile: `${outputDir}/${appName}-${version}.AppImage`,
  }, null, 2);
}

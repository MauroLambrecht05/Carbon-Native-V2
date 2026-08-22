// DEB installer generator for Linux
import { CarbonConfig } from "@carbon/contracts/app";

export async function generateDEB(
  config: CarbonConfig,
  binaryPath: string,
  outputDir: string,
): Promise<string> {
  const appName = config.app.name;
  const displayName = config.app.display_name || appName;
  const version = config.app.version;

  const controlFile = `Package: ${appName}
Version: ${version}
Architecture: amd64
Maintainer: Unknown
Homepage: https://example.com
Description: ${displayName}
 A desktop application built with Carbon
`;

  const preinst = `#!/bin/bash
# Pre-install script
exit 0
`;

  const postinst = `#!/bin/bash
# Post-install script
# Update alternatives if needed
exit 0
`;

  const prerm = `#!/bin/bash
# Pre-remove script
exit 0
`;

  const postrm = `#!/bin/bash
# Post-remove script
exit 0
`;

  return JSON.stringify({
    packageName: appName,
    version,
    control: controlFile,
    preinst,
    postinst,
    prerm,
    postrm,
    binDir: "usr/lib/carbon",
    outputFile: `${outputDir}/${appName}_${version}_amd64.deb`,
  }, null, 2);
}

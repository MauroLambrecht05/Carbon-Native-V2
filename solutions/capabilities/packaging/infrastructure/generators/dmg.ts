// DMG installer generator for macOS
import { CarbonConfig } from "@carbon/contracts/app";

/**
 * `Contents/Info.plist` for the `.app` bundle `buildDmg` assembles around
 * the runtime binary. `CFBundleIdentifier` is a placeholder reverse-DNS
 * string — `CarbonConfig` has no bundle-identifier field yet (nothing else
 * in this repo models one either: deb's control file says
 * `Maintainer: Unknown` for the same reason), so this derives one from the
 * app name rather than blocking bundling on a config field that doesn't
 * exist. `CFBundleExecutable` must match the binary's name inside
 * `Contents/MacOS/` exactly, or macOS refuses to launch the bundle.
 */
export function generateInfoPlist(config: CarbonConfig, executableName: string): string {
  const appName = config.app.display_name || config.app.name;
  const identifier = `com.carbon.${config.app.name}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>${appName}</string>
	<key>CFBundleDisplayName</key>
	<string>${appName}</string>
	<key>CFBundleIdentifier</key>
	<string>${identifier}</string>
	<key>CFBundleVersion</key>
	<string>${config.app.version}</string>
	<key>CFBundleShortVersionString</key>
	<string>${config.app.version}</string>
	<key>CFBundleExecutable</key>
	<string>${executableName}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
`;
}

export async function generateDMG(
  config: CarbonConfig,
  appPath: string,
  outputDir: string,
): Promise<string> {
  const appName = config.app.display_name || config.app.name;
  const version = config.app.version;

  const dmgConfig = {
    title: `${appName} ${version}`,
    icon: `${appName}.icns`,
    background: "background.png",
    "icon-size": 128,
    format: "UDZO",
    window: {
      x: 100,
      y: 100,
      width: 540,
      height: 380,
    },
    contents: [
      {
        x: 130,
        y: 220,
        type: "file",
        path: appPath,
      },
      {
        x: 410,
        y: 220,
        type: "link",
        path: "/Applications",
      },
    ],
  };

  return JSON.stringify(dmgConfig, null, 2);
}

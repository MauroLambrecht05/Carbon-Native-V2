// DMG installer generator for macOS
import { CarbonConfig } from "@carbon/contracts/app";

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

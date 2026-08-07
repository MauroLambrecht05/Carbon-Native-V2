// WiX 4 installer generator for Windows machine-wide installation
import { CarbonConfig } from "@carbon/contracts/app";

export async function generateWiX(
  config: CarbonConfig,
  binaryPath: string,
  outputDir: string,
): Promise<string> {
  const appName = config.app.display_name || config.app.name;
  const version = config.app.version;
  const appId = `${config.app.name}-${version}`;

  const wxsContent = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"
     xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui">

  <Product Id="*" Name="${appName}" Language="1033" Version="${version}.0"
           Manufacturer="Carbon" UpgradeCode="${appId}">

    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" />

    <Media Id="1" Cabinet="${appName}.cab" EmbedCab="yes" />

    <Feature Id="ProductFeature" Title="${appName} ${version}" Level="1">
      <ComponentRef Id="AppBinary" />
      <ComponentRef Id="LauncherStub" />
      <ComponentRef Id="CurrentToml" />
    </Feature>

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFilesFolder">
        <Directory Id="INSTALLFOLDER" Name="${appName}">
          <Directory Id="SLOTSFOLDER" Name="slots">
            <Directory Id="VERSIONSLOT" Name="${version}" />
          </Directory>
        </Directory>
      </Directory>
    </Directory>

    <Feature Id="ProductFeature" Title="${appName}">
      <ComponentRef Id="LauncherComponent" />
      <ComponentRef Id="BinaryComponent" />
    </Feature>

    <UI Id="WixUI_Minimal">
      <TextStyle Id="WixUI_Font_Normal" FaceName="Tahoma" Size="8" />
    </UI>

  </Product>

</Wix>`;

  return wxsContent;
}

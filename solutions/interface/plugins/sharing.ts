// @carbon/plugins/sharing — the native OS share sheet (Windows only for
// now — see the sharing plugin's own main.zig header comment). Does NOT
// cover sharing files, or any macOS/Linux equivalent.
//
// import { useSharing } from "@carbon/plugins/sharing";
// const { shareContent } = useSharing();
// shareContent({ title: "Check this out", text: "...", url: "https://..." });
//
// Returns once the OS's native Share flyout has been shown, not once the
// user has picked a target or completed the share.

import { useCallback } from "react";
import { shareContent as rawShareContent } from "carbon:sharing";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface ShareContentOptions {
  title?: string;
  text?: string;
  url?: string;
}

export interface UseSharingResult {
  shareContent: (options: ShareContentOptions) => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("shareContent");
}

export function useSharing(): UseSharingResult {
  const shareContent = useCallback((options: ShareContentOptions): boolean => {
    if (!pluginReady()) return false;
    return rawShareContent({ title: options.title ?? "", text: options.text ?? "", url: options.url ?? "" });
  }, []);

  return { shareContent, ready: pluginReady() };
}

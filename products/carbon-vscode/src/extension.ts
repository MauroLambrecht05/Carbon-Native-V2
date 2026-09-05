// Carbon Native VS Code Extension Entrypoint

export interface ExtensionContextMock {
  subscriptions: Array<{ dispose(): any }>;
}

export class CarbonExtensionService {
  private static instance: CarbonExtensionService;

  static getInstance(): CarbonExtensionService {
    if (!CarbonExtensionService.instance) {
      CarbonExtensionService.instance = new CarbonExtensionService();
    }
    return CarbonExtensionService.instance;
  }

  getStudioUrl(): string {
    const env = process.env.CARBON_STUDIO_URL;
    return env && env !== "undefined" ? env : "http://localhost:54322";
  }

  getRegistryUrl(): string {
    const env = process.env.CARBON_REGISTRY_URL;
    return env && env !== "undefined" ? env : "http://localhost:54323";
  }

  getDatabaseUrl(): string {
    const env = process.env.CARBON_DB_URL;
    return env && env !== "undefined" ? env : "http://localhost:54321";
  }

  async searchRegistry(query: string): Promise<any[]> {
    const url = `${this.getRegistryUrl()}/api/v1/plugins?search=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Registry error: ${res.statusText}`);
    const data = (await res.json()) as { plugins: any[] };
    return data.plugins || [];
  }

  formatInstallCommand(pluginName: string): string {
    return `carbon plugin add @registry/${pluginName}`;
  }

  getSnippetsList(): string[] {
    return [
      "carbon-app",
      "carbon-window",
      "carbon-titlebar",
      "carbon-vstack",
      "carbon-hstack",
      "carbon-card",
      "carbon-button",
      "carbon-input",
      "carbon-badge",
    ];
  }
}

export function activate(context?: ExtensionContextMock) {
  const service = CarbonExtensionService.getInstance();

  const commands = {
    "carbon.openStudio": () => {
      return { title: "Carbon Studio", url: service.getStudioUrl() };
    },
    "carbon.openDatabase": () => {
      return { title: "Carbon Database Studio", url: service.getDatabaseUrl() };
    },
    "carbon.searchPlugins": async (query: string) => {
      return await service.searchRegistry(query);
    },
  };

  return { service, commands };
}

export function deactivate() {}

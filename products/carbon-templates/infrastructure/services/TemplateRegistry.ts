// Template Registry: Curated desktop starter templates for Carbon Native applications.

export interface AppTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tags: string[];
  readonly files: Record<string, string>;
}

export class TemplateRegistry {
  private static instance: TemplateRegistry;
  private readonly templates = new Map<string, AppTemplate>();

  static getInstance(): TemplateRegistry {
    if (!TemplateRegistry.instance) {
      TemplateRegistry.instance = new TemplateRegistry();
      TemplateRegistry.instance.registerDefaultTemplates();
    }
    return TemplateRegistry.instance;
  }

  private registerDefaultTemplates(): void {
    // 1. Tray Daemon Template
    this.register({
      id: "tray-daemon",
      name: "System Tray Daemon",
      description: "Menubar / System Tray utility with background daemon mode and quick actions.",
      category: "desktop-utility",
      tags: ["tray", "daemon", "utility", "minimal"],
      files: {
        "carbon.toml": `[app]
name = "{{APP_NAME}}"
version = "0.1.0"
main = "src/main.ctsx"

[window]
title = "{{APP_NAME}}"
width = 420
height = 540
resizable = false
`,
        "package.json": `{
  "name": "{{APP_NAME}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "carbon dev",
    "build": "carbon build"
  }
}
`,
        "src/main.ctsx": `import { Window, Titlebar, VStack, HStack, Card, Heading, Text, Button, Badge } from "@carbon/native";

export default function App() {
  return (
    <Window title="{{APP_NAME}}" width={420} height={540}>
      <Titlebar title="{{APP_NAME}}" showControls={true} />
      <VStack padding={18} gap={14}>
        <HStack gap={8}>
          <Badge label="DAEMON ACTIVE" variant="success" />
          <Badge label="TRAY DOCKED" variant="info" />
        </HStack>
        <Card padding={16}>
          <Heading text="System Utility" level={2} />
          <Text text="This utility runs continuously in the background and can be minimized to your system tray." />
          <Button label="Toggle Background Mode" variant="primary" />
        </Card>
      </VStack>
    </Window>
  );
}
`,
      },
    });

    // 2. Database Studio Template
    this.register({
      id: "database-studio",
      name: "Database Studio Client",
      description: "Desktop admin console connected to Carbon Database with table browsing and query editor.",
      category: "developer-tool",
      tags: ["database", "sql", "studio", "dashboard"],
      files: {
        "carbon.toml": `[app]
name = "{{APP_NAME}}"
version = "0.1.0"
main = "src/main.ctsx"

[window]
title = "{{APP_NAME}} — Database Studio"
width = 1080
height = 720
`,
        "package.json": `{
  "name": "{{APP_NAME}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "carbon dev",
    "build": "carbon build"
  }
}
`,
        "src/main.ctsx": `import { Window, Titlebar, HStack, VStack, Card, Heading, Text, Button, TextInput } from "@carbon/native";

export default function App() {
  return (
    <Window title="{{APP_NAME}} — Database Studio" width={1080} height={720}>
      <Titlebar title="Carbon Database Console" showControls={true} />
      <HStack gap={16} padding={20}>
        <VStack width={220} gap={10}>
          <Heading text="Data Tables" level={3} />
          <Button label="public.users" variant="secondary" />
          <Button label="public.documents" variant="ghost" />
          <Button label="public.vectors" variant="ghost" />
        </VStack>
        <Card flex={1} padding={20}>
          <Heading text="SQL Query Editor" level={2} />
          <Text text="Execute raw SQL or semantic vector searches across your database." />
          <TextInput placeholder="SELECT * FROM users ORDER BY created_at DESC LIMIT 25;" />
          <Button label="Execute Query ⚡" variant="primary" />
        </Card>
      </HStack>
    </Window>
  );
}
`,
      },
    });

    // 3. Realtime Chat Template
    this.register({
      id: "realtime-chat",
      name: "Realtime Chat Client",
      description: "Desktop chat application with channel list, message feed, and WebSocket streaming.",
      category: "communication",
      tags: ["chat", "realtime", "websocket", "messages"],
      files: {
        "carbon.toml": `[app]
name = "{{APP_NAME}}"
version = "0.1.0"
main = "src/main.ctsx"

[window]
title = "{{APP_NAME}}"
width = 880
height = 640
`,
        "package.json": `{
  "name": "{{APP_NAME}}",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
`,
        "src/main.ctsx": `import { Window, Titlebar, HStack, VStack, Card, Heading, Text, Button, TextInput } from "@carbon/native";

export default function App() {
  return (
    <Window title="{{APP_NAME}}" width={880} height={640}>
      <Titlebar title="Carbon Chat — {{APP_NAME}}" showControls={true} />
      <HStack gap={14} padding={16}>
        <VStack width={200} gap={8}>
          <Heading text="Channels" level={3} />
          <Button label="# general" variant="secondary" />
          <Button label="# dev-room" variant="ghost" />
        </VStack>
        <VStack flex={1} gap={12}>
          <Card flex={1} padding={16}>
            <Heading text="# general" level={2} />
            <Text text="Welcome to the realtime chat stream." />
          </Card>
          <HStack gap={8}>
            <TextInput placeholder="Type a message..." flex={1} />
            <Button label="Send" variant="primary" />
          </HStack>
        </VStack>
      </HStack>
    </Window>
  );
}
`,
      },
    });

    // 4. Audio Station Template
    this.register({
      id: "audio-station",
      name: "Native Audio Station",
      description: "Audio player and visualizer desktop app with low-latency playback controls.",
      category: "media",
      tags: ["audio", "media", "player", "waveform"],
      files: {
        "carbon.toml": `[app]
name = "{{APP_NAME}}"
version = "0.1.0"
main = "src/main.ctsx"

[window]
title = "{{APP_NAME}}"
width = 720
height = 480
`,
        "package.json": `{
  "name": "{{APP_NAME}}",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
`,
        "src/main.ctsx": `import { Window, Titlebar, VStack, HStack, Card, Heading, Text, Button } from "@carbon/native";

export default function App() {
  return (
    <Window title="{{APP_NAME}}" width={720} height={480}>
      <Titlebar title="Audio Station" showControls={true} />
      <VStack padding={24} gap={16}>
        <Heading text="Now Playing" level={1} />
        <Card padding={20}>
          <Text text="Native low-latency audio stream buffer active." />
          <HStack gap={10} style={{ marginTop: 12 }}>
            <Button label="⏮ Prev" variant="secondary" />
            <Button label="▶ Play" variant="primary" />
            <Button label="⏭ Next" variant="secondary" />
          </HStack>
        </Card>
      </VStack>
    </Window>
  );
}
`,
      },
    });
  }

  register(template: AppTemplate): void {
    this.templates.set(template.id, template);
  }

  get(id: string): AppTemplate | undefined {
    return this.templates.get(id);
  }

  list(): AppTemplate[] {
    return Array.from(this.templates.values());
  }
}

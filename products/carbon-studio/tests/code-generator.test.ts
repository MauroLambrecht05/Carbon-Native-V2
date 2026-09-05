import { describe, expect, test } from "bun:test";
import { CodeGenerator, type StudioNode } from "../infrastructure/services/CodeGenerator.ts";

describe("CodeGenerator", () => {
  const codeGen = CodeGenerator.getInstance();

  test("generates idiomatic .ctsx code with imports and clean JSX formatting", () => {
    const tree: StudioNode = {
      id: "win-1",
      type: "Window",
      props: { title: "Test Window", width: 800, height: 600 },
      children: [
        {
          id: "card-1",
          type: "Card",
          props: { padding: 16 },
          children: [
            { id: "h-1", type: "Heading", props: { text: "Welcome", level: 1 } },
            { id: "b-1", type: "Button", props: { label: "Click", variant: "primary" } },
          ],
        },
      ],
    };

    const ctsx = codeGen.generateCtsx(tree, { appName: "DashboardApp" });

    // Imports
    expect(ctsx).toContain('import { Button, Card, Heading, Window } from "@carbon/native";');

    // Function name
    expect(ctsx).toContain("export default function DashboardApp()");

    // JSX Nodes
    expect(ctsx).toContain('<Window title="Test Window" width={800} height={600}>');
    expect(ctsx).toContain('<Card padding={16}>');
    expect(ctsx).toContain('<Heading text="Welcome" level={1} />');
    expect(ctsx).toContain('<Button label="Click" variant="primary" />');
  });

  test("provides pre-built blank and dashboard templates", () => {
    const templates = codeGen.getTemplates();
    expect(templates.blank).toBeDefined();
    expect(templates.blank.type).toBe("Window");

    expect(templates.dashboard).toBeDefined();
    expect(templates.dashboard.children?.length).toBeGreaterThan(0);
  });
});

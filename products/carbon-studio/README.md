# carbon-studio

The visual desktop app GUI designer and `.ctsx` code playground for Carbon Native.

## What it is

`carbon-studio` is a visual drag-and-drop studio (similar to Figma meets FlutterFlow) built specifically for Carbon Native desktop applications. Developers can visually assemble UI components, tweak properties in real time, preview under macOS, Windows 11, and Linux GNOME window frames, and copy or export ready-to-run `.ctsx` code.

## Features

- **Component Palette**: Drag-and-drop primitives including `Window`, `Titlebar`, `VStack`, `HStack`, `Card`, `Heading`, `Text`, `Button`, `TextInput`, `Badge`, and `Divider`.
- **Cross-Platform Window Frame Simulation**: Preview responsive layouts inside authentic window frames:
  - 🍎 macOS (traffic light window controls on the left, soft rounded corners)
  - 🪟 Windows 11 (minimize, maximize, close controls on the right, mica border)
  - 🐧 Linux GNOME (modern header bar)
- **Live Property Inspector**: Modify titles, button variants, labels, padding, and gaps on the fly.
- **One-Click `.ctsx` Exporter**: Generates clean, idiomatic Carbon Native TypeScript JSX code with automatic imports from `@carbon/native`.

## Running the Studio

```sh
bun run products/carbon-studio/main.ts
```

Spawns the Visual Studio at `http://localhost:54322`.

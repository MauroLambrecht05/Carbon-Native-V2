import { SectionHeading } from "../../components/SectionHeading.tsx";
import styles from "./Features.module.css";

const FEATURES = [
  {
    title: "Two rendering backends",
    description:
      "carbon-mini pairs QuickJS with tiny-skia for a small, fast footprint. carbon-blitz reaches for stylo and vello over wgpu when you need GPU-accelerated fidelity. Same app, pick your tradeoff.",
  },
  {
    title: "Real native integration",
    description:
      "Filesystem, native dialogs, clipboard, keychain, notifications, shell, PTY, windowing, networking — direct host functions, not a message bus pretending to be one.",
  },
  {
    title: "A real plugin system",
    description:
      "Native plugins are Zig, compiled to a shared library that exports C symbols. No callback table, no registration call — the export is the registration.",
  },
  {
    title: "Signed, and it stays that way",
    description:
      "Authenticode on Windows, codesign and notarization on macOS, Ed25519 manifests everywhere. Every artifact your users install is one your build actually signed.",
  },
  {
    title: "Auto-update that can't brick you",
    description:
      "A/B partition slots with a crash-counter rollback: three failed launches on a new version and the previous one comes back automatically. No support ticket required.",
  },
  {
    title: "TypeScript, your renderer",
    description:
      "Write JSX with Solid or React. It compiles to real scene-graph calls against the runtime — there's no DOM underneath to leak through.",
  },
];

export function Features() {
  return (
    <section id="features" className={styles.section}>
      <div className="container">
        <SectionHeading
          eyebrow="The runtime"
          title="Built like a runtime, not a wrapper"
          description="Carbon isn't a browser you ship inside your app. It's a native runtime with its own renderer, its own host functions, and its own release pipeline."
        />
        <div className={styles.grid}>
          {FEATURES.map((feature) => (
            <div key={feature.title} className={styles.card}>
              <h3 className={styles.cardTitle}>{feature.title}</h3>
              <p className={styles.cardDescription}>{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

import { CodeBlock } from "../../components/CodeBlock.tsx";
import { SectionHeading } from "../../components/SectionHeading.tsx";
import styles from "./QuickStart.module.css";

const LINES = [
  { text: "carbon create my-app" },
  { text: "cd my-app && carbon dev" },
  { text: "" },
  { text: "· window ready in 41ms", muted: true },
  { text: "" },
  { text: "carbon build --target dmg,deb,nsis" },
  { text: "carbon publish" },
  { text: "" },
  { text: "· signed my-app-1.0.0.dmg", muted: true },
  { text: "· manifest live, auto-update on", muted: true },
];

const STEPS = [
  { step: "01", title: "Create", body: "A name and a preset. Solid or React, mini or blitz." },
  { step: "02", title: "Build", body: "carbon-cli drives the pipeline: bundle, sign, package, per target." },
  { step: "03", title: "Ship", body: "Publish once. Every install already out there finds it." },
];

export function QuickStart() {
  return (
    <section id="quickstart" className={styles.section}>
      <div className="container">
        <SectionHeading
          eyebrow="Quick start"
          title="From nothing to signed installers"
          description="No config to hand-wire. carbon-cli owns the whole loop, from a fresh project to an artifact your users can double-click."
        />
        <div className={styles.layout}>
          <CodeBlock lines={LINES} title="carbon-cli" />
          <ol className={styles.steps}>
            {STEPS.map((s) => (
              <li key={s.step} className={styles.step}>
                <span className={styles.stepNumber}>{s.step}</span>
                <div>
                  <h3 className={styles.stepTitle}>{s.title}</h3>
                  <p className={styles.stepBody}>{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

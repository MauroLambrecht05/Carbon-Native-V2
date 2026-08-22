import { CodeBlock } from "../../components/CodeBlock.tsx";
import { SectionHeading } from "../../components/SectionHeading.tsx";
import styles from "./HowItWorks.module.css";

const STEPS = [
  {
    step: "01",
    title: "Sign up, mint a worker token",
    body: "One org, one org-scoped token to queue builds, one worker-scoped token to run them. A worker token only ever claims its own org's queue.",
  },
  {
    step: "02",
    title: "Queue a build",
    body: "carbon cloud deploy — a repo, a commit, the targets you want. It lands in a real Postgres queue, claimed atomically so two workers never grab the same job.",
  },
  {
    step: "03",
    title: "A worker does the work",
    body: "Clone, compile the runtime, package for the target — dpkg-deb, appimagetool, makensis, WiX, a real .app bundle in a .dmg — sign it, upload it.",
  },
  {
    step: "04",
    title: "Every install finds it",
    body: "The manifest your CLI already publishes to is the same one the build just updated. Nothing extra to configure on the client side.",
  },
];

const LINES = [
  { text: "carbon cloud signup --name \"My Org\"" },
  { text: "carbon cloud worker-token" },
  { text: "" },
  { text: "carbon cloud deploy --repo <git-url> \\" },
  { text: "--commit <sha> --target deb,dmg,nsis", continuation: true },
  { text: "carbon cloud status <build-id>" },
  { text: "" },
  { text: "· claimed by worker linux-1", muted: true },
  { text: "· succeeded — 3 artifacts uploaded", muted: true },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className={styles.section}>
      <div className="container">
        <SectionHeading
          eyebrow="How it works"
          title="Four steps, no glue code"
          description="carbon-cli talks to Carbon Cloud the same way it talks to your local build — same commands, same manifest, a queue instead of your own machine."
        />
        <div className={styles.layout}>
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
          <CodeBlock lines={LINES} title="carbon cloud" />
        </div>
      </div>
    </section>
  );
}

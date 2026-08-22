import { SectionHeading } from "../../components/SectionHeading.tsx";
import styles from "./CloudFeatures.module.css";

const FEATURES = [
  {
    title: "A real build queue",
    description:
      "Postgres, FOR UPDATE SKIP LOCKED. Two workers polling at once cannot claim the same job — the loser gets null back and tries again next tick.",
  },
  {
    title: "Workers per platform",
    description:
      "Linux, Windows and macOS workers each package for their own target — dpkg-deb and appimagetool, makensis and WiX, a real .app bundle in a signed, notarized .dmg.",
  },
  {
    title: "Tokens scoped to your org",
    description:
      "An org token queues builds and reads usage. A worker token claims and completes — only the queue of the org that minted it, even on a shared worker fleet.",
  },
  {
    title: "Usage metering, not guesswork",
    description:
      "Every build's wall time is recorded against your org from the moment it's queued. Go over your plan's included minutes and new builds are refused, not silently throttled.",
  },
  {
    title: "Self-hosted from the start",
    description:
      "docker compose up brings up Postgres, object storage, the control plane and a worker. Your artifacts live in your storage, not a vendor's.",
  },
  {
    title: "The dashboard, or the CLI",
    description:
      "Queue a build, watch its status, upgrade a plan — from a browser or from carbon cloud deploy / status / list. Same API underneath either way.",
  },
];

export function CloudFeatures() {
  return (
    <section className={styles.section}>
      <div className="container">
        <SectionHeading
          eyebrow="Under the hood"
          title="Infrastructure you'd have to build anyway"
          description="Carbon Cloud isn't a thin wrapper around a shell script. It's the queue, the workers and the token model a real release pipeline needs."
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

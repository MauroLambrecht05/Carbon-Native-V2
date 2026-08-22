import { Link } from "react-router-dom";
import { Button } from "../../components/Button.tsx";
import styles from "./CloudTeaser.module.css";

const POINTS = [
  "Push a commit, get a signed installer for every target you asked for",
  "Real build queue on Postgres — atomic claims, no double-builds",
  "Every install stays current through the same manifest your CLI publishes to",
  "Self-hosted: your infrastructure, your workers, your data",
];

export function CloudTeaser() {
  return (
    <section className={styles.section}>
      <div className={`container ${styles.inner}`}>
        <div className={styles.copy}>
          <span className={styles.eyebrow}>Carbon Cloud</span>
          <h2 className={styles.title}>
            The release platform, without the babysitting
          </h2>
          <p className={styles.body}>
            Carbon Cloud is the build-and-release loop Vercel does for a
            Next.js deploy, built for native apps instead: queue a build,
            a worker compiles and signs it for real, and the manifest your
            installed apps already poll for updates just starts serving it.
          </p>
          <ul className={styles.points}>
            {POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <Button href="/cloud" variant="primary" size="lg" className={styles.cta}>
            See how Carbon Cloud works
          </Button>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelRow}>
            <span className={styles.panelDot} data-status="done" />
            <span>demo-app · linux · deb</span>
            <span className={styles.panelStatus}>succeeded</span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelDot} data-status="done" />
            <span>demo-app · macos · dmg</span>
            <span className={styles.panelStatus}>succeeded</span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelDot} data-status="active" />
            <span>demo-app · windows · nsis</span>
            <span className={styles.panelStatus} data-active="true">
              building&hellip;
            </span>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelDot} data-status="queued" />
            <span>demo-app · windows · wix</span>
            <span className={styles.panelStatus}>queued</span>
          </div>
        </div>
      </div>
    </section>
  );
}

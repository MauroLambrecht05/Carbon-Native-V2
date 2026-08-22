import { InstallCommand } from "../../components/InstallCommand.tsx";
import styles from "./Hero.module.css";

export function Hero() {
  return (
    <section className={styles.hero}>
      <div className={`container ${styles.inner}`}>
        <span className={styles.eyebrow}>Now shipping Carbon Cloud</span>
        <h1 className={styles.headline}>
          Native apps.
          <br />
          One runtime.
        </h1>
        <p className={styles.subhead}>
          Build desktop apps in TypeScript that run as real native binaries —
          not a bundled browser. Two rendering backends, a real plugin
          system, signed installers, and auto-update that doesn&rsquo;t
          brick your users.
        </p>
        <div className={styles.actions}>
          <InstallCommand command="carbon create my-app" />
        </div>
        <div className={styles.secondaryLinks}>
          <a href="#quickstart" className={styles.secondaryLink}>
            See the full quick start &rarr;
          </a>
          <span className={styles.linkDivider} aria-hidden="true">
            &middot;
          </span>
          <a href="/cloud" className={styles.secondaryLink}>
            Explore Carbon Cloud &rarr;
          </a>
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statValue}>2</span>
            <span className={styles.statLabel}>rendering backends</span>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <span className={styles.statValue}>3</span>
            <span className={styles.statLabel}>platforms, one CLI</span>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <span className={styles.statValue}>0</span>
            <span className={styles.statLabel}>bundled browsers</span>
          </div>
        </div>
      </div>
      <div className={styles.glow} aria-hidden="true" />
    </section>
  );
}

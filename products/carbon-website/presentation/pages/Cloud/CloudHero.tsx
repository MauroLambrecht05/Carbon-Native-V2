import { Button } from "../../components/Button.tsx";
import styles from "./CloudHero.module.css";

export function CloudHero() {
  return (
    <section className={styles.hero}>
      <div className={`container ${styles.inner}`}>
        <span className={styles.eyebrow}>Carbon Cloud</span>
        <h1 className={styles.headline}>
          Push a repo.
          <br />
          Get a signed release.
        </h1>
        <p className={styles.subhead}>
          The build-and-release loop Vercel does for a Next.js deploy, built
          for native apps: queue a build, a worker compiles and signs it for
          real, and every install already out there finds the update on its
          own. Self-hosted — your infrastructure, your workers.
        </p>
        <div className={styles.actions}>
          <Button href="#how-it-works" variant="primary" size="lg">
            See how it works
          </Button>
          <Button href="#pricing" variant="secondary" size="lg">
            Plans
          </Button>
        </div>
      </div>
      <div className={styles.glow} aria-hidden="true" />
    </section>
  );
}

import { Button } from "../../components/Button.tsx";
import styles from "./FinalCta.module.css";

export function FinalCta() {
  return (
    <section className={styles.section}>
      <div className={`container ${styles.inner}`}>
        <h2 className={styles.title}>Ship something native.</h2>
        <p className={styles.body}>
          One CLI to build it, one runtime to run it, one platform to release
          it.
        </p>
        <div className={styles.actions}>
          <Button href="#quickstart" variant="primary" size="lg">
            Get started
          </Button>
          <Button href="/cloud" variant="secondary" size="lg">
            Explore Carbon Cloud
          </Button>
        </div>
      </div>
    </section>
  );
}

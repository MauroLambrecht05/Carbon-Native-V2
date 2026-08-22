import styles from "./Logo.module.css";

interface LogoProps {
  readonly size?: number;
  readonly withWordmark?: boolean;
}

export function Logo({ size = 28, withWordmark = true }: LogoProps) {
  return (
    <span className={styles.logo}>
      <img src="/assets/brand/logo.png" alt="Carbon" width={size} height={size} />
      {withWordmark && <span className={styles.wordmark}>Carbon</span>}
    </span>
  );
}

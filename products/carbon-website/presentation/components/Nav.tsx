import { Link } from "react-router-dom";
import { Logo } from "./Logo.tsx";
import { Button } from "./Button.tsx";
import styles from "./Nav.module.css";

const LINKS = [
  { href: "/#features", label: "Runtime" },
  { href: "/cloud", label: "Cloud" },
  { href: "/#quickstart", label: "Docs" },
];

export function Nav() {
  return (
    <header className={styles.nav}>
      <div className={`container ${styles.inner}`}>
        <Link to="/" aria-label="Carbon home">
          <Logo />
        </Link>
        <nav className={styles.links} aria-label="Primary">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className={styles.link}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className={styles.actions}>
          <Button href="#quickstart" variant="ghost" size="md">
            Documentation
          </Button>
          <Button href="#quickstart" variant="secondary" size="md">
            Get started
          </Button>
        </div>
      </div>
    </header>
  );
}

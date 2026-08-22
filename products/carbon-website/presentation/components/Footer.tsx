import { Link } from "react-router-dom";
import { Logo } from "./Logo.tsx";
import styles from "./Footer.module.css";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Runtime", href: "/#features" },
      { label: "CLI", href: "/#quickstart" },
      { label: "Cloud", href: "/cloud" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "/#quickstart" },
      { label: "Plugin SDK", href: "/#features" },
    ],
  },
];

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.inner}`}>
        <div className={styles.brand}>
          <Link to="/">
            <Logo size={24} />
          </Link>
          <p className={styles.tagline}>
            A native app runtime, built to feel like one.
          </p>
        </div>
        <div className={styles.columns}>
          {COLUMNS.map((col) => (
            <div key={col.title} className={styles.column}>
              <h3 className={styles.columnTitle}>{col.title}</h3>
              <ul>
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href} className={styles.columnLink}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className={`container ${styles.bottom}`}>
        <span>&copy; {new Date().getFullYear()} Carbon Native.</span>
      </div>
    </footer>
  );
}

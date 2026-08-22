import { Link } from "react-router-dom";
import { SectionHeading } from "../../components/SectionHeading.tsx";
import styles from "./ProductSuite.module.css";

const PRODUCTS = [
  {
    name: "Runtime",
    tag: "products/carbon",
    description:
      "The native runtime your app actually ships. Two backends, 139 host functions, one plugin ABI.",
    href: "/#features",
  },
  {
    name: "CLI",
    tag: "products/carbon-cli",
    description:
      "init, build, run, dev, publish, plugin, doctor — the whole developer loop behind one command.",
    href: "/#quickstart",
  },
  {
    name: "Cloud",
    tag: "products/carbon-cloud",
    description:
      "Push a repo, get a signed installer and a working auto-update. Self-hosted, like Vercel for a Carbon app.",
    href: "/cloud",
    featured: true,
  },
];

export function ProductSuite() {
  return (
    <section className={styles.section}>
      <div className="container">
        <SectionHeading
          eyebrow="The suite"
          title="One team's tools, not three vendors'"
          description="The runtime, the CLI and the release platform are built together, against the same contracts."
        />
        <div className={styles.grid}>
          {PRODUCTS.map((product) => (
            <Link
              key={product.name}
              to={product.href}
              className={styles.card}
              data-featured={product.featured || undefined}
            >
              <span className={styles.tag}>{product.tag}</span>
              <h3 className={styles.name}>{product.name}</h3>
              <p className={styles.description}>{product.description}</p>
              <span className={styles.arrow} aria-hidden="true">
                &rarr;
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

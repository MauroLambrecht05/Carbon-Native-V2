import { Button } from "../../components/Button.tsx";
import { SectionHeading } from "../../components/SectionHeading.tsx";
import styles from "./Pricing.module.css";

const PLANS = [
  {
    name: "Free",
    price: "$0",
    tagline: "For trying it out, or a project that doesn't build often.",
    minutes: "60 build-minutes / month",
    features: [
      "Every installer target",
      "Full auto-update pipeline",
      "Dashboard + CLI access",
    ],
    cta: "Get started",
    variant: "secondary" as const,
  },
  {
    name: "Pro",
    price: "Set by your host",
    tagline: "Carbon Cloud is self-hosted — whoever runs it sets this plan's price via Stripe.",
    minutes: "6,000 build-minutes / month",
    features: [
      "Everything in Free",
      "Priority queue position",
      "Usage alerts before you hit the limit",
    ],
    cta: "Talk to your Carbon Cloud operator",
    variant: "primary" as const,
    featured: true,
  },
];

export function Pricing() {
  return (
    <section id="pricing" className={styles.section}>
      <div className="container">
        <SectionHeading
          eyebrow="Plans"
          title="Metered on build-minutes, nothing else"
          description="Self-hosted software doesn't have a list price. What's fixed is what a plan includes — the dollar figure is whoever runs your Carbon Cloud instance's to set."
        />
        <div className={styles.grid}>
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={styles.card}
              data-featured={plan.featured || undefined}
            >
              <h3 className={styles.name}>{plan.name}</h3>
              <div className={styles.price}>{plan.price}</div>
              <p className={styles.tagline}>{plan.tagline}</p>
              <div className={styles.minutes}>{plan.minutes}</div>
              <ul className={styles.features}>
                {plan.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <Button href="/#quickstart" variant={plan.variant} size="md" className={styles.cta}>
                {plan.cta}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

import type { AnchorHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

interface ButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly variant?: "primary" | "secondary" | "ghost";
  readonly size?: "md" | "lg";
  readonly children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [styles.button, styles[variant], styles[size], className]
    .filter(Boolean)
    .join(" ");
  return (
    <a className={classes} {...rest}>
      {children}
    </a>
  );
}

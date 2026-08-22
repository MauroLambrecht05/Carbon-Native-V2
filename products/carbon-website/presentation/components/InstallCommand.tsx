import { useState } from "react";
import styles from "./InstallCommand.module.css";

interface InstallCommandProps {
  readonly command: string;
}

/** The big, single-line, copyable command a landing page leads with — the
 * thing this site was missing: every command sample lived three sections
 * down, and none of them actually copied anything. */
export function InstallCommand({ command }: InstallCommandProps) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button type="button" className={styles.command} onClick={onCopy}>
      <span className={styles.prompt}>$</span>
      <code className={styles.text}>{command}</code>
      <span className={styles.copyIcon} data-copied={copied || undefined}>
        {copied ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 8.5L6.5 12L13 4.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect
              x="5.5"
              y="5.5"
              width="8"
              height="8"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M3 10V3.5C3 2.67157 3.67157 2 4.5 2H10"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        )}
      </span>
      <span className={styles.hint}>{copied ? "Copied!" : "Copy"}</span>
    </button>
  );
}

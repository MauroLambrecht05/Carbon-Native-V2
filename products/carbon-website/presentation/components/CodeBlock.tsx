import { useState } from "react";
import styles from "./CodeBlock.module.css";

interface CodeLine {
  readonly text: string;
  /** Dimmed output text — no prompt, no continuation indent. */
  readonly muted?: boolean;
  /** A wrapped continuation of the previous command — indented, no prompt, full brightness. */
  readonly continuation?: boolean;
}

interface CodeBlockProps {
  readonly lines: readonly CodeLine[];
  readonly title?: string;
}

export function CodeBlock({ lines, title = "Terminal" }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  // Only the actual commands get copied — not blank spacer lines, not the
  // muted "· ..." output lines. A wrapped `\` continuation joins its
  // previous line with a space so the copied text is one runnable command.
  async function onCopy() {
    const runnable = lines.filter((l) => l.text && !l.muted);
    let text = "";
    for (const line of runnable) {
      if (line.continuation) {
        text = `${text.replace(/\s*\\$/, "")} ${line.text}`;
      } else {
        text += (text ? "\n" : "") + line.text;
      }
    }
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className={styles.block}>
      <div className={styles.chrome}>
        <span className={styles.dot} data-color="red" />
        <span className={styles.dot} data-color="yellow" />
        <span className={styles.dot} data-color="green" />
        <span className={styles.title}>{title}</span>
        <button
          type="button"
          className={styles.copyButton}
          onClick={onCopy}
          aria-label="Copy commands"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className={styles.pre}>
        {lines.map((line, i) => (
          <div
            key={i}
            className={line.muted ? styles.muted : styles.line}
            data-continuation={line.continuation || undefined}
          >
            {!line.muted && !line.continuation && (
              <span className={styles.prompt}>$</span>
            )}
            <span>{line.text}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

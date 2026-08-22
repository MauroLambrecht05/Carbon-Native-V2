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
  return (
    <div className={styles.block}>
      <div className={styles.chrome}>
        <span className={styles.dot} data-color="red" />
        <span className={styles.dot} data-color="yellow" />
        <span className={styles.dot} data-color="green" />
        <span className={styles.title}>{title}</span>
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

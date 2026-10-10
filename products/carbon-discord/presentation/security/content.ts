const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bcc_[A-Za-z0-9._-]{8,}\b/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{10,}\b/g,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "[REDACTED SECRET]"), value);
}

export function safeUserText(value: string, maxLength: number): string {
  return redactSecrets(value.trim()).replaceAll("@everyone", "@\u200beveryone").replaceAll("@here", "@\u200bhere").slice(0, maxLength);
}

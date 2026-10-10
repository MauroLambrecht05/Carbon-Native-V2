export interface TotpVerifier {
  generateSecret(): string;
  /** Returns the matched time counter, including bounded clock skew, or null. */
  verify(secret: string, code: string, now: Date): number | null;
}

export interface WrappedSecretKey {
  readonly keyId: string;
  readonly ciphertext: string;
}

/** Hosted implementations keep wrapping keys in KMS/HSM custody. */
export interface SecretKeyCustodian {
  wrap(dataKey: Uint8Array, context: string): Promise<WrappedSecretKey>;
  unwrap(key: WrappedSecretKey, context: string): Promise<Uint8Array>;
}

export interface ProtectedSecret {
  readonly wrappingKeyId: string;
  readonly envelope: string;
}

export interface SecretProtector {
  seal(plaintext: string, context: string): Promise<ProtectedSecret>;
  open(secret: ProtectedSecret, context: string): Promise<string>;
}

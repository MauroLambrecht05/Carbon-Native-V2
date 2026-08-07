# security

Crypto tokens and signature envelopes.

**Agreement** wire (`schema/security.fbs`) · **Honoured by** anything that
signs or verifies. **Breaking it** invalidates signatures: a verifier that
cannot parse an envelope cannot check it. This changes with the signing format,
never independently — see `capabilities/signing`.

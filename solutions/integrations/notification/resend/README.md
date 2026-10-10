# Resend account notification adapter

Implements the identity capability's notification port using Resend's HTTPS email
API. Composition supplies a sending API key and verified sender address. The
outbox row ID supplies a stable idempotency key; each attempt sends exactly the
same payload. Requests time out before the outbox lease expires. Provider bodies
are never included in exceptions.

The adapter follows the [send email API](https://resend.com/docs/api-reference/emails/send-email)
and [idempotency contract](https://resend.com/docs/dashboard/emails/idempotency-keys).
The queue's 15-minute message lifetime is shorter than the provider's 24-hour
idempotency retention window. Resend credentials do not enter browser bundles.

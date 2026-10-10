# Slice 9: Billing and platform operators

Implemented against sections 17–18 and slice 9 of section 22.2 in the
[platform plan](platform-frontend-plan.md). Prices, invoices, provider events,
workers, reviews and operational incidents are explicit local fixtures.

## Customer billing and lifecycle

- `O/billing` models free/pro subscription states, checkout pending state,
  idempotent simulated provider outcomes, cancellation/resume, fictional
  payment metadata, budgets, local invoice downloads, downgrade conflicts and
  organization deletion retention/recovery.
- `O/usage` separates metered, estimated and unavailable values and supports a
  project filter without exposing project resources to a Billing-only member.
- `E/settings/limits` projects organization entitlements into the selected
  environment and states the consequence of each limit.
- Project settings support reversible archive state. Organization deletion is
  scheduled behind dependency checks and a seven-day local recovery window.

Build-minute hard caps reject new charged builds with `quota_exceeded`; they do
not delete existing artifacts. Warning/blocked budgets create per-account local
notifications. Subscription upgrades happen only after the simulated provider
event, never from a return URL.

## Operator area

`/operations` uses `OperatorService`, a port that accepts only the separate
operator audience. It includes failed/stuck jobs, managed Windows workers,
Registry review, trust rotation/revocation, customer suspension metadata,
operator audit and immutable billing adjustments. Customer memberships cannot
grant this audience, and operator organization records always report
`customerDataAccess: false`.

Operator retry retains the customer resource and increments the attempt.
Worker drain retains leases until acknowledgement. Registry approval remains
distinct from signature validity. Suspension blocks charged configuration,
data-write and release actions while leaving authorized metadata and recovery
visible.

## Verification

`tests/browser/operations.test.ts` covers provider-event state, Billing-only
visibility, persistent budgets, build blocking, notifications, operator
audience separation, revisions/audit reasons, suspension and reversible
lifecycle transitions. Presentation tests cover billing and direct operator
routes.

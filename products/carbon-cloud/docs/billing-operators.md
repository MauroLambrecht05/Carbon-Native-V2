# Billing, quotas, operators and deletion gates

What Cloud knows about an organization's subscription, how charged work is
admitted and metered, what Cloud's own operators can do, and what stops a
deletion from becoming final. This document describes what exists after
Phase 16. Storage is Cloud migration `0031_billing_operators.sql`.

Backup and restore, which the plan puts in this phase, are **not built**
(G-135).

## Billing

Cloud keeps its own picture of each organization's subscription. The picture
changes only when the payment provider says so in a signed event.

### States

| State | Meaning | Plan the organization gets |
|---|---|---|
| `free` | Never subscribed | free |
| `checkout_pending` | A checkout was started and has not completed | free |
| `active` | Subscribed and paid | the paid plan |
| `past_due` | A payment failed; the provider is still trying | the paid plan |
| `cancel_scheduled` | Cancelled at the end of the paid period | the paid plan |
| `ended` | The provider ended it | free |

A subscription that is late on payment keeps its plan until the provider ends
it (G-137).

### Checkout

`POST /platform/v1/orgs/{id}/billing` with `{ "kind": "checkout", "plan": "pro" }`
needs `billing.manage`. Cloud asks the provider for a checkout session,
remembers which organization the session belongs to, and returns the provider's
page.

Starting a checkout grants nothing. Returning from the provider's page grants
nothing. Only the provider's signed `checkout.session.completed` event for that
session grants the plan.

### Provider events

The provider delivers to `POST /billing/v1/webhooks/stripe`.

- **The signature is the only credential.** It is checked over the exact bytes
  received, with a five-minute tolerance, before anything is read or stored.
  Two signing secrets are accepted while one is being rotated.
- **Each event is applied at most once.** Its provider identifier is written to
  an inbox in the same transaction as everything it changes. A redelivery finds
  the row and answers `200` without doing anything. A failure part-way leaves
  no row, so the provider's retry is handled as a first delivery.
- **The provider's time decides, not the order of arrival.** An event older
  than the newest one already applied is recorded as `stale` and changes
  nothing. The same holds per invoice.
- **A status event cannot create a plan.** `customer.subscription.updated`
  moves a subscription that a checkout created; on a free or ended one it
  changes nothing.
- **Events Cloud cannot tie to an organization are kept.** They are recorded as
  `unmatched` for an operator to look at. Nothing resolves them yet (G-138).

| Event | Effect |
|---|---|
| `checkout.session.completed` | `active`, on the plan of the checkout it completes |
| `customer.subscription.updated` | `active`, `cancel_scheduled`, `past_due` or `ended`, from the provider's status |
| `customer.subscription.deleted` | `ended` |
| `invoice.finalized`, `.paid`, `.payment_failed`, `.voided` | Invoice metadata; a failed payment moves `active` to `past_due`, a payment moves `past_due` to `active` |

Invoices are stored as metadata and a link to the provider's own invoice page.
Cloud keeps no copy of the document. A link that is not `https` is dropped.

### Who sees what

`GET /platform/v1/orgs/{id}/billing` returns the subscription, this month's
usage per meter and the last 24 invoices. It needs `billing.manage`, which is
its own permission:

- a member with the Billing role sees this and nothing of the projects;
- a Developer sees projects and nothing of this.

Everything in it is an aggregate. Nothing names a project or what is in one.

## Quotas and metering

### Meters

| Meter | One unit is | Free plan | Pro plan |
|---|---|---|---|
| `build_minutes` | A minute a build attempt ran | 60 a month | 6,000 a month |
| `function_invocations` | A function execution a worker started | 10,000 a month | 1,000,000 a month |

Storage and egress are not metered (G-139). Months are calendar months in UTC.

### Admission

Charged work is admitted before it starts, under one lock per organization, so
requests that arrive together across environments are counted one after
another.

What counts against the allowance is what was used this month, plus what work
in progress has reserved, plus the work being asked for:

- a queued or running function execution holds one invocation;
- a queued or running build holds its reserved minutes.

Work that ends gives back what it did not use. An execution cancelled before a
worker took it costs nothing.

Past the plan's allowance, new charged work answers `429`. Existing resources
are not touched.

### Metering

When charged work ends, one usage event is written. Its source key names the
thing that happened (`build:{id}`, `function-execution:{id}`), and the key is
unique, so recording it again records nothing. An execution that a lost worker
ran twice is one invocation.

Usage events cannot be updated or deleted.

### Budgets

An organization can set a monthly budget per meter, inside what its plan
includes: `{ "kind": "budget", "meter": "...", "monthlyLimit": N, "mode": "cap" | "warn" }`.

- **cap** refuses new charged work past the line with `429`.
- **warn** lets the work through and writes one `billing.budget.warning` event
  the first time the line is crossed in a month. Nothing sends that event to
  anyone yet (G-140).

## Operators

Operators are Cloud's own staff accounts. They are separate from customer
accounts: an operator holds no membership, and an operator credential opens
nothing but the operator API.

**There is no impersonation.** No operator action produces a customer session
or reads a customer's projects or data, and there is no code path that could.

### Accounts and roles

Operators are created from the command line by whoever administers Cloud:

```
bun run operator-admin create <email> <name> <role[,role]>
bun run operator-admin credential <operatorId> [hours]
bun run operator-admin disable <operatorId>
```

A credential (`op_...`) is printed once and stored only as a hash. It lasts 8
hours unless told otherwise, at most 30 days. There is no operator sign-in with
a second factor (G-141).

| Role | Can |
|---|---|
| `support` | Suspend and reinstate organizations |
| `security` | Suspend and reinstate; place and release legal holds |
| `recovery` | Request, approve and reject early deletion |

### The API

It is on when `CARBON_OPERATORS=enabled`. A request that carries a cookie or an
`Origin` header is refused: this is not for browsers.

| Request | Answer |
|---|---|
| `GET /operator/v1/orgs/{id}` | State, revision, legal holds, pending request, what blocks deletion, and counts of what would be kept |
| `GET /operator/v1/orgs/{id}/actions` | What operators did to it |
| `POST /operator/v1/orgs/{id}` | One command |

An operator sees an organization's identifier, slug, state and counts. Nothing
of its members, projects or data.

Every command needs:

- the role for it;
- a reason of at least ten characters;
- for commands that change the organization's state, the revision the operator
  was looking at. If it moved, the command is refused.

| Command | Role | Effect |
|---|---|---|
| `suspend` | support, security | Active to suspended. Members can still sign in and read; writes are refused |
| `reinstate` | support, security | Suspended to active |
| `hold-place` | security | Places a legal hold |
| `hold-release` | security | Releases one |
| `delete-now-request` | recovery | Asks to finish a scheduled deletion early |
| `delete-now-approve`, `-reject` | recovery | Decides such a request |

### The record

Every operator action is written to `operator_actions`: who, in which role,
what, to which organization, why, and under which approval. The table cannot be
updated or deleted.

The organization's own event log gets an entry too
(`operator.organization.suspended`, and so on). It says that Cloud acted and
what it did. It does not name the operator.

## Legal holds

While an organization has a legal hold:

- the deletion timer does not make the organization, or any project or
  environment in it, finally deleted, however long its window has been over;
- early deletion can be neither requested nor approved.

Releasing the hold lets the timer act again.

## Deletion gates

Deletion is scheduled by the organization's owner and is recoverable until it
is final ([resource-lifecycle.md](resource-lifecycle.md)). An operator cannot
start one.

### By the timer

The lifecycle sweeper makes an organization's deletion final only when all of
these hold:

- its recovery window has passed;
- it has no legal hold;
- it has no subscription the provider may still charge (`active`, `past_due`
  or `cancel_scheduled`).

Otherwise it stays pending. `GET /operator/v1/orgs/{id}` lists which of these
is in the way.

### Early, by two operators

Finishing a scheduled deletion before its window ends is irreversible, so it
takes two operators with the `recovery` role.

1. One requests it. The request records the organization's revision and lapses
   after 24 hours.
2. A **different** operator approves or rejects it. The database itself refuses
   a row where the same operator did both.
3. At approval, every gate is checked again: the organization is still
   scheduled for deletion, nothing about it changed since the request, there is
   no legal hold, there is no chargeable subscription, and the request has not
   lapsed.

Any change to the organization after the request voids it, including a hold
placed and released, or the owner cancelling and scheduling again.

### What deletion still does not do

Final deletion marks the organization deleted in Cloud. It does not remove
anything from Carbon Database, Carbon Registry or object storage (G-09), and
there is no customer-facing preview of what would be kept (G-142).

## Configuration

| Setting | Meaning |
|---|---|
| `CARBON_BILLING=enabled` | Turns billing on; the next three are then required |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_PRO` | The provider key and the price of the paid plan |
| `STRIPE_WEBHOOK_SECRET` | The provider's signing secret; `STRIPE_WEBHOOK_SECRET_PREVIOUS` is also accepted during rotation |
| `CARBON_OPERATORS=enabled` | Turns the operator API on |

None of this has run against the real payment provider (G-136).

## What is not built

See G-135 to G-146 in [the gap ledger](left-off/gaps.md). The main ones:

- Backup and restore (G-135).
- No run against the real provider (G-136).
- Final deletion destroys nothing in the owning services (G-09).
- Operators have no sign-in of their own, and Registry review is still outside
  this model (G-141, G-114).
- Storage and egress are not metered (G-139).

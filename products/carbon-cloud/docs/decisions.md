# Decisions waiting for the owner

Each of these is a question about what the platform should do, not about
whether something works. For every one a default is in force today, chosen so
that work could continue. None has been confirmed by the owner.

To close one: say "keep" or name the alternative. "Keep" closes the entry in
[the gap ledger](left-off/gaps.md) with no further work. An alternative becomes
work, and the last column says roughly how much.

The defaults were chosen by the author on 2026-10-11. They lean the same way
throughout: the safer behaviour over the more convenient one, and the simpler
mechanism over the more general one.

## Credentials and identity

| Gap | Question | Default in force | Why this default | If decided otherwise |
|---|---|---|---|---|
| G-04 | When are retired legacy `cc_` token hashes deleted? | Never. Retired tokens are refused; their hashes stay | A hash is not a credential, and keeping it lets a late use be recognised and logged as a retired token | A purge job and a published window: small |
| G-05 | Are legacy organization-wide end users migrated into realms? | No. They stay on the legacy routes, which stay until removed | A legacy user belongs to an organization, a realm to one environment. Choosing the environment for them is a guess about someone else's users | A migration with the owner choosing the target realm per organization: medium |
| G-06 | Is another key custody provider needed besides AWS KMS? | No. Local keys or AWS KMS | Nothing has asked for another, and the custody port takes one without changing callers | One adapter per provider: small each |
| G-30 | Should creating a build need its own permission? | No. It needs `release.publish` | A build's only purpose is a release, and a new permission changes every role preset and every credential's vocabulary | A new permission through contracts, roles and credentials: medium |
| G-141 (part) | Does an operator need two people for suspension, holds and trust rotation? | No. Two people for early deletion only | Early deletion is the one act that cannot be undone | More commands under approval: small |

## Data

| Gap | Question | Default in force | Why this default | If decided otherwise |
|---|---|---|---|---|
| G-69 | A foreign key lets a writer learn whether a key exists in a table they cannot read. Accept? | Accepted | It is how PostgreSQL enforces a reference, and the alternative is checking references in application code, which is slower and can race | Application-checked references: large |
| G-68 | Composite, cascading or `set null` foreign keys? | Single column, to a primary key, never cascading | A cascade deletes rows nobody named. The simple form cannot surprise | Each form: medium |
| G-72 | Custom sort order for exports? | ID order only | ID order is what makes a resumed export exact | A sort key in the cursor: medium |
| G-88 | Should a change event carry the row's values? | No. It names the row; the reader fetches it | Row images would copy customer data into a second store that needs its own policy checks and retention | Row images with policy evaluation: large |
| G-89 | Is visibility of a change decided when it happens or when it is read? | When it happens | A reader should not learn of a change to a row they could not see at the time | Read-time evaluation: large |
| G-95 | Double-precision vectors, richer metadata filters? | Single precision; equality on top-level scalars | What pgvector stores, and the simplest filter that is unambiguous | Either: medium |
| G-97 | A shortest-path search that hits its width limit answers "not found" | Kept, bounded | Bounded work per request. The limit is documented | Report the limit in the answer: small. A job: medium |
| G-87 | Range and conditional requests, object metadata, copy and move for blobs? | None | Not needed by anything built on blobs so far | Each: small to medium |
| G-78 | Blob bytes through Carbon Database, or presigned object-store addresses? | Through Database | A presigned upload cannot enforce an exact size and digest before the object exists | Presigned with verification on completion: medium, and it weakens that guarantee |
| G-112 | Functions stored in Cloud or owned by Database? | Cloud | Creating an execution and its lease, and reading the secrets it names, must be one transaction, and Cloud owns leases and secrets | Moving them behind signed Database requests: large |

## Releases and updates

| Gap | Question | Default in force | Why this default | If decided otherwise |
|---|---|---|---|---|
| G-56 | Should Cloud widen or halt a rollout on its own? | No. A person changes the percentage | Halting needs a health signal from installed apps, and the plan forbids device telemetry unless the app turns it on | Opt-in telemetry and an automatic policy: large |
| G-58 | The standalone updater daemon: harden or remove? | Kept, held to the shared conformance fixture, marked non-canonical | Something may still depend on it | Remove: small. Harden its local HTTP surface: medium |
| G-61 | Does a paused environment serve its update feed? | No. It answers `404` | "Paused" stops the environment. An install that sees no feed keeps the version it has | Serve the feed and the stop list while paused: small |
| G-45 | Lockfiles in a subdirectory or a workspace package? | Root-level bun lockfile only | Carbon apps today are root-level bun projects | Lockfile discovery by project path: small |

## Builds and functions

| Gap | Question | Default in force | Why this default | If decided otherwise |
|---|---|---|---|---|
| G-46 | Which encodings of a secret are removed from logs? | The exact value, its JSON-escaped form, and each line of a multi-line value | Every further encoding is a guess, and a transformation that hides a secret from redaction can always be invented | Base64 and URL-encoded forms: small, and still not complete |
| G-103 | Does an execution see the secret value from when its revision was deployed, or the current one? | The current one | A rotated secret is rotated because the old value must stop being used | Pinned secret versions in leases: medium |
| G-110 (part) | Is a failed function retried automatically? | No. Only a lost worker is, up to three attempts | A function that failed may have had effects; running it again without being asked is the more dangerous mistake | A retry policy per function: medium |
| G-101 (part) | Overlap and missed-run policy for schedules? | Skip on overlap; one run for any number of missed slots | Piling up runs after an outage is how an outage becomes a second one | A policy per schedule: small |

## Registry

| Gap | Question | Default in force | Why this default | If decided otherwise |
|---|---|---|---|---|
| G-09 (part) | What happens to a deleted organization's published packages? | Its publisher names stay reserved and its published versions stay downloadable | Other projects may depend on them, and a name that can be re-registered is how a supply chain is hijacked | Remove them: small, and it breaks dependents |
| G-119 (part) | Private packages? | No. Every published package is public | The trust model is built for public verification | Private packages with authenticated distribution: large |
| G-125 | Are review and yank reasons moderated or categorised? | Free text within a length limit; a revocation's reason is public | A reason has to be able to say what is wrong | Reason categories: small |

## Operations

| Gap | Question | Default in force | Why this default | If decided otherwise |
|---|---|---|---|---|
| G-143 | What does suspending an organization stop? | Customer changes. Work already running finishes; the subscription is untouched | Suspension is a hold, and killing a running build or execution destroys work that may be legitimate | Cancel running work and pause schedules on suspension: small |
| G-160 | Row-level security in Cloud's and Registry's own databases? | No. Scope checks in the application, foreign keys carrying scope, and the denial matrix as the control | Adding it means a database role per request and a policy on every table; done partially it gives a false sense of cover | Row-level security throughout: large |
| G-60 | Where are anonymous requests rate limited: the update feed, public downloads, Registry's public endpoints? | At the ingress or CDN, not inside the services | A service never trusts forwarded headers, so behind an ingress it cannot tell one anonymous caller from another. A limit by address inside it would limit everyone or no one | Trusted-proxy configuration and limits in each service: medium |
| G-164 | Which dependencies must be up for a service to report ready? | The database and its schema only | A shared dependency being down should not take every instance out of rotation at once; requests that need it fail on their own | A check per dependency: small each |
| G-22, G-90 (part) | A broker for the event and change streams, or polling? | Polling the database once a second per open stream | Correct with no extra moving part. Its cost grows with open streams, which have not been measured | LISTEN/NOTIFY or a broker: medium |
| G-19 | Can envelopes be moved between custody modes? | No. The mode is chosen before secrets are stored | Re-wrapping every secret is a migration with its own failure modes, not a setting | A re-wrap job: medium |
| G-106 (part) | How long are execution inputs, outputs and logs kept? | Thirty days | Long enough to debug, short enough that Cloud is not an archive of customer data | A setting per organization: small |

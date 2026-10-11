# Calling Cloud's API with a credential

A tool, such as the CLI or a script, can call part of Cloud's own API with a
device credential (`dc_`) or a personal credential (`pt_`) instead of a browser
session. This is separate from exchanging a credential for a signed assertion
to Carbon Database or Carbon Registry, which is described in
[device-authorization.md](device-authorization.md) and
[personal-credentials.md](personal-credentials.md).

```
GET /platform/v1/orgs/{org}/projects/{project}/environments/{env}/functions
Authorization: Bearer pt_...
```

No cookie, no `Origin`, and no CSRF token: a credential is not sent by a
browser on its own the way a cookie is, so there is nothing for a CSRF token to
protect.

## Which routes

Only these, each inside one environment:

| Routes | For |
|---|---|
| `.../builds` and below | Queueing, reading, cancelling builds; their logs and provenance |
| `.../releases`, `.../channels` and below | Releases and channels |
| `.../functions`, `.../executions`, `.../schedules` and below | Functions, their executions and schedules |

Everything else takes a browser session and nothing else: the account, its
organizations, members, projects and environments, secrets, credentials,
signing profiles, billing, and the audit log. A credential presented there is
ignored, so the request is anonymous.

Signing profiles are left out on purpose although they sit beside releases:
they hold release signing keys.

## Who the request is

The account that owns the credential. A build queued with a credential is
created by that account, and the organization's log attributes it to that
account. The log does not yet say which credential was used (G-128).

## What it may do

No more than the credential, and no more than the account:

- **Scope.** The credential applies inside the scope it was issued for. One
  issued for an environment works in that environment; one issued for a project
  works in each of that project's environments; one issued for an organization
  works in all of them. Outside its scope a resource does not exist as far as
  the credential can tell: the answer is `404`, the same as for a resource that
  is not there.
- **Permissions.** A command needs a permission that is both in the
  credential's list and held by the account right now. The account's access is
  worked out exactly as for a session, on every request, and the credential's
  list is applied on top. Listing a permission in a credential never grants it.
- **Never recently authenticated.** Anything that needs a recent sign-in needs
  a person at a browser. A credential never counts.

## When it stops working

On its next use, with `401`:

- when it is revoked, or past its expiry;
- when the account is no longer active;
- when anything about what the account may do changes: a role, a grant, a
  project assignment. The account's permission revision moves, and every
  credential issued before that is retired. This is the same rule as on the
  assertion-exchange path.

## What a browser may not do with one

- A request that carries a cookie is a session request. A credential beside it
  is not looked at.
- A request from a page of another origin is refused whatever it carries.

## From the CLI

`carbon cloud builds`, `releases`, `channels` and `functions` call these routes.
Each prints its own help, for example `carbon cloud functions --help`.

```
carbon cloud functions deploy report --file report.js --secret API_KEY
carbon cloud functions invoke <functionId> --input '{"month":"2026-10"}' --wait
carbon cloud functions logs <executionId>
carbon cloud builds create --repo <url> --commit <sha> --target nsis --platform windows
carbon cloud builds logs <buildId>
carbon cloud channels publish stable --release <releaseId> --rollout 10
```

The credential is the active `carbon cloud login`, which must be for one
environment. For automation, `CARBON_TOKEN` names a device or personal
credential outright and takes precedence; it then needs `CARBON_CLOUD_URL`,
`CARBON_ORG`, `CARBON_PROJECT` and `CARBON_ENVIRONMENT`, because a personal
credential does not say where it is to be used.

Lists are read a page at a time: `--limit` and `--cursor`, where the cursor is
the `nextCursor` of the page before.

Each subcommand prints Cloud's JSON answer on standard output and nothing else,
so it can be piped. Exit code 0 means Cloud answered; 1 means it refused or
could not be reached; 2 means the command was used wrongly and nothing was
sent. A command on something that exists reads its current revision first and
sends that with the command. `invoke --wait` follows the execution until it is
over and never invokes twice.

The CLI never prints the credential, and reports a `401` as one fixed sentence
whatever the response said.

## What is not built

- Service accounts (`cs_`), environment credentials (`ce_`) and app users
  cannot call these routes (G-104).
- Organizations, projects and environments cannot be read with a credential,
  so a tool must be given their identifiers (G-128).
- An organization that turns on its MFA requirement after a credential was
  issued does not retire that credential. The session that issued it passed
  the requirement in force at the time.

# The console against the live service

The Carbon Cloud console is the React application in
`products/carbon-cloud/presentation`. Until Phase 17 it ran only against a
mock. This document describes the production composition: what is connected
to the real API, what is not, and how to build and serve it.

**One part of the console is connected: accounts, organizations, members,
invitations, projects and environments.** Everything else says it is not
connected (G-147). The backend for most of it exists; the adapters do not.

## Two compositions

| | Mock | Live |
|---|---|---|
| Entry | `composition/browser.tsx` | `composition/browser.live.tsx` |
| HTML | `presentation/index.html` | `presentation/index.live.html` |
| Services | `infrastructure/browser/mock/` | `infrastructure/browser/http/` |
| Build | `bun run build:mock` to `dist-mock/` | `bun run build:live` to `dist-live/` |
| Network | None; the page may not connect anywhere | Its own origin only |

The pages are the same. They receive their services through one context and do
not know which composition built them, except for one flag (`useRuntime().live`)
that they use only to say true things: the live console never tells a visitor
that something is simulated.

### No mock in production

The live composition imports no mock service, no mock data and no development
tool. This is enforced twice:

- `vite.live.config.ts` stops the build if any module under
  `infrastructure/browser/mock/` or `presentation/devtools/`, or any server
  module, is in the bundle's graph.
- A test walks the imports from `browser.live.tsx` and fails on the same
  modules. It runs in CI, which does not run the Vite build.

There is no fallback. An area that is not connected answers
`unsupported_operation`; nothing is made up in its place.

The bundle still contains the page code for areas that are not connected, and
that code still carries wording written for the mock. It is never rendered
against the live service (see below), but it ships (G-151).

## What is connected

| Area | Works against the live API |
|---|---|
| Sign up, sign in, recovery link | Carbon emails a link; opening it in the same browser completes it |
| Session | Read, sign out, and dropped from the page when the server ends it |
| Account | Profile, email change request, sessions, revoke sessions, MFA enrollment and removal |
| Organizations | List, create, rename, MFA policy |
| Members | List, change role, remove, leave |
| Invitations | Send, resend, cancel, list sent, preview and accept |
| Projects and environments | List, create, archive, pause |
| Scope and permissions | Resolved by the server for every page |
| Audit | The list on organization, project and environment overviews |
| Builds | Per environment: list, queue a build for one commit, read its installers and log, cancel |
| Signing | Per environment: list signing profiles, create one from an environment secret |
| Releases | Per environment: list, create from a succeeded build, read, withdraw with a reason |
| Update channels | Per environment: list, publish a release (which creates the channel), change the rollout, read the feed address and the history |
| Functions | List, deploy a function or a new revision, read a revision's code, activate a revision, enable and disable, invoke, list and follow executions, read an execution's log, cancel, retry, and schedules by calendar or interval with pause, resume and delete |

Not connected inside these areas (G-148): GitHub sign-in, recovery by code,
notifications, deleting an account, ownership transfer, billing contact,
declining an invitation, the list of invitations an account received,
per-project member access, and environment provisioning and policy.

### Pages written for the service, not adapted from the mock

The mock's functions had drafts, a choice of handler, memory sizes, concurrency,
promotion between environments and several ways to authorize an invocation.
Carbon Cloud has none of those. Bending the real service into that shape would
have meant showing settings that do nothing.

So against the live service the functions routes render their own pages
(`LiveFunctionPages`), over their own contract (`LiveFunctionService`), which
describes exactly what the service returns. Builds, signing, releases and
channels are done the same way (`LiveDeliveryPages`, `LiveDeliveryService`). The mock composition keeps the
mock's pages. The same routes serve both; which pages render is decided by the
composition, in one place.

### Builds and releases belong to an environment

The console's routes file builds, releases, channels and signing under a
project. The service keeps each of them per environment. The live pages
therefore start with a choice of environment, carried in the address as
`?environment=`, and show that environment's and nothing else's. An
environment that is not in the project is said to be so, and nothing is asked
on its behalf.

Publishing to a channel reads the channel first: an existing channel is
changed at the revision it has now, a new one is created, and if the channel's
state cannot be read nothing is published.

In the same slice of the route catalog, build configuration and organization
workers are not connected: the service has no build configuration, and the
workers page is not written. Those two routes still show the notice.

What the live functions pages do not have, because the service does not: a
stream of log output while a function runs (the log arrives when it finishes),
and anything about who else may invoke a function (G-102, G-104).

Every other route of the console renders one notice, "This area is not
connected to Carbon Cloud in this version of the console yet", and makes no
request for that area's data.

## How a request is made

Every adapter goes through `LiveTransport`.

- Requests go to `/platform/v1` on the page's own origin, with the session
  cookie.
- A command sends the CSRF token (the one cookie the page can read), an
  idempotency key, and the revision the page was looking at.
- A failure is never an exception. The server's error becomes one of the
  console's own codes; a network failure is `unavailable`; an aborted request
  is `cancelled`.
- When the server answers that the session is gone, the page is told once,
  drops everything it holds, and asks for the session again.

What the session may see is part of every cache key
(`session id . security revision . permission revision`), so a change to any of
them empties the cache.

### Emailed links

Carbon's emails link to `/auth/complete#token=...` and
`/invitations/accept#token=...`. The token is in the fragment, which browsers
do not send to any server. The page reads it from there and posts it.

Two emailed links are not handled by the console yet: the email-change
confirmation and the recent-sign-in confirmation (G-150).

### Lists

The live API pages by cursor. It returns no total, and does not filter or sort
by name. The console passes the cursor through, applies the name filter to the
page that came back, and reports the number of items on that page as the total
(G-149).

## Build and serve

```
bun run --cwd products/carbon-cloud build:live
CARBON_CONSOLE_DIR=products/carbon-cloud/dist-live bun run --cwd products/carbon-cloud start
```

With `CARBON_CONSOLE_DIR` set, Cloud serves the console from the same origin as
the API, which the session cookies require:

- a path with a file extension is a file from the build, or `404`;
- any other path that is not an API path is the application;
- nothing outside the build directory can be reached;
- built assets are cached for a year, the application shell is never cached;
- responses carry a content security policy that allows scripts, styles and
  connections from this origin only, and forbids framing.

For development, `bun run dev:live` serves the pages on `127.0.0.1:5177` and
proxies `/platform` to a local Cloud (`CARBON_CLOUD_URL`, default
`http://127.0.0.1:8080`).

## How it was checked

- **Against the real API and a real database:** the adapters, called through
  Cloud's request handler with a browser's cookie behaviour, walk sign-up by
  emailed link, the session, the profile, two organizations, a project and its
  environments, a second person invited and accepting, what a Viewer may and
  may not do, another organization staying invisible, the audit list, a session
  ended by the server, and sign-out.
- **Rendered pages:** every connected page is rendered from answers shaped like
  the server's and checked for the names the server gave and for the absence of
  mock wording; routes that are not connected are checked to render the notice
  and to request nothing.
- **Not checked in a real browser.** No test drives Chrome or Firefox (G-151).

## What is not built

See G-147 to G-153 in [the gap ledger](left-off/gaps.md).

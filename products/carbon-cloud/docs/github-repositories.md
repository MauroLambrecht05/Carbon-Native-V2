# GitHub App repositories

The repository integration uses a dedicated GitHub App. It stores GitHub installation and repository identifiers plus display metadata; installation access tokens, the App private key, and the webhook secret never enter PostgreSQL or API responses. See [OpenAPI](github-repository-api.openapi.json).

Enable it with `CARBON_GITHUB_REPOSITORIES=enabled`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_WEBHOOK_SECRET`. This configuration is separate from the account-login OAuth App. The private key may contain real newlines or escaped `\n` sequences.

Owners and admins connect or refresh an installation with a fresh dashboard session, CSRF token, idempotency key, and current organization revision. Saving or clearing a project repository uses the same controls and the current project revision. Reads require `metadata.read`; mutations require `resources.configure`.

Every connect, configuration save, commit resolution, and webhook obtains fresh installation authorization from GitHub. A branch or tag is converted to a 40-character commit SHA before downstream build work starts, and that resolution is recorded with the repository revision. Removed or archived repositories disconnect affected project configurations.

`POST /projects/{projectId}/repository/proposal` accepts one bounded relative file path, content, title and commit message. Carbon derives a deterministic `carbon/proposal-*` branch from the actor and idempotency key, updates that branch, and opens a pull request against the configured base branch. Retries inspect the branch, file and existing pull request before writing, then return the durable receipt. Carbon persists hashes and pull-request metadata, not the proposed file content. It never commits directly to the configured source branch.

Configure the GitHub App webhook URL as `${CARBON_PUBLIC_ORIGIN}/platform/v1/webhooks/github`. The endpoint authenticates the exact request bytes using `X-Hub-Signature-256`, bounds the body to 1 MiB, validates delivery/event identifiers, and deduplicates `X-GitHub-Delivery`. It stores only the payload digest and normalized result, never the raw payload.

Signed `installation/suspend` and `installation/deleted` deliveries are revocation evidence because GitHub can no longer mint an installation token for those states. Carbon immediately suspends the installation, marks its repositories removed, and disconnects bound projects. Other deliveries must still pass a fresh installation/repository authorization check.

Operational rotation: install the replacement RSA private key or webhook secret in the deployment secret store, update the matching GitHub App setting, restart Cloud, then send a GitHub test delivery and refresh one connected installation. A webhook-secret rotation has no overlap in this adapter, so coordinate the provider and service update.

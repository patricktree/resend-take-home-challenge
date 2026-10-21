# Email Draft Approval

A gate between Agents that compose emails and the human Reviewer who must approve each email before it is sent through Resend. An Agent creates a Draft, revises it and submits it for review; the Reviewer approves or rejects exactly the Revision they read, and only an approved Revision is sent, at most once. See the [spec](.scratch/email-draft-approval/spec.md) for the design and [GLOSSARY.md](GLOSSARY.md) for the terms.

One Cloudflare Worker at <https://resend-challenge.patricktree.me> serves the HTTP API under `/api/v1`, the MCP server at `/mcp` and the Review UI under `/app`. It keeps Drafts in D1 and Revision bodies in R2, hands approved Drafts to a Cloudflare Queue whose consumer calls Resend, and runs a Send reconciler every minute. The published OpenAPI document is served at `/api/openapi.json`.

## Act as an Agent via MCP

The Agent token is public by design, so you can act as an Agent without any setup: `agent_placeholder-run-pnpm-secrets-generate`. If it starts with `agent_placeholder`, the production tokens have not been generated yet. Nothing is sent without the Reviewer token, which is never committed.

Create a Draft:

```sh
curl -sS -X POST https://resend-challenge.patricktree.me/api/v1/drafts \
  -H 'Authorization: Bearer agent_placeholder-run-pnpm-secrets-generate' \
  -H 'Content-Type: application/json' \
  -d '{"to":["delivered@resend.dev"],"subject":"Hello","body":{"plainText":"Hello from an Agent."}}'
```

The response is `201` with the Draft summary; its `id` starts with `drf_`. Get the Draft, including its body, replacing `<draft-id>` with that `id`:

```sh
curl -sS https://resend-challenge.patricktree.me/api/v1/drafts/<draft-id> \
  -H 'Authorization: Bearer agent_placeholder-run-pnpm-secrets-generate'
```

### Connect an MCP host

The MCP server speaks Streamable HTTP at `https://resend-challenge.patricktree.me/mcp`. It needs no OAuth: configure the Agent token as a static `Authorization` header. The Reviewer token gets `403 AGENT_ONLY` there. For Claude Code:

```sh
claude mcp add --transport http draft-approval https://resend-challenge.patricktree.me/mcp \
  --header 'Authorization: Bearer agent_placeholder-run-pnpm-secrets-generate'
```

Hosts configured through JSON take the same URL and header, for example:

```json
{
  "mcpServers": {
    "draft-approval": {
      "type": "http",
      "url": "https://resend-challenge.patricktree.me/mcp",
      "headers": { "Authorization": "Bearer agent_placeholder-run-pnpm-secrets-generate" }
    }
  }
}
```

The host then lists six tools: `create_draft`, `get_draft`, `list_drafts`, `revise_draft`, `submit_draft` and `get_revision`. The server instructions describe the lifecycle. No tool approves, rejects or sends: only the Reviewer does that, in the Review UI. Locally, use `http://localhost:5173/mcp` with the local Agent token `agent_local-development-only`.

## Act as an Agent with the CLI

After `pnpm install` (see [AGENTS.md](AGENTS.md#environment-setup)), run the `draft-approval` CLI from the repository root. It calls production with the public Agent token unless you set `DRAFT_APPROVAL_TOKEN`, and `--api-url` or `DRAFT_APPROVAL_API_URL` points it at another API origin, such as `http://localhost:5173` with the local Agent token. It has no command to approve or reject: only the Reviewer decides, in the Review UI. `pnpm draft-approval --help` and `--help` on every command describe the options.

Create a Draft, read its id and the id of its latest Revision from the output, then submit that Revision for review:

```sh
pnpm draft-approval drafts create --to delivered@resend.dev --subject 'Hello' --body 'Hello from an Agent.'
pnpm draft-approval drafts submit <draft-id> <revision-id>
```

The Reviewer opens the printed `Review URL`. Poll the Draft for its review status and sending status:

```sh
pnpm draft-approval drafts get <draft-id>
```

After a Rejection, revise the Draft on top of the Revision you read, with the body from a file or from stdin (`--body-file -`), and submit the new Revision:

```sh
pnpm draft-approval drafts revise <draft-id> --base-revision <revision-id> \
  --to delivered@resend.dev --subject 'Hello again' --body-file body.txt
```

`drafts list` filters with `--review-status` and `--sending-status` and pages with `--limit` and `--cursor`; `drafts revision <draft-id> <revision-id>` reads any Revision. With `--json`, a command prints exactly one JSON value on stdout. A failure exits with 1 and prints `{"error":{"code","message"}}` as JSON on stderr: API errors keep the API's code, invalid input fails with `INVALID_REQUEST` before any request, an unreachable API fails with `NETWORK_ERROR`, and anything else, such as a response without the API's error envelope, with `UNEXPECTED_ERROR`. pnpm adds its own lines to stderr; run `node apps/cli/src/cli.ts` instead of `pnpm draft-approval` when a program reads stderr.

## Local development

Set up the repository as described in [AGENTS.md](AGENTS.md#environment-setup), including the copy of `apps/cloudflare-worker/.dev.vars.example` to `apps/cloudflare-worker/.dev.vars`. That file sets `LOCAL_DEVELOPMENT="true"` and takes your own `RESEND_API_KEY`; local Sends call the real Resend API, so send only to Resend's test recipients `delivered@resend.dev` and `bounced@resend.dev`.

Start the Worker:

```sh
pnpm dev
```

It applies the D1 migrations to the local database and serves the Worker at <http://localhost:5173>, with D1, R2 and the Queue running locally in Miniflare. Wrangler warns that the required secret `REVIEWER_TOKEN` is missing; local development uses the local tokens instead.

The Review UI runs at <http://localhost:5173/app/> with hot reload; enter the local Reviewer token `reviewer_local-development-only` on its token screen. In development only, its Content-Security-Policy also allows inline scripts and styles, which Vite's dev server injects for hot reload; the production build needs neither.

Call the local API with the local tokens from [`libs/api.routes/src/local-tokens.ts`](libs/api.routes/src/local-tokens.ts), which only a Worker with `LOCAL_DEVELOPMENT="true"` accepts, and only on `localhost`:

```sh
curl -sS -X POST http://localhost:5173/api/v1/drafts \
  -H 'Authorization: Bearer agent_local-development-only' \
  -H 'Content-Type: application/json' \
  -d '{"to":["delivered@resend.dev"],"subject":"Hello","body":{"plainText":"Hello from a local Agent."}}'
```

With `pnpm dev` running, fill the local database with sample Drafts through the typed client and the local tokens: three Pending ones, one Rejected with a reason and one Approved to `delivered@resend.dev`. The script prints each Draft's review status, id and subject:

```sh
pnpm seed
```

It calls <http://localhost:5173> by default; pass `--base-url <url>` or set `DRAFT_APPROVAL_BASE_URL` for another local address. Each run adds new Drafts. Only the Reviewer token can approve or reject a Revision, for example with `POST /api/v1/drafts/<draft-id>/revisions/<revision-id>/approval` and `Authorization: Bearer reviewer_local-development-only`.

The Send reconciler makes sure no Send stays `QUEUED` forever. Each tick handles at most 100 Drafts per job, oldest first: it re-enqueues approved Drafts whose hand-off to the Send Queue was not recorded within 1 minute of the Approval, and it records `FAILED` with `OUTCOME_UNKNOWN` for Drafts still `QUEUED` 1 hour after their 23 h deadline. When re-enqueueing fails, the tick logs the error and leaves the backlog to later ticks. A message that the Send Queue gives up on goes to the Send DLQ, whose consumer records `FAILED` with `OUTCOME_UNKNOWN` at once. A late `SENT` still overrides `OUTCOME_UNKNOWN`.

The cron trigger does not fire locally. Run one tick of the Send reconciler by calling the scheduled handler, which answers `200` with `ok`:

```sh
curl -sS 'http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*'
```

## Validation

Run `pnpm validate:fast` for the format check, markdownlint, Knip, build and typecheck, lint, and the unit, integration and CLI process tests, and `pnpm validate:extended` for the e2e tests, which run the Review UI in a browser in Docker and compare its screenshot baselines. `pnpm validate:update-snapshots` rewrites the baselines after an intended visual change. [AGENTS.md](AGENTS.md#validation) describes all three.

## Infrastructure

| Owner                                                     | Manages                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Terraform](terraform/)                                   | The D1 database (read replication `auto`), the R2 bucket for Revision bodies, the Send Queue and the Send DLQ                                                                                                                         |
| [`wrangler.jsonc`](apps/cloudflare-worker/wrangler.jsonc) | The Worker, its custom domain, the cron trigger, the Queue producer and consumers, the bindings and the vars                                                                                                                          |
| `wrangler secret put`                                     | The secrets `REVIEWER_TOKEN` and `RESEND_API_KEY`                                                                                                                                                                                     |
| By hand, once                                             | The R2 bucket `draft-approval-terraform-state` that holds the Terraform state, the Resend sending domain `resend-challenge.patricktree.me` (Resend dashboard) and its DNS records in the zone `patricktree.me` (Cloudflare dashboard) |

There is only a production environment. Deploys run by hand, in this order: `terraform apply`, then `wrangler d1 migrations apply --remote`, then `wrangler deploy`. The next section lists every command.

## Human steps

These steps need Patrick's Cloudflare and Resend accounts, so no agent runs them. Run them in order, each from the repository root. The Terraform steps run in a terminal that has loaded `terraform/.env`; the Wrangler steps run in any terminal, and the dashboard steps in the browser.

- [ ] **Log in to Wrangler.** Run `pnpm --filter '@draft-approval/cloudflare-worker' exec wrangler login` and approve the request in the browser. Then run `export CLOUDFLARE_ACCOUNT_ID=<account-id>` in every terminal that runs Wrangler, replacing `<account-id>` with the account id from the Cloudflare dashboard, so that Wrangler never has to ask for the account. Success: `pnpm --filter '@draft-approval/cloudflare-worker' exec wrangler whoami` shows the account.
- [ ] **Bootstrap the Terraform state bucket.** Run `pnpm --filter '@draft-approval/cloudflare-worker' exec wrangler r2 bucket create draft-approval-terraform-state`. Success: Wrangler reports the bucket as created. Terraform never manages this bucket; never delete it while the state lives there.
- [ ] **Create the credentials for Terraform.** Copy `terraform/.env.example` to `terraform/.env` (gitignored) and fill it in:
  - `TF_VAR_cloudflare_api_token`: a Cloudflare API token (**My Profile > API Tokens > Create Token > Custom token**) with **Account > D1 > Edit**, **Account > Workers R2 Storage > Edit** and **Account > Queues > Edit** for the account.
  - `TF_VAR_cloudflare_account_id`: from the overview page of the zone `patricktree.me` in the Cloudflare dashboard.
  - `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: an R2 API token (**R2 > Manage API tokens > Create API token**) with **Object Read & Write** on the bucket `draft-approval-terraform-state`; the endpoint is `https://<account-id>.r2.cloudflarestorage.com`.
- [ ] **Create the infrastructure.** Load the credentials and apply:

  ```sh
  set -a && . terraform/.env && set +a
  terraform -chdir=terraform init
  terraform -chdir=terraform plan -out=production.tfplan
  terraform -chdir=terraform apply production.tfplan
  ```

  Success: `init` reports `Terraform has been successfully initialized!`, the plan creates 4 resources (D1 database, R2 bucket, two Queues), and `apply` ends with `Apply complete! Resources: 4 added, 0 changed, 0 destroyed.`

- [ ] **Copy the outputs into `wrangler.jsonc`.** Run `terraform -chdir=terraform output -raw d1_database_id` and replace the placeholder `00000000-0000-0000-0000-000000000000` in `d1_databases[0].database_id` of [`apps/cloudflare-worker/wrangler.jsonc`](apps/cloudflare-worker/wrangler.jsonc) with it; drop the word PLACEHOLDER from the comment above it. The other bindings refer to resources by name: check that `terraform -chdir=terraform output` shows `d1_database_name = "draft-approval"`, `revision_bodies_bucket_name = "draft-approval-revision-bodies"`, `send_queue_name = "draft-approval-send"` and `send_dlq_name = "draft-approval-send-dlq"`, the names `wrangler.jsonc` uses. Commit the change.
- [ ] **Create the Resend sending domain.** In the Resend dashboard, go to **Domains > Add Domain**, enter `resend-challenge.patricktree.me` and choose the region `eu-west-1` (Ireland). Leave the other options at their defaults. Success: the domain appears under **Domains**, and its page lists the DNS records to add.
- [ ] **Add the sending domain's DNS records.** In the Cloudflare dashboard, open the zone `patricktree.me`, go to **DNS > Records** and choose **Add record** once for each record the Resend domain page lists, typically an MX and an SPF TXT record on `send.resend-challenge` and a DKIM TXT record on `resend._domainkey.resend-challenge`. Copy each record's type, name, value and priority from the Resend domain page, not from this README, enter the name as Resend shows it (Cloudflare appends `.patricktree.me`), keep the TTL at **Auto** and set each record to **DNS only**, never proxied. Alternatively, choose **Sign in to Cloudflare** on the Resend domain page, which adds the records through Domain Connect once you authorize Resend's access to the zone. Success: **DNS > Records** shows every record from the Resend domain page under its full name, such as `send.resend-challenge.patricktree.me`, with the values unchanged.
- [ ] **Wait for the Resend domain verification.** On the Resend domain page, choose **Verify DNS Records**. Resend keeps checking on its own; verification often takes minutes, and Resend allows up to 72 hours for DNS propagation. Success: **Domains** in the Resend dashboard shows `resend-challenge.patricktree.me` as **Verified**.
- [ ] **Create the Worker's Resend API key.** In the Resend dashboard, go to **API Keys > Create API Key**, choose **Sending access** and the domain `resend-challenge.patricktree.me`. Resend shows the key only once; keep it for the step **Set the Resend API key**.
- [ ] **Generate the tokens.** Run `pnpm secrets:generate`. It writes a new public Agent token into `apps/cloudflare-worker/wrangler.jsonc`, this README and the CLI's fallback in `apps/cli/src/production.ts`, and pipes a new Reviewer token into `wrangler secret put REVIEWER_TOKEN`; if the Worker `draft-approval` does not exist yet, Wrangler creates an empty one to hold the secret. Success: the script prints `Set the Worker secret REVIEWER_TOKEN.` followed by the Reviewer token. If Wrangler fails, the files already hold a new Agent token; fix the cause and run the script again. Store the Reviewer token in the password manager, since it is not shown again, and commit the changed `wrangler.jsonc`, `README.md` and `apps/cli/src/production.ts`.
- [ ] **Set the Resend API key.** Run `pnpm --filter '@draft-approval/cloudflare-worker' exec wrangler secret put RESEND_API_KEY` and paste the sending-only key when Wrangler asks for it. Success: Wrangler prints `Success! Uploaded secret RESEND_API_KEY`.
- [ ] **Apply the D1 migrations.** Run `pnpm --filter '@draft-approval/cloudflare-worker' run migrations:apply:remote` and confirm. Success: Wrangler lists every migration in `libs/drafts/migrations` with status ✅.
- [ ] **Deploy the Worker.** Run `pnpm --filter '@draft-approval/cloudflare-worker' run deploy`, which builds the Worker with the Review UI as its static assets and runs `wrangler deploy`. Success: Wrangler lists the triggers `resend-challenge.patricktree.me (custom domain)`, `schedule: * * * * *`, `Producer for draft-approval-send`, `Consumer for draft-approval-send` and `Consumer for draft-approval-send-dlq`. A first deploy of the custom domain can take a few minutes to serve.
- [ ] **Verify production.** Create and get a Draft with the public Agent token, as in [Act as an Agent via MCP](#act-as-an-agent-via-mcp): creating answers `201`, getting answers `200` with the body. Then check that production refuses the local tokens and redirects the root:

  ```sh
  curl -sS -o /dev/null -w '%{http_code}\n' https://resend-challenge.patricktree.me/api/v1/drafts/drf_00000000-0000-7000-8000-000000000000 \
    -H 'Authorization: Bearer agent_local-development-only'
  curl -sS -o /dev/null -w '%{http_code}\n' https://resend-challenge.patricktree.me/api/v1/drafts/drf_00000000-0000-7000-8000-000000000000 \
    -H 'Authorization: Bearer reviewer_local-development-only'
  curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://resend-challenge.patricktree.me/
  ```

  Success: the first two commands print `401`, the third `302 https://resend-challenge.patricktree.me/app/`.

- [ ] **Run the live Resend contract test.** Run `RESEND_API_KEY=<key> pnpm test:resend-live`, replacing `<key>` with the sending-only key. It sends three emails from `RESEND_FROM` of `wrangler.jsonc` (override it with `RESEND_FROM`) to `delivered@resend.dev`, and checks Resend's idempotency behavior that the local tests' Resend stub models. Success: Vitest reports 3 passed tests.

Every later deploy is `terraform apply` if `terraform/` changed, then the migrations step, then the deploy step. To rotate a token, run `pnpm secrets:generate` again and redeploy; the old tokens stop working with no overlap.

## Development

See [AGENTS.md](AGENTS.md) for setup, commands and conventions.

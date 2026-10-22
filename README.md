# Email Draft Approval

Human approval for emails written by Agents: nothing is sent until a Reviewer approves the exact Revision. An Agent creates a Draft, revises it and submits it for review; the Reviewer approves or rejects exactly the Revision they read, and only an approved Revision is sent, at most once. See the [spec](.scratch/email-draft-approval/spec.md) for the design and [GLOSSARY.md](GLOSSARY.md) for the terms.

One Cloudflare Worker at <https://resend-challenge.patricktree.me> serves the HTTP API under `/api/v1`, the MCP server at `/mcp` and the Review UI under `/app`. It keeps Drafts in D1 and Revision bodies in R2, hands approved Drafts to a Cloudflare Queue whose consumer calls Resend, and runs a Send reconciler every minute. The published OpenAPI document is served at `/api/openapi.json`.

The Send reconciler makes sure no Send stays `QUEUED` forever. Each tick handles at most 100 Drafts per job, oldest first: it re-enqueues approved Drafts whose hand-off to the Send Queue was not recorded within 1 minute of the Approval, and it records `FAILED` with `OUTCOME_UNKNOWN` for Drafts still `QUEUED` 1 hour after their 23 h deadline. When re-enqueueing fails, the tick logs the error and leaves the backlog to later ticks. A message that the Send Queue gives up on goes to the Send DLQ, whose consumer records `FAILED` with `OUTCOME_UNKNOWN` at once. A late `SENT` still overrides `OUTCOME_UNKNOWN`.

## Act as an Agent

The Agent token is public by design, so you can act as an Agent without any setup: `agent_-17WHltuc9F9_Lpa7Yl3yy_tJ5_Upo07v637L_y1330`.

An Agent given only the URL finds its way from there: `GET /` answers with an agent quickstart in Markdown (the token, the MCP server, the lifecycle and the links below) unless the client asks for `text/html`, which a browser does and which redirects to the Review UI. `/llms.txt` serves the same quickstart as plain text. Both read the token from the Worker's configuration, so they always show the deployed one.

After submitting, hand the Draft's `reviewUrl` to the human who asked for the email, so they can review it or forward it to the Reviewer; an Agent cannot approve.

### Agent Skill

[`skills/email-draft-approval/SKILL.md`](skills/email-draft-approval/SKILL.md) is an Agent Skill for the whole workflow: connecting, submitting, handing over the `reviewUrl`, polling with backoff, revising after a Rejection, following the Send, and the error codes that need a specific reaction. The Worker serves the same file at <https://resend-challenge.patricktree.me/skills/email-draft-approval/SKILL.md>. Install it for Claude Code:

```sh
mkdir -p ~/.claude/skills/email-draft-approval && curl -sSo ~/.claude/skills/email-draft-approval/SKILL.md https://resend-challenge.patricktree.me/skills/email-draft-approval/SKILL.md
```

### Over HTTP

Create a Draft:

```sh
curl -sS -X POST https://resend-challenge.patricktree.me/api/v1/drafts \
  -H 'Authorization: Bearer agent_-17WHltuc9F9_Lpa7Yl3yy_tJ5_Upo07v637L_y1330' \
  -H 'Content-Type: application/json' \
  -d '{"to":["delivered@resend.dev"],"subject":"Hello","body":{"plainText":"Hello from an Agent."}}'
```

The response is `201` with the Draft summary; its `id` starts with `drf_`. Get the Draft, including its body, replacing `<draft-id>` with that `id`:

```sh
curl -sS https://resend-challenge.patricktree.me/api/v1/drafts/<draft-id> \
  -H 'Authorization: Bearer agent_-17WHltuc9F9_Lpa7Yl3yy_tJ5_Upo07v637L_y1330'
```

### Through MCP

The MCP server speaks Streamable HTTP at `https://resend-challenge.patricktree.me/mcp`. It needs no OAuth: configure the Agent token as a static `Authorization` header. The Reviewer token gets `403 AGENT_ONLY` there. For Claude Code:

```sh
claude mcp add --transport http resend-challenge https://resend-challenge.patricktree.me/mcp \
  --header 'Authorization: Bearer agent_-17WHltuc9F9_Lpa7Yl3yy_tJ5_Upo07v637L_y1330'
```

Hosts configured through JSON take the same URL and header, for example:

```json
{
  "mcpServers": {
    "resend-challenge": {
      "type": "http",
      "url": "https://resend-challenge.patricktree.me/mcp",
      "headers": { "Authorization": "Bearer agent_-17WHltuc9F9_Lpa7Yl3yy_tJ5_Upo07v637L_y1330" }
    }
  }
}
```

The host then lists six tools: `create_draft`, `get_draft`, `list_drafts`, `revise_draft`, `submit_draft` and `get_revision`. The server instructions describe the lifecycle, including handing the `reviewUrl` to the human. No tool approves, rejects or sends: only the Reviewer does that, in the Review UI. Locally, use `http://localhost:5173/mcp` with the local Agent token `agent_local-development-only`.

### With the CLI

After `pnpm install` (see [AGENTS.md](AGENTS.md#environment-setup)), run the `resend-challenge` CLI from the repository root. It calls production with the public Agent token unless you set `RESEND_CHALLENGE_TOKEN`, and `--api-url` or `RESEND_CHALLENGE_API_URL` points it at another API origin, such as `http://localhost:5173` with the local Agent token. It has no command to approve or reject: only the Reviewer decides, in the Review UI. `pnpm resend-challenge --help` and `--help` on every command describe the options.

Create a Draft, read its id and the id of its latest Revision from the output, then submit that Revision for review:

```sh
pnpm resend-challenge drafts create --to delivered@resend.dev --subject 'Hello' --body 'Hello from an Agent.'
pnpm resend-challenge drafts submit <draft-id> <revision-id>
```

Show the printed `Review URL` to the human who asked for the email; the Reviewer opens it. Poll the Draft for its review status and sending status:

```sh
pnpm resend-challenge drafts get <draft-id>
```

After a Rejection, revise the Draft on top of the Revision you read, with the body from a file or from stdin (`--body-file -`), and submit the new Revision:

```sh
pnpm resend-challenge drafts revise <draft-id> --base-revision <revision-id> \
  --to delivered@resend.dev --subject 'Hello again' --body-file body.txt
```

`drafts list` filters with `--review-status` and `--sending-status` and pages with `--limit` and `--cursor`; `drafts revision <draft-id> <revision-id>` reads any Revision. With `--json`, a command prints exactly one JSON value on stdout. A failure exits with 1 and prints `{"error":{"code","message"}}` as JSON on stderr: API errors keep the API's code, invalid input fails with `INVALID_REQUEST` before any request, an unreachable API fails with `NETWORK_ERROR`, and anything else, such as a response without the API's error envelope, with `UNEXPECTED_ERROR`. pnpm adds its own lines to stderr; run `node apps/cli/src/cli.ts` instead of `pnpm resend-challenge` when a program reads stderr.

## Review as the Reviewer

Open the Review UI at <https://resend-challenge.patricktree.me/app/> and enter the Reviewer token, which the repository owner hands out separately, on its token screen. The Pending list shows the submitted Drafts, longest-waiting first; open one to read its latest Revision, then approve it or reject it with an optional reason. After an Approval, the Draft page shows the sending status, from "Sending…" to "Sent". If the Agent revised the Draft after the page loaded, the verdict is not recorded: the page shows the error inline with "Reload Draft". The Decided list shows every Draft whose latest Revision has a verdict.

## Local development

Set up the repository as described in [AGENTS.md](AGENTS.md#environment-setup), which also lists the validation commands and conventions. The setup copies `apps/cloudflare-worker/.dev.vars.example` to `apps/cloudflare-worker/.dev.vars`; that file sets `LOCAL_DEVELOPMENT="true"` and takes your own `RESEND_API_KEY`. Local Sends call the real Resend API, so send only to Resend's test recipients `delivered@resend.dev` and `bounced@resend.dev`.

```sh
pnpm dev
pnpm seed
```

`pnpm dev` applies the D1 migrations to the local database and serves the Worker at <http://localhost:5173>, with D1, R2 and the Queue running locally in Miniflare. Wrangler warns that the required secret `REVIEWER_TOKEN` is missing; local development uses the local tokens from [`libs/api.routes/src/local-tokens.ts`](libs/api.routes/src/local-tokens.ts) instead, which only a Worker with `LOCAL_DEVELOPMENT="true"` accepts, and only on `localhost`. With `pnpm dev` running, `pnpm seed` adds sample Drafts on each run: three Pending ones, one Rejected with a reason and one Approved to `delivered@resend.dev`.

The Review UI runs at <http://localhost:5173/app/> with hot reload; enter the local Reviewer token `reviewer_local-development-only` on its token screen. Agents call <http://localhost:5173> with the local Agent token `agent_local-development-only`, over HTTP, MCP or the CLI as above. Only the Reviewer token can approve or reject a Revision, for example with `POST /api/v1/drafts/<draft-id>/revisions/<revision-id>/approval` and `Authorization: Bearer reviewer_local-development-only`.

The cron trigger does not fire locally. Run one tick of the Send reconciler by calling the scheduled handler, which answers `200` with `ok`:

```sh
curl -sS 'http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*'
```

## Infrastructure

| Owner                                                     | Manages                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Terraform](terraform/)                                   | The D1 database (read replication `auto`), the R2 bucket for Revision bodies, the Send Queue and the Send DLQ                                                                                                                           |
| [`wrangler.jsonc`](apps/cloudflare-worker/wrangler.jsonc) | The Worker, its custom domain, the cron trigger, the Queue producer and consumers, the bindings and the vars                                                                                                                            |
| `wrangler secret put`                                     | The secrets `REVIEWER_TOKEN` and `RESEND_API_KEY`                                                                                                                                                                                       |
| By hand, once                                             | The R2 bucket `resend-challenge-terraform-state` that holds the Terraform state, the Resend sending domain `resend-challenge.patricktree.me` (Resend dashboard) and its DNS records in the zone `patricktree.me` (Cloudflare dashboard) |

There is only a production environment. Deploys run by hand, in this order: `terraform apply`, then `wrangler d1 migrations apply --remote`, then `wrangler deploy`. The next section lists every command.

## Human steps

These steps need the operator's Cloudflare and Resend accounts, so no agent runs them. Run them in order, each from the repository root. The Terraform steps run in a terminal that has loaded `terraform/.env`; the Wrangler steps run in any terminal, and the dashboard steps in the browser.

- [ ] **Log in to Wrangler.** Run `pnpm --filter '@resend-challenge/cloudflare-worker' exec wrangler login` and approve the request in the browser. Then run `export CLOUDFLARE_ACCOUNT_ID=<account-id>` in every terminal that runs Wrangler, replacing `<account-id>` with the account id from the Cloudflare dashboard, so that Wrangler never has to ask for the account. Success: `pnpm --filter '@resend-challenge/cloudflare-worker' exec wrangler whoami` shows the account.
- [ ] **Bootstrap the Terraform state bucket.** Run `pnpm --filter '@resend-challenge/cloudflare-worker' exec wrangler r2 bucket create resend-challenge-terraform-state`. Success: Wrangler reports the bucket as created. Terraform never manages this bucket; never delete it while the state lives there.
- [ ] **Create the credentials for Terraform.** Copy `terraform/.env.example` to `terraform/.env` (gitignored) and fill it in:
  - `TF_VAR_cloudflare_api_token`: a Cloudflare API token (**My Profile > API Tokens > Create Token > Custom token**) with **Account > D1 > Edit**, **Account > Workers R2 Storage > Edit** and **Account > Queues > Edit** for the account.
  - `TF_VAR_cloudflare_account_id`: from the overview page of the zone `patricktree.me` in the Cloudflare dashboard.
  - `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: an R2 API token (**R2 > Manage API tokens > Create API token**) with **Object Read & Write** on the bucket `resend-challenge-terraform-state`; the endpoint is `https://<account-id>.r2.cloudflarestorage.com`.
- [ ] **Create the infrastructure.** Load the credentials and apply:

  ```sh
  set -a && . terraform/.env && set +a
  terraform -chdir=terraform init
  terraform -chdir=terraform plan -out=production.tfplan
  terraform -chdir=terraform apply production.tfplan
  ```

  Success: `init` reports `Terraform has been successfully initialized!`, the plan creates 4 resources (D1 database, R2 bucket, two Queues), and `apply` ends with `Apply complete! Resources: 4 added, 0 changed, 0 destroyed.`

- [ ] **Copy the outputs into `wrangler.jsonc`.** Run `terraform -chdir=terraform output -raw d1_database_id` and replace the placeholder `00000000-0000-0000-0000-000000000000` in `d1_databases[0].database_id` of [`apps/cloudflare-worker/wrangler.jsonc`](apps/cloudflare-worker/wrangler.jsonc) with it; drop the word PLACEHOLDER from the comment above it. The other bindings refer to resources by name: check that `terraform -chdir=terraform output` shows `d1_database_name = "resend-challenge"`, `revision_bodies_bucket_name = "resend-challenge-revision-bodies"`, `send_queue_name = "resend-challenge-send"` and `send_dlq_name = "resend-challenge-send-dlq"`, the names `wrangler.jsonc` uses. Commit the change.
- [ ] **Create the Resend sending domain.** In the Resend dashboard, go to **Domains > Add Domain**, enter `resend-challenge.patricktree.me` and choose the region `eu-west-1` (Ireland). Leave the other options at their defaults. Success: the domain appears under **Domains**, and its page lists the DNS records to add.
- [ ] **Add the sending domain's DNS records.** In the Cloudflare dashboard, open the zone `patricktree.me`, go to **DNS > Records** and choose **Add record** once for each record the Resend domain page lists, typically an MX and an SPF TXT record on `send.resend-challenge` and a DKIM TXT record on `resend._domainkey.resend-challenge`. Copy each record's type, name, value and priority from the Resend domain page, not from this README, enter the name as Resend shows it (Cloudflare appends `.patricktree.me`), keep the TTL at **Auto** and set each record to **DNS only**, never proxied. Alternatively, choose **Sign in to Cloudflare** on the Resend domain page, which adds the records through Domain Connect once you authorize Resend's access to the zone. Success: **DNS > Records** shows every record from the Resend domain page under its full name, such as `send.resend-challenge.patricktree.me`, with the values unchanged.
- [ ] **Wait for the Resend domain verification.** On the Resend domain page, choose **Verify DNS Records**. Resend keeps checking on its own; verification often takes minutes, and Resend allows up to 72 hours for DNS propagation. Success: **Domains** in the Resend dashboard shows `resend-challenge.patricktree.me` as **Verified**.
- [ ] **Create the Worker's Resend API key.** In the Resend dashboard, go to **API Keys > Create API Key**, choose **Sending access** and the domain `resend-challenge.patricktree.me`. Resend shows the key only once; keep it for the step **Set the Resend API key**.
- [ ] **Generate the tokens.** Run `pnpm secrets:generate`. It writes a new public Agent token into `apps/cloudflare-worker/wrangler.jsonc`, this README and the CLI's fallback in `apps/cli/src/production.ts`, and pipes a new Reviewer token into `wrangler secret put REVIEWER_TOKEN`; if the Worker `resend-challenge` does not exist yet, Wrangler creates an empty one to hold the secret. Success: the script prints `Set the Worker secret REVIEWER_TOKEN.` followed by the Reviewer token. If Wrangler fails, the files already hold a new Agent token; fix the cause and run the script again. Store the Reviewer token in the password manager, since it is not shown again, and commit the changed `wrangler.jsonc`, `README.md` and `apps/cli/src/production.ts`.
- [ ] **Set the Resend API key.** Run `pnpm --filter '@resend-challenge/cloudflare-worker' exec wrangler secret put RESEND_API_KEY` and paste the sending-only key when Wrangler asks for it. Success: Wrangler prints `Success! Uploaded secret RESEND_API_KEY`.
- [ ] **Apply the D1 migrations.** Run `pnpm --filter '@resend-challenge/cloudflare-worker' run migrations:apply:remote` and confirm. Success: Wrangler lists every migration in `libs/email-drafts/migrations` with status ✅.
- [ ] **Deploy the Worker.** Run `pnpm --filter '@resend-challenge/cloudflare-worker' run deploy`, which builds the Worker with the Review UI as its static assets and runs `wrangler deploy`. Success: Wrangler lists the triggers `resend-challenge.patricktree.me (custom domain)`, `schedule: * * * * *`, `Producer for resend-challenge-send`, `Consumer for resend-challenge-send` and `Consumer for resend-challenge-send-dlq`. A first deploy of the custom domain can take a few minutes to serve.
- [ ] **Verify production.** Create and get a Draft with the public Agent token, as in [Over HTTP](#over-http): creating answers `201`, getting answers `200` with the body. Then check that production refuses the local tokens and redirects the root:

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

## Limitations and future work

The [spec](.scratch/email-draft-approval/spec.md) is the detailed source for each of these:

- [Demo simplifications](.scratch/email-draft-approval/spec.md#14-demo-simplifications): shared static tokens instead of per-person sign-in and per-Agent credentials, no observability, one production environment with manual deploys and no CI, and no retention policy.
- [Known limitations](.scratch/email-draft-approval/spec.md#15-known-limitations): CLI and MCP reads may briefly miss a write, create is not idempotent, a long Resend outage ends in `OUTCOME_UNKNOWN`, and other readers may see changes a moment late.
- [Future increments](.scratch/email-draft-approval/spec.md#16-future-increments): HTML bodies, discarding Drafts, delivery tracking, OAuth for `/mcp`, CI/CD, and a distributable CLI, among others.

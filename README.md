# Email Draft Approval

A gate between Agents that compose emails and the human Reviewer who must approve each email before it is sent through Resend. An Agent creates a Draft, revises it and submits it for review; the Reviewer approves or rejects exactly the Revision they read, and only an approved Revision is sent, at most once. See the [spec](.scratch/email-draft-approval/spec.md) for the design and [GLOSSARY.md](GLOSSARY.md) for the terms.

One Cloudflare Worker at <https://resend-challenge.patricktree.me> serves the HTTP API under `/api/v1`, the MCP server at `/mcp` and the Review UI under `/app`. It keeps Drafts in D1 and Revision bodies in R2, hands approved Drafts to a Cloudflare Queue whose consumer calls Resend, and runs a Send reconciler every minute. The published OpenAPI document is served at `/api/openapi.json`.

## Act as an Agent

The Agent token is public by design, so you can act as an Agent without any setup: `agent_placeholder-run-pnpm-secrets-generate`. If it starts with `agent_placeholder`, the production tokens have not been generated yet. Nothing is sent without the Reviewer token, which is never committed.

Create a Draft:

```sh
curl -sS -X POST https://resend-challenge.patricktree.me/api/v1/drafts \
  -H 'Authorization: Bearer agent_placeholder-run-pnpm-secrets-generate' \
  -H 'Content-Type: application/json' \
  -d '{"to":["delivered@resend.dev"],"subject":"Hello","body":{"plainText":"Hello from an Agent."}}'
```

The response is `201` with the Draft summary; its `id` starts with `drf_`. Get the Draft, including its body, with `curl -sS https://resend-challenge.patricktree.me/api/v1/drafts/<draft-id> -H 'Authorization: Bearer agent_placeholder-run-pnpm-secrets-generate'`, replacing `<draft-id>` with that `id`.

## Local development

Set up the repository as described in [AGENTS.md](AGENTS.md#environment-setup), including the copy of `apps/cloudflare-worker/.dev.vars.example` to `apps/cloudflare-worker/.dev.vars`. That file sets `LOCAL_DEVELOPMENT="true"` and takes your own `RESEND_API_KEY`; local Sends call the real Resend API, so send only to Resend's test recipients `delivered@resend.dev` and `bounced@resend.dev`.

Start the Worker:

```sh
pnpm dev
```

It applies the D1 migrations to the local database and serves the Worker at <http://localhost:5173>, with D1, R2 and the Queue running locally in Miniflare. Wrangler warns that the required secret `REVIEWER_TOKEN` is missing; local development uses the local tokens instead.

Call the local API with the local tokens from [`libs/api.routes/src/local-tokens.ts`](libs/api.routes/src/local-tokens.ts), which only a Worker with `LOCAL_DEVELOPMENT="true"` accepts, and only on `localhost`:

```sh
curl -sS -X POST http://localhost:5173/api/v1/drafts \
  -H 'Authorization: Bearer agent_local-development-only' \
  -H 'Content-Type: application/json' \
  -d '{"to":["delivered@resend.dev"],"subject":"Hello","body":{"plainText":"Hello from a local Agent."}}'
```

The cron trigger does not fire locally. Run the Send reconciler by calling the scheduled handler, which answers `200` with `ok`:

```sh
curl -sS 'http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*'
```

## Validation

Run `pnpm validate:fast` for the format check, markdownlint, Knip, build and typecheck, lint, and the unit and integration tests, and `pnpm validate:extended` for the e2e tests. [AGENTS.md](AGENTS.md#validation) describes both.

## Infrastructure

| Owner                                                     | Manages                                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Terraform](terraform/)                                   | The D1 database (read replication `auto`), the R2 bucket for Revision bodies, the Send Queue and the Send DLQ, the Resend sending domain and its DNS records |
| [`wrangler.jsonc`](apps/cloudflare-worker/wrangler.jsonc) | The Worker, its custom domain, the cron trigger, the Queue producer and consumers, the bindings and the vars                                                 |
| `wrangler secret put`                                     | The secrets `REVIEWER_TOKEN` and `RESEND_API_KEY`                                                                                                            |
| By hand, once                                             | The R2 bucket `draft-approval-terraform-state` that holds the Terraform state                                                                                |

There is only a production environment. Deploys run by hand, in this order: `terraform apply`, then `wrangler d1 migrations apply --remote`, then `wrangler deploy`. The next section lists every command.

## Human steps

These steps need Patrick's Cloudflare and Resend accounts, so no agent runs them. Run them in order, each from the repository root. The Terraform steps run in a terminal that has loaded `terraform/.env`; the Wrangler steps run in any terminal.

- [ ] **Log in to Wrangler.** Run `pnpm --filter '@draft-approval/cloudflare-worker' exec wrangler login` and approve the request in the browser. Then run `export CLOUDFLARE_ACCOUNT_ID=<account-id>` in every terminal that runs Wrangler, replacing `<account-id>` with the account id from the Cloudflare dashboard, so that Wrangler never has to ask for the account. Success: `pnpm --filter '@draft-approval/cloudflare-worker' exec wrangler whoami` shows the account.
- [ ] **Bootstrap the Terraform state bucket.** Run `pnpm --filter '@draft-approval/cloudflare-worker' exec wrangler r2 bucket create draft-approval-terraform-state`. Success: Wrangler reports the bucket as created. Terraform never manages this bucket; never delete it while the state lives there.
- [ ] **Create the credentials for Terraform.** Copy `terraform/.env.example` to `terraform/.env` (gitignored) and fill it in:
  - `TF_VAR_cloudflare_api_token`: a Cloudflare API token (**My Profile > API Tokens > Create Token > Custom token**) with **Account > D1 > Edit**, **Account > Workers R2 Storage > Edit** and **Account > Queues > Edit** for the account, and **Zone > DNS > Edit** for the zone `patricktree.me`.
  - `TF_VAR_cloudflare_account_id` and `TF_VAR_cloudflare_zone_id`: from the overview page of the zone `patricktree.me` in the Cloudflare dashboard.
  - `TF_VAR_resend_management_api_key`: a Resend API key with **Full access** (**API Keys > Create API Key**), used only by Terraform.
  - `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: an R2 API token (**R2 > Manage API tokens > Create API token**) with **Object Read & Write** on the bucket `draft-approval-terraform-state`; the endpoint is `https://<account-id>.r2.cloudflarestorage.com`.
- [ ] **Create the infrastructure.** Load the credentials and apply:

  ```sh
  set -a && . terraform/.env && set +a
  terraform -chdir=terraform init
  terraform -chdir=terraform plan -out=production.tfplan
  terraform -chdir=terraform apply production.tfplan
  ```

  Success: `init` reports `Terraform has been successfully initialized!`, the plan creates 9 resources (D1 database, R2 bucket, two Queues, Resend domain, three DNS records, domain verification), and `apply` ends with `Apply complete! Resources: 9 added, 0 changed, 0 destroyed.`

- [ ] **Copy the outputs into `wrangler.jsonc`.** Run `terraform -chdir=terraform output -raw d1_database_id` and replace the placeholder `00000000-0000-0000-0000-000000000000` in `d1_databases[0].database_id` of [`apps/cloudflare-worker/wrangler.jsonc`](apps/cloudflare-worker/wrangler.jsonc) with it; drop the word PLACEHOLDER from the comment above it. The other bindings refer to resources by name: check that `terraform -chdir=terraform output` shows `revision_bodies_bucket_name = "draft-approval-revision-bodies"`, `send_queue_name = "draft-approval-send"` and `send_dlq_name = "draft-approval-send-dlq"`, the names `wrangler.jsonc` uses. Commit the change.
- [ ] **Wait for the Resend domain verification.** DNS propagation can take from minutes to hours. Check the status with the management key from `terraform/.env`:

  ```sh
  domain_id="$(terraform -chdir=terraform output -raw resend_domain_id)"
  curl -sS "https://api.resend.com/domains/${domain_id}" \
    -H "Authorization: Bearer ${TF_VAR_resend_management_api_key}"
  ```

  Success: the response has `"status":"verified"`, and **Domains** in the Resend dashboard shows `resend-challenge.patricktree.me` as **Verified**.

- [ ] **Create the Worker's Resend API key.** In the Resend dashboard, go to **API Keys > Create API Key**, choose **Sending access** and the domain `resend-challenge.patricktree.me`. Resend shows the key only once; keep it for the step **Set the Resend API key**.
- [ ] **Generate the tokens.** Run `pnpm secrets:generate`. It writes a new public Agent token into `apps/cloudflare-worker/wrangler.jsonc` and this README, and pipes a new Reviewer token into `wrangler secret put REVIEWER_TOKEN`; if the Worker `draft-approval` does not exist yet, Wrangler creates an empty one to hold the secret. Success: the script prints `Set the Worker secret REVIEWER_TOKEN.` followed by the Reviewer token. Store the Reviewer token in the password manager, since it is not shown again, and commit the changed `wrangler.jsonc` and `README.md`.
- [ ] **Set the Resend API key.** Run `pnpm --filter '@draft-approval/cloudflare-worker' exec wrangler secret put RESEND_API_KEY` and paste the sending-only key when Wrangler asks for it. Success: Wrangler prints `Success! Uploaded secret RESEND_API_KEY`.
- [ ] **Apply the D1 migrations.** Run `pnpm --filter '@draft-approval/cloudflare-worker' run migrations:apply:remote` and confirm. Success: Wrangler lists every migration in `libs/drafts/migrations` with status ✅.
- [ ] **Deploy the Worker.** Run `pnpm --filter '@draft-approval/cloudflare-worker' run deploy`, which builds the Worker and runs `wrangler deploy`. Success: Wrangler lists the triggers `resend-challenge.patricktree.me (custom domain)`, `schedule: * * * * *`, `Producer for draft-approval-send`, `Consumer for draft-approval-send` and `Consumer for draft-approval-send-dlq`. A first deploy of the custom domain can take a few minutes to serve.
- [ ] **Verify production.** Create and get a Draft with the public Agent token, as in [Act as an Agent](#act-as-an-agent): creating answers `201`, getting answers `200` with the body. Then check that production refuses the local tokens and redirects the root:

  ```sh
  curl -sS -o /dev/null -w '%{http_code}\n' https://resend-challenge.patricktree.me/api/v1/drafts/drf_00000000-0000-7000-8000-000000000000 \
    -H 'Authorization: Bearer agent_local-development-only'
  curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://resend-challenge.patricktree.me/
  ```

  Success: the first command prints `401`, the second `302 https://resend-challenge.patricktree.me/app/`.

- [ ] **Run the live Resend contract test** once it exists (ticket 08): `pnpm test:resend-live` with the sending-only key, which sends only to `delivered@resend.dev`.

Every later deploy is `terraform apply` if `terraform/` changed, then the migrations step, then the deploy step. To rotate a token, run `pnpm secrets:generate` again and redeploy; the old tokens stop working with no overlap.

## Development

See [AGENTS.md](AGENTS.md) for setup, commands and conventions.

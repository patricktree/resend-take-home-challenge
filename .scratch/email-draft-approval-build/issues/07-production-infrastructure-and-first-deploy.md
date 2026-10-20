# 07: Production infrastructure and first deploy

**What to build:** The system runs in production at `resend-challenge.patricktree.me`: an evaluator can create and get a Draft there with the public Agent token. Later tickets only redeploy. Spec: [Infrastructure, configuration and local development](../../email-draft-approval/spec.md#12-infrastructure-configuration-and-local-development).

**Blocked by:** 02 (Create and get a Draft)

**Status:** done except deploy (<https://github.com/patricktree/resend-take-home-challenge/pull/4>); the deploy is the README's Human steps

- [x] Terraform (Cloudflare provider v5, Resend provider, R2 S3-backend state with a documented manual bootstrap) for D1 (read replication `auto`), the R2 body bucket, Send Queue, Send DLQ, and the Resend sending domain with its DNS records
- [x] Production `wrangler.jsonc`: custom-domain route, cron every minute, Queue producer and both consumers with the spec's settings, bindings with committed resource ids, vars, `secrets.required` for `REVIEWER_TOKEN` and `RESEND_API_KEY`, `nodejs_compat`, `workers_dev: false`, `preview_urls: false`
- [x] `pnpm secrets:generate` writes the Agent token into the config and pipes the Reviewer token into `wrangler secret put`, printing it once
- [x] README: deploy order (`terraform apply` → remote migrations → `wrangler deploy`), the public Agent token, local development, triggering the cron locally
- [ ] Deployed; create and get verified against production; local tokens refused there

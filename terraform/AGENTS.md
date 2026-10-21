# Terraform

- Terraform creates the resources `apps/cloudflare-worker/wrangler.jsonc` binds, with only the Cloudflare provider (pinned, lock file committed); the Resend sending domain and its DNS records are human steps, so add no Resend provider.
- After changing `terraform/`, run `terraform -chdir=terraform fmt` and `terraform -chdir=terraform init -backend=false && terraform -chdir=terraform validate` from the repository root; they need Terraform 1.10 or newer and are not part of `pnpm validate:fast`.

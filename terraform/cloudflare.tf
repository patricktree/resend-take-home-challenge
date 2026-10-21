locals {
  # Spec section 9: retention stays at least at the default 4 days, never below 24 h, so a message
  # outlives its Send's 23 h deadline.
  queue_message_retention_seconds = 4 * 24 * 60 * 60
}

# The names must match the bindings in apps/cloudflare-worker/wrangler.jsonc, which refers to the
# R2 bucket and the Queues by name and to the D1 database by the id from `terraform output`.

resource "cloudflare_d1_database" "drafts" {
  account_id = var.cloudflare_account_id
  name       = "resend-challenge"

  read_replication = {
    mode = "auto"
  }
}

resource "cloudflare_r2_bucket" "revision_bodies" {
  account_id = var.cloudflare_account_id
  name       = "resend-challenge-revision-bodies"
}

resource "cloudflare_queue" "send" {
  account_id = var.cloudflare_account_id
  queue_name = "resend-challenge-send"

  settings = {
    message_retention_period = local.queue_message_retention_seconds
  }
}

resource "cloudflare_queue" "send_dlq" {
  account_id = var.cloudflare_account_id
  queue_name = "resend-challenge-send-dlq"

  settings = {
    message_retention_period = local.queue_message_retention_seconds
  }
}

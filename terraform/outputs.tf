output "d1_database_id" {
  description = "Goes into `d1_databases[0].database_id` of apps/cloudflare-worker/wrangler.jsonc."
  value       = cloudflare_d1_database.drafts.id
}

output "d1_database_name" {
  description = "Must equal `d1_databases[0].database_name` of wrangler.jsonc."
  value       = cloudflare_d1_database.drafts.name
}

output "revision_bodies_bucket_name" {
  description = "Must equal `r2_buckets[0].bucket_name` of wrangler.jsonc."
  value       = cloudflare_r2_bucket.revision_bodies.name
}

output "send_queue_name" {
  description = "Must equal the Send Queue's producer and consumer `queue` in wrangler.jsonc."
  value       = cloudflare_queue.send.queue_name
}

output "send_queue_id" {
  description = "The Send Queue's id, for the Cloudflare dashboard and API."
  value       = cloudflare_queue.send.queue_id
}

output "send_dlq_name" {
  description = "Must equal the Send Queue consumer's `dead_letter_queue` and the DLQ consumer's `queue` in wrangler.jsonc."
  value       = cloudflare_queue.send_dlq.queue_name
}

output "send_dlq_id" {
  description = "The Send DLQ's id, for the Cloudflare dashboard and API."
  value       = cloudflare_queue.send_dlq.queue_id
}

output "resend_domain_id" {
  description = "The Resend sending domain's id."
  value       = resend_domain.sending.id
}

output "resend_domain_status" {
  description = "The sending domain's verification status as of the last apply or refresh; `verified` before the first real Send."
  value       = resend_domain.sending.status
}

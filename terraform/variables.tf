variable "cloudflare_api_token" {
  description = "A Cloudflare API token that may edit D1, R2 and Queues in the account and DNS in the zone."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "The Cloudflare account that owns the D1 database, the R2 bucket and the Queues."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "The Cloudflare zone of patricktree.me, which receives the Resend verification records."
  type        = string
}

variable "resend_management_api_key" {
  description = "A full-access Resend API key for managing the sending domain; not the Worker's sending-only key."
  type        = string
  sensitive   = true
}

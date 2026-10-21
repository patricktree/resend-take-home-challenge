variable "cloudflare_api_token" {
  description = "A Cloudflare API token that may edit D1, R2 and Queues in the account."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "The Cloudflare account that owns the D1 database, the R2 bucket and the Queues."
  type        = string
}

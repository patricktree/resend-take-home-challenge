locals {
  zone_name         = "patricktree.me"
  sending_subdomain = "resend-challenge"
  sending_domain    = "${local.sending_subdomain}.${local.zone_name}"

  # The records Resend requires for a sending domain without tracking. The keys are static so that
  # `for_each` is known at plan time, while the values are only known once the domain exists.
  verification_records = {
    dkim = one([for record in resend_domain.sending.records : record if record.record == "DKIM"])
    spf_mx = one([
      for record in resend_domain.sending.records : record
      if record.record == "SPF" && record.type == "MX"
    ])
    spf_txt = one([
      for record in resend_domain.sending.records : record
      if record.record == "SPF" && record.type == "TXT"
    ])
  }
}

# Resend sends from its EU region (Ireland), close to the operator.
resource "resend_domain" "sending" {
  name           = local.sending_domain
  region         = "eu-west-1"
  open_tracking  = false
  click_tracking = false
  tls            = "opportunistic"
}

resource "cloudflare_dns_record" "resend_verification" {
  for_each = local.verification_records

  zone_id = var.cloudflare_zone_id
  # Resend names a subdomain's records relative to the root domain (`send.resend-challenge`).
  # Trimming that suffix and appending the sending domain yields the full name either way.
  name    = "${trimsuffix(each.value.name, ".${local.sending_subdomain}")}.${local.sending_domain}"
  type    = each.value.type
  content = each.value.type == "TXT" ? "\"${each.value.value}\"" : each.value.value
  # Resend asks for "Auto"; 1 is Cloudflare's automatic TTL.
  ttl      = 1
  priority = each.value.type == "MX" ? tonumber(each.value.priority) : null
  proxied  = false
  comment  = "Resend verification for ${local.sending_domain}, managed by Terraform"
}

# Asks Resend to check the records once they exist; Resend keeps checking on its own until the
# domain is verified, which can take a while (README, "Human steps").
resource "resend_domain_verification" "sending" {
  domain_id = resend_domain.sending.id

  depends_on = [cloudflare_dns_record.resend_verification]
}

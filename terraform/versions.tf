terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  # The state lives in an R2 bucket created once by hand (README, "Human steps"). The endpoint
  # (`AWS_ENDPOINT_URL_S3`) and the R2 credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
  # come from the environment, so no account id or credential is committed.
  # See https://developers.cloudflare.com/terraform/advanced-topics/remote-backend/.
  backend "s3" {
    bucket = "draft-approval-terraform-state"
    key    = "production/terraform.tfstate"
    region = "auto"
    # R2 supports conditional writes, which the S3 backend's lock file relies on.
    use_lockfile = true

    # R2 is S3-compatible but not AWS: skip the AWS-only checks and use path-style requests.
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
    resend = {
      source  = "y0n0zawa/resend"
      version = "1.0.1"
    }
  }
}

provider "cloudflare" {
  # A variable rather than the provider default CLOUDFLARE_API_TOKEN, which Wrangler would also pick up.
  api_token = var.cloudflare_api_token
}

provider "resend" {
  api_key = var.resend_management_api_key
}

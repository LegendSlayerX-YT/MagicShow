#!/usr/bin/env bash
# Deploy the Worker, then push the API keys from .dev.vars as secrets.
# Secrets live only on Cloudflare — .dev.vars is gitignored and never uploaded
# as part of the Worker bundle.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .dev.vars ]; then
  echo "Missing .dev.vars — copy .dev.vars.example and fill in your keys." >&2
  exit 1
fi

# Deploy first: `secret bulk` needs the Worker to already exist.
npx wrangler deploy

# Reads KEY=VALUE lines from .dev.vars and stores each as an encrypted secret.
npx wrangler secret bulk .dev.vars

echo
echo "Deployed. Verifying the relay..."
npx wrangler secret list

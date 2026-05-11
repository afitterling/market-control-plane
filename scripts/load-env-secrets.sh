#!/bin/sh
# Bootstrap SST secrets from .env.
#
# Reads API_BEARER_TOKEN, FMP_API_KEY, and PULSE_REFRESH_TOKEN from .env and
# stores them as SST secrets via `npx sst secret set` so the deployed Lambdas
# can read them via Resource.<Name>.value (encrypted, no plain-text env vars).
#
# Pass an SST stage via STAGE=... or as the first argument. Defaults to dev.

set -eu

STAGE="${STAGE:-${1:-dev}}"

if [ ! -f .env ]; then
  echo "load-env-secrets: .env not found in $(pwd)" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
. ./.env
set +a

set_secret() {
  name="$1"
  value="$2"
  if [ -z "$value" ]; then
    echo "load-env-secrets: $name is empty in .env, skipping"
    return
  fi
  echo "load-env-secrets: setting $name on stage $STAGE"
  npx sst secret set "$name" "$value" --stage "$STAGE"
}

set_secret API_BEARER_TOKEN "${API_BEARER_TOKEN:-}"
set_secret FMP_API_KEY "${FMP_API_KEY:-}"
set_secret PULSE_REFRESH_TOKEN "${PULSE_REFRESH_TOKEN:-}"

echo "load-env-secrets: done"

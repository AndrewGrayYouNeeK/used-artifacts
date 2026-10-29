#!/usr/bin/env bash
# One-time setup for a throwaway test preview: local Postgres, a dev .env with simulators
# (fake checkout, fake ID check, console email, canned photo analysis), and demo data.
# Safe to re-run. Never point this at a real database.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v psql >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null
fi
sudo service postgresql start >/dev/null

pg() { sudo -u postgres psql -qtAc "$1"; }
[ "$(pg "select 1 from pg_roles where rolname = 'ua'")" = 1 ] || pg "create role ua login password 'ua' createdb"
[ "$(pg "select 1 from pg_database where datname = 'used_artifacts'")" = 1 ] || sudo -u postgres createdb -O ua used_artifacts

if [ ! -f .env ]; then
  secret() { openssl rand -hex 32; }
  cat > .env <<EOF
# Test preview only: simulators everywhere, local database, throwaway secrets.
DATABASE_URL="postgresql://ua:ua@localhost:5432/used_artifacts"
APP_URL="http://localhost:3000"
IP_HASH_SECRET="$(secret)"
TWO_FACTOR_ENCRYPTION_KEY="$(secret)"
IDENTITY_FINGERPRINT_SECRET="$(secret)"
LINKAGE_HASH_SECRET="$(secret)"
CRON_SECRET="$(secret)"
PAYMENTS_PROVIDER="fake"
IDENTITY_PROVIDER="fake"
AI_VISION_PROVIDER="fake"
STORAGE_DRIVER=local
LOCAL_STORAGE_DIR=".data/uploads"
SHIPPING_TRACKER=manual
ENABLED_VERTICALS=ARTIFACT
AUCTIONS_ENABLED=false
BETA_INVITE_REQUIRED=true
# Off so demo staff logins open /admin without an authenticator app. Production keeps it on.
STAFF_TWO_FACTOR_REQUIRED=false
EOF
fi

npm ci
npx prisma migrate deploy
npm run db:seed
npm run demo:seed

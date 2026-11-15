#!/usr/bin/env bash
# Apply the meeting-sync migration twice against a local Postgres stand-in.
# Does not touch a hosted Supabase project.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${MEETING_SYNC_TEST_DB:-apex_meeting_sync_test}"

if command -v psql >/dev/null && psql -d postgres -c 'select 1' >/dev/null 2>&1; then
  PSQL=(psql)
  DROPDB=(dropdb)
  CREATEDB=(createdb)
elif sudo -u postgres psql -d postgres -c 'select 1' >/dev/null 2>&1; then
  PSQL=(sudo -u postgres psql)
  DROPDB=(sudo -u postgres dropdb)
  CREATEDB=(sudo -u postgres createdb)
else
  echo "psql is not available" >&2
  exit 1
fi

"${DROPDB[@]}" --if-exists "$DB"
"${CREATEDB[@]}" "$DB"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/supabase/tests/standin_schema.sql"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/supabase/migrations/20261115120000_meeting_sync_foundation.sql"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/supabase/tests/meeting_sync_foundation_test.sql"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/supabase/migrations/20261115120000_meeting_sync_foundation.sql"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/supabase/tests/meeting_sync_foundation_test.sql"
echo "meeting sync migration ok"

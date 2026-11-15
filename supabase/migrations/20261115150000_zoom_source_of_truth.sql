-- Zoom as a source of truth for meeting ids, recordings, and deauthorization.
--
-- Idempotent. Does not delete meeting rows. Apply after the field-ownership
-- migration. Nothing here is applied to the live project by the agent.
--
-- What the owner configures in the Zoom Marketplace app is listed in the
-- pull request. This script does not contain secrets.
--
-- Recording choice: transcript text is copied into meeting_recordings, and
-- video or audio is copied into the private meeting-recordings bucket only
-- when the file is 25 MB or smaller. Larger files keep Zoom's share URL.
-- Zoom download URLs expire in 24 hours and need the host token, so a
-- link-only transcript would die the next time the connection is revoked.

-- ---------------------------------------------------------------------------
-- Meeting ids. One Calendly row can share a Zoom id with other invitees, so
-- the column is indexed and not unique. Superseded ids live in aliases.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.extract_zoom_meeting_id(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  value text := lower(btrim(raw));
  found text;
BEGIN
  IF value IS NULL OR value = '' THEN
    RETURN NULL;
  END IF;
  IF value ~ '^[0-9]{9,13}$' THEN
    RETURN value;
  END IF;

  found := substring(value from 'zoom\.us/(?:j|s|w|wc/join)/([0-9]{9,13})');
  IF found IS NOT NULL THEN
    RETURN found;
  END IF;
  found := substring(value from 'confno=([0-9]{9,13})');
  IF found IS NOT NULL THEN
    RETURN found;
  END IF;
  found := substring(value from 'zoom:([0-9]{9,13})');
  IF found IS NOT NULL THEN
    RETURN found;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.extract_zoom_meeting_id(text) IS
  'Numeric Zoom meeting id from a join URL, confno query, or zoom:<id> uri. Null when the text has no id.';

REVOKE ALL ON FUNCTION public.extract_zoom_meeting_id(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.extract_zoom_meeting_id(text) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RAISE NOTICE 'public.meetings is missing; skipped Zoom meeting columns';
    RETURN;
  END IF;

  ALTER TABLE public.meetings
    ADD COLUMN IF NOT EXISTS zoom_meeting_id text,
    ADD COLUMN IF NOT EXISTS zoom_meeting_uuid text,
    ADD COLUMN IF NOT EXISTS provider_summary text;

  CREATE INDEX IF NOT EXISTS idx_meetings_zoom_meeting_id
    ON public.meetings (zoom_meeting_id)
    WHERE zoom_meeting_id IS NOT NULL;

  COMMENT ON COLUMN public.meetings.zoom_meeting_id IS
    'Numeric Zoom meeting id. Filled from Calendly location.data.id or the join URL, and from meetings the CRM creates. Not unique: a group event shares one Zoom meeting.';
  COMMENT ON COLUMN public.meetings.provider_summary IS
    'Latest Zoom AI summary or transcript recap. Sync may replace it. It is not copied into meetings.notes.';
END $$;

-- Browser edits must not clear a summary the webhook stored.
CREATE OR REPLACE FUNCTION public.guard_meeting_provider_summary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  jwt_role text := coalesce(auth.role(), '');
  privileged boolean;
BEGIN
  privileged := jwt_role IN ('service_role', 'supabase_admin')
    OR (
      jwt_role = ''
      AND session_user IN ('postgres', 'supabase_admin', 'supabase_auth_admin')
    );
  IF TG_OP = 'UPDATE' AND NOT privileged THEN
    NEW.provider_summary := OLD.provider_summary;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'meetings' AND column_name = 'provider_summary'
  ) THEN
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS guard_meeting_provider_summary ON public.meetings;
  CREATE TRIGGER guard_meeting_provider_summary
    BEFORE UPDATE ON public.meetings
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_meeting_provider_summary();
END $$;

REVOKE ALL ON FUNCTION public.guard_meeting_provider_summary() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Backfill. Safe to run again: it only fills a null zoom_meeting_id.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.backfill_zoom_meeting_ids()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  n integer := 0;
  touched integer;
  location_type text;
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.meetings
  SET zoom_meeting_id = substring(external_event_uri from '^zoom:([0-9]{9,13})$')
  WHERE zoom_meeting_id IS NULL
    AND external_event_uri ~ '^zoom:[0-9]{9,13}$';
  GET DIAGNOSTICS touched = ROW_COUNT;
  n := n + touched;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'meetings' AND column_name = 'meeting_url'
  ) THEN
    UPDATE public.meetings
    SET zoom_meeting_id = public.extract_zoom_meeting_id(meeting_url)
    WHERE zoom_meeting_id IS NULL
      AND public.extract_zoom_meeting_id(meeting_url) IS NOT NULL;
    GET DIAGNOSTICS touched = ROW_COUNT;
    n := n + touched;
  END IF;

  SELECT data_type INTO location_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'meetings' AND column_name = 'location';

  IF location_type = 'jsonb' THEN
    UPDATE public.meetings
    SET zoom_meeting_id = COALESCE(
      CASE
        WHEN (location -> 'data' ->> 'id') ~ '^[0-9]{9,13}$' THEN location -> 'data' ->> 'id'
        ELSE NULL
      END,
      public.extract_zoom_meeting_id(location ->> 'join_url'),
      public.extract_zoom_meeting_id(location ->> 'location'),
      public.extract_zoom_meeting_id(location::text)
    )
    WHERE zoom_meeting_id IS NULL
      AND location IS NOT NULL
      AND COALESCE(
        CASE
          WHEN (location -> 'data' ->> 'id') ~ '^[0-9]{9,13}$' THEN location -> 'data' ->> 'id'
          ELSE NULL
        END,
        public.extract_zoom_meeting_id(location ->> 'join_url'),
        public.extract_zoom_meeting_id(location ->> 'location'),
        public.extract_zoom_meeting_id(location::text)
      ) IS NOT NULL;
    GET DIAGNOSTICS touched = ROW_COUNT;
    n := n + touched;
  ELSIF location_type IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE public.meetings
      SET zoom_meeting_id = public.extract_zoom_meeting_id(location::text)
      WHERE zoom_meeting_id IS NULL
        AND public.extract_zoom_meeting_id(location::text) IS NOT NULL
    $sql$;
    GET DIAGNOSTICS touched = ROW_COUNT;
    n := n + touched;
  END IF;

  IF to_regclass('public.meeting_external_aliases') IS NOT NULL THEN
    INSERT INTO public.meeting_external_aliases (meeting_id, provider, kind, external_id)
    SELECT id, 'zoom', 'zoom_meeting', zoom_meeting_id
    FROM public.meetings
    WHERE zoom_meeting_id IS NOT NULL
    ON CONFLICT (provider, kind, external_id) DO NOTHING;
  END IF;

  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.backfill_zoom_meeting_ids() IS
  'Fills meetings.zoom_meeting_id from zoom:<id>, the join URL, or Calendly location JSON. Does not replace an id that is already stored.';

REVOKE ALL ON FUNCTION public.backfill_zoom_meeting_ids() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.backfill_zoom_meeting_ids() TO service_role;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Recordings. New columns are nullable. The private bucket holds copies.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.meeting_recordings') IS NULL THEN
    RAISE NOTICE 'public.meeting_recordings is missing; skipped recording columns. The live table is expected to exist before this migration.';
    RETURN;
  END IF;

  ALTER TABLE public.meeting_recordings
    ADD COLUMN IF NOT EXISTS lead_id uuid,
    ADD COLUMN IF NOT EXISTS zoom_uuid text,
    ADD COLUMN IF NOT EXISTS transcript_text text,
    ADD COLUMN IF NOT EXISTS storage_path text,
    ADD COLUMN IF NOT EXISTS transcript_storage_path text,
    ADD COLUMN IF NOT EXISTS share_url text,
    ADD COLUMN IF NOT EXISTS storage_error text,
    ADD COLUMN IF NOT EXISTS recording_passcode text,
    ADD COLUMN IF NOT EXISTS stored_files jsonb;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index ix
    JOIN pg_class idx ON idx.oid = ix.indexrelid
    JOIN pg_class tbl ON tbl.oid = ix.indrelid
    JOIN pg_namespace nsp ON nsp.oid = tbl.relnamespace
    WHERE nsp.nspname = 'public'
      AND tbl.relname = 'meeting_recordings'
      AND ix.indisunique
      AND (
        SELECT array_agg(att.attname ORDER BY k.ord)
        FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute att ON att.attrelid = ix.indrelid AND att.attnum = k.attnum
        WHERE k.attnum > 0
      ) = ARRAY['provider', 'external_meeting_id']::name[]
  ) THEN
    BEGIN
      CREATE UNIQUE INDEX meeting_recordings_provider_external_uidx
        ON public.meeting_recordings (provider, external_meeting_id);
    EXCEPTION WHEN unique_violation THEN
      RAISE WARNING 'meeting_recordings_provider_external_uidx was not created because duplicate provider/external ids exist: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage.buckets is missing; create a private bucket named meeting-recordings (30 MB file limit, not public) before relying on copied recordings.';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public)
  VALUES ('meeting-recordings', 'meeting-recordings', false)
  ON CONFLICT (id) DO UPDATE SET public = false;

  -- No authenticated policy. The browser receives a signed URL from
  -- zoom-recording-access after RLS confirms it can read the recording row.
  -- Service role uploads bypass storage RLS.
END $$;

-- ---------------------------------------------------------------------------
-- Revoked Zoom connections stay visible so Settings can say reconnect.
-- token_status gains 'revoked'. Stale OAuth states for a revoked user go away.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.zoom_connections') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE public.zoom_connections DROP CONSTRAINT IF EXISTS zoom_connections_token_status_check;
  ALTER TABLE public.zoom_connections
    ADD CONSTRAINT zoom_connections_token_status_check
    CHECK (token_status IS NULL OR token_status IN ('valid', 'expired', 'refresh_failed', 'missing', 'revoked'));
END $$;

DO $$
BEGIN
  IF to_regclass('public.zoom_oauth_states') IS NULL OR to_regclass('public.zoom_connections') IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM public.zoom_oauth_states s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.zoom_connections c
    WHERE c.user_id = s.user_id AND c.revoked_at IS NULL
  );
END $$;

DO $$
DECLARE
  n integer;
BEGIN
  n := public.backfill_zoom_meeting_ids();
  RAISE NOTICE 'backfilled % zoom meeting id(s)', n;
END $$;

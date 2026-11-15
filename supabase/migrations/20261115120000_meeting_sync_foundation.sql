-- Meeting sync foundation (Calendly + Zoom).
--
-- Idempotent. Safe to run more than once. Does not delete meeting rows.
-- Apply this yourself after the security-hardening migration. Do not run it
-- from an automated agent against the live project.
--
-- What it does:
--   * Keeps provider status from overwriting a status an advisor set.
--   * Completes past Calendly/Zoom meetings that are still "scheduled",
--     including the stale rows left behind when sync stopped. Re-running
--     only touches rows that are still scheduled and not advisor-owned.
--   * Stops group events from collapsing onto one row (the event URI is no
--     longer unique; each invitee URI is).
--   * Records superseded invitee URIs so a reschedule keeps the same meeting
--     id, and therefore client_id, lead_id, and notes.
--   * Logs webhook deliveries so retries are no-ops.
--   * Copies token expiry (never the token) onto the connection row the app
--     can already read, and schedules a reconcile.
--
-- Not in this migration: matching invitee email to clients/leads, or storing
-- a Zoom meeting id on Calendly rows. meeting_external_aliases.kind is the
-- hook for a later Zoom id (kind = 'zoom_meeting') without a new table.
--
-- Before the scheduled sync will run, do these once in the Supabase dashboard.
-- The migration does not embed secrets.
--
--   1. Database → Extensions: enable pg_cron, pg_net, and supabase_vault
--      if this script reports that it could not. Then run this script again.
--   2. SQL editor, as postgres (replace the placeholders; do not commit them):
--        select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--        select vault.create_secret('<service_role_key>', 'service_role_key');
--      If a secret with that name already exists, update it instead of creating
--      a second one. The cron job reads those two names and no others.
--   3. Deploy functions (see the pull request checklist) and wait for the
--      integration-reconcile job, or run: select public.run_integration_maintenance();
--   4. Confirm:
--        select jobname, schedule, active from cron.job where jobname = 'integration-reconcile';
--        select user_id, token_status, token_expires_at, last_synced_at, last_sync_error
--          from public.calendly_connections where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Extensions. Missing packages are reported and skipped so the rest still runs
-- on a local Postgres that does not ship pg_cron / pg_net / vault.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron was not enabled (%). Enable it under Database → Extensions and re-run this migration.', SQLERRM;
  END;

  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_net;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_net was not enabled (%). Enable it under Database → Extensions and re-run this migration.', SQLERRM;
  END;

  BEGIN
    CREATE EXTENSION IF NOT EXISTS supabase_vault;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'supabase_vault was not enabled (%). Vault is already present on hosted Supabase; enable the extension locally if you need it.', SQLERRM;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- Meeting columns and the advisor status lock.
-- status_origin: advisor (set in the app), provider (Calendly/Zoom), system
-- (past-meeting auto-complete). NULL means no one has claimed it yet.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RAISE NOTICE 'public.meetings is missing; skipped meeting sync columns';
    RETURN;
  END IF;

  ALTER TABLE public.meetings
    ADD COLUMN IF NOT EXISTS status_origin text,
    ADD COLUMN IF NOT EXISTS rescheduled_from_invitee_uri text;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'meetings_status_origin_check'
      AND conrelid = 'public.meetings'::regclass
  ) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_status_origin_check
      CHECK (status_origin IS NULL OR status_origin IN ('provider', 'advisor', 'system'));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NOT NULL THEN
    COMMENT ON COLUMN public.meetings.status_origin IS
      'Who last set meetings.status. advisor blocks provider and auto-complete overwrites until a reschedule. provider is Calendly or Zoom. system is the past-meeting auto-complete.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_meeting_status_origin()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  jwt_role text := coalesce(auth.role(), '');
BEGIN
  IF jwt_role IN ('service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- SQL editor and the migration itself have no end-user JWT.
  IF jwt_role = '' AND session_user IN ('postgres', 'supabase_admin', 'supabase_auth_admin') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A brand-new scheduled meeting stays unlocked so Zoom/Calendly can still
    -- complete it. Choosing another status at create time is an advisor choice.
    IF NEW.status IS NOT NULL AND NEW.status IS DISTINCT FROM 'scheduled' THEN
      NEW.status_origin := 'advisor';
    ELSE
      NEW.status_origin := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_origin := 'advisor';
  ELSE
    NEW.status_origin := OLD.status_origin;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS guard_meeting_status_origin ON public.meetings;
  CREATE TRIGGER guard_meeting_status_origin
    BEFORE INSERT OR UPDATE ON public.meetings
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_meeting_status_origin();
END $$;

-- ---------------------------------------------------------------------------
-- One row per invitee. Group events share an event URI, so that column must
-- not be unique. Zoom rows have no invitee URI and stay unique on the event.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT
      con.conname,
      (
        SELECT array_agg(att.attname ORDER BY u.ord)
        FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum
      ) AS col_names
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'meetings'
      AND con.contype = 'u'
  LOOP
    IF r.col_names = ARRAY['external_event_uri']::name[]
       OR r.col_names = ARRAY['external_invitee_uri']::name[]
    THEN
      EXECUTE format('ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS %I', r.conname);
    END IF;
  END LOOP;

  FOR r IN
    SELECT
      idx.relname AS index_name,
      (
        SELECT array_agg(att.attname ORDER BY k.ord)
        FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute att ON att.attrelid = ix.indrelid AND att.attnum = k.attnum
        WHERE k.attnum > 0
      ) AS col_names
    FROM pg_index ix
    JOIN pg_class idx ON idx.oid = ix.indexrelid
    JOIN pg_class tbl ON tbl.oid = ix.indrelid
    JOIN pg_namespace nsp ON nsp.oid = tbl.relnamespace
    WHERE nsp.nspname = 'public'
      AND tbl.relname = 'meetings'
      AND ix.indisunique
      AND NOT ix.indisprimary
  LOOP
    IF r.col_names = ARRAY['external_event_uri']::name[]
       OR r.col_names = ARRAY['external_invitee_uri']::name[]
    THEN
      EXECUTE format('DROP INDEX IF EXISTS public.%I', r.index_name);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'meetings' AND column_name = 'external_invitee_uri'
  ) THEN
    BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS meetings_external_invitee_uri_uidx
        ON public.meetings (external_invitee_uri)
        WHERE external_invitee_uri IS NOT NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE WARNING 'meetings_external_invitee_uri_uidx was not created because duplicate invitee URIs exist: %', SQLERRM;
    END;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'meetings' AND column_name = 'external_event_uri'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_meetings_external_event_uri
      ON public.meetings (external_event_uri)
      WHERE external_event_uri IS NOT NULL;

    BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS meetings_event_without_invitee_uidx
        ON public.meetings (external_provider, external_event_uri)
        WHERE external_invitee_uri IS NULL AND external_event_uri IS NOT NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE WARNING 'meetings_event_without_invitee_uidx was not created because duplicate event URIs exist: %', SQLERRM;
    END;
  END IF;

  CREATE INDEX IF NOT EXISTS idx_meetings_scheduled_end
    ON public.meetings (end_time)
    WHERE status = 'scheduled';
END $$;

-- Superseded provider ids for one CRM meeting. Phase 1 writes Calendly invitee
-- URIs. A later phase can write Zoom meeting ids as kind = 'zoom_meeting'.
CREATE TABLE IF NOT EXISTS public.meeting_external_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES public.meetings (id) ON DELETE CASCADE,
  provider text NOT NULL,
  kind text NOT NULL,
  external_id text NOT NULL,
  superseded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, kind, external_id)
);

CREATE INDEX IF NOT EXISTS idx_meeting_external_aliases_meeting_id
  ON public.meeting_external_aliases (meeting_id);

COMMENT ON TABLE public.meeting_external_aliases IS
  'Previous external ids that still belong to one meetings row. Reschedules update that row in place so client_id, lead_id, and notes stay. kind identifies the id (invitee now, zoom_meeting later).';

-- ---------------------------------------------------------------------------
-- Webhook delivery log. Service role only, same posture as the token tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.integration_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('calendly', 'zoom')),
  event_key text NOT NULL,
  event_type text,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'processed', 'ignored', 'error')),
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_key)
);

CREATE INDEX IF NOT EXISTS idx_integration_webhook_events_received
  ON public.integration_webhook_events (received_at);

COMMENT ON TABLE public.integration_webhook_events IS
  'Idempotency log for Calendly and Zoom webhook deliveries. Retries of a processed delivery are no-ops. Rows older than 30 days are pruned by the reconcile job.';

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_webhook_events', 'meeting_external_aliases']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Connection health. These columns are safe for the browser: expiry and a
-- status word, never the access or refresh token.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['calendly_connections', 'zoom_connections']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'public.% is missing; skipped health columns', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I
         ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
         ADD COLUMN IF NOT EXISTS token_status text,
         ADD COLUMN IF NOT EXISTS token_status_at timestamptz,
         ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
         ADD COLUMN IF NOT EXISTS last_sync_error text,
         ADD COLUMN IF NOT EXISTS last_webhook_at timestamptz,
         ADD COLUMN IF NOT EXISTS last_reconcile_at timestamptz',
      t
    );

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = t || '_token_status_check'
        AND conrelid = ('public.' || t)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (token_status IS NULL OR token_status IN (''valid'', ''expired'', ''refresh_failed'', ''missing''))',
        t,
        t || '_token_status_check'
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.calendly_connections') IS NOT NULL
     AND to_regclass('public.calendly_connection_tokens') IS NOT NULL
  THEN
    UPDATE public.calendly_connections c
    SET
      token_expires_at = t.token_expires_at,
      token_status = CASE
        WHEN t.access_token IS NULL AND t.refresh_token IS NULL THEN 'missing'
        WHEN t.refresh_token IS NULL AND t.token_expires_at IS NOT NULL AND t.token_expires_at <= now() THEN 'expired'
        WHEN t.token_expires_at IS NOT NULL AND t.token_expires_at <= now() THEN 'expired'
        WHEN t.access_token IS NULL THEN 'missing'
        ELSE 'valid'
      END,
      token_status_at = now()
    FROM public.calendly_connection_tokens t
    WHERE t.connection_id = c.id
      AND c.revoked_at IS NULL
      AND c.token_status IS NULL;
  END IF;

  IF to_regclass('public.zoom_connections') IS NOT NULL
     AND to_regclass('public.zoom_connection_tokens') IS NOT NULL
  THEN
    UPDATE public.zoom_connections c
    SET
      token_expires_at = t.token_expires_at,
      token_status = CASE
        WHEN t.access_token IS NULL AND t.refresh_token IS NULL THEN 'missing'
        WHEN t.refresh_token IS NULL AND t.token_expires_at IS NOT NULL AND t.token_expires_at <= now() THEN 'expired'
        WHEN t.token_expires_at IS NOT NULL AND t.token_expires_at <= now() THEN 'expired'
        WHEN t.access_token IS NULL THEN 'missing'
        ELSE 'valid'
      END,
      token_status_at = now()
    FROM public.zoom_connection_tokens t
    WHERE t.connection_id = c.id
      AND c.revoked_at IS NULL
      AND c.token_status IS NULL;
  END IF;

  IF to_regclass('public.calendly_connections') IS NOT NULL
     AND to_regclass('public.meetings') IS NOT NULL
  THEN
    UPDATE public.calendly_connections c
    SET last_synced_at = s.mx
    FROM (
      SELECT advisor_id, max(last_synced_at) AS mx
      FROM public.meetings
      WHERE source = 'calendly' OR external_provider = 'calendly'
      GROUP BY advisor_id
    ) s
    WHERE c.user_id = s.advisor_id
      AND c.last_synced_at IS NULL
      AND s.mx IS NOT NULL;
  END IF;
END $$;

-- Admins can read connection health for the team. Token tables stay service-role
-- only (security-hardening migration). Existing own-row policies are left as they are.
DO $$
BEGIN
  IF to_regprocedure('public.is_admin()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
  THEN
    RAISE NOTICE 'is_admin() or the authenticated role is missing; skipped admin integration policies. Apply the security-hardening migration first.';
    RETURN;
  END IF;

  IF to_regclass('public.calendly_connections') IS NOT NULL THEN
    DROP POLICY IF EXISTS "calendly_connections_select_admin" ON public.calendly_connections;
    CREATE POLICY "calendly_connections_select_admin"
      ON public.calendly_connections
      FOR SELECT
      TO authenticated
      USING ((SELECT public.is_admin()));
  END IF;

  IF to_regclass('public.zoom_connections') IS NOT NULL THEN
    DROP POLICY IF EXISTS "zoom_connections_select_admin" ON public.zoom_connections;
    CREATE POLICY "zoom_connections_select_admin"
      ON public.zoom_connections
      FOR SELECT
      TO authenticated
      USING ((SELECT public.is_admin()));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Idempotent recap tasks for Zoom meeting.ended.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.tasks') IS NULL THEN
    RAISE NOTICE 'public.tasks is missing; skipped source_ref';
    RETURN;
  END IF;
  ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS source_ref text;
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_source_ref_uidx
      ON public.tasks (source_ref)
      WHERE source_ref IS NOT NULL;
  EXCEPTION WHEN unique_violation THEN
    RAISE WARNING 'tasks_source_ref_uidx was not created because duplicate source_ref values exist: %', SQLERRM;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- Maintenance: prune the webhook log, complete stale scheduled meetings, and
-- call the reconcile edge function when Vault secrets exist.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_stale_scheduled_meetings()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.meetings
  SET
    status = 'completed',
    status_origin = 'system'
  WHERE status = 'scheduled'
    AND coalesce(status_origin, 'provider') IS DISTINCT FROM 'advisor'
    AND coalesce(end_time, start_time) < now()
    AND (
      source IN ('calendly', 'zoom')
      OR external_provider IN ('calendly', 'zoom')
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.complete_stale_scheduled_meetings() IS
  'Marks past Calendly/Zoom meetings completed when they are still scheduled and an advisor has not set the status. Safe to run repeatedly.';

CREATE OR REPLACE FUNCTION public.prune_integration_webhook_events()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public.integration_webhook_events') IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM public.integration_webhook_events
  WHERE received_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_integration_reconcile()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  project_url text;
  service_key text;
BEGIN
  IF to_regnamespace('vault') IS NULL OR to_regnamespace('net') IS NULL THEN
    RAISE WARNING 'integration reconcile skipped: vault or pg_net is not installed';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO project_url
  FROM vault.decrypted_secrets
  WHERE name = 'project_url'
  LIMIT 1;

  SELECT decrypted_secret INTO service_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF coalesce(project_url, '') = '' OR coalesce(service_key, '') = '' THEN
    RAISE WARNING 'integration reconcile skipped: create Vault secrets named project_url and service_role_key (see the migration header)';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/integration-reconcile',
    body := jsonb_build_object('source', 'pg_cron'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key,
      'apikey', service_key
    ),
    timeout_milliseconds := 120000
  );
END;
$$;

COMMENT ON FUNCTION public.invoke_integration_reconcile() IS
  'Posts to the integration-reconcile edge function using Vault secrets project_url and service_role_key. No-ops with a warning when those secrets are absent. Does not return the secrets.';

CREATE OR REPLACE FUNCTION public.run_integration_maintenance()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM public.prune_integration_webhook_events();
  PERFORM public.complete_stale_scheduled_meetings();
  PERFORM public.invoke_integration_reconcile();
END;
$$;

REVOKE ALL ON FUNCTION public.guard_meeting_status_origin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_stale_scheduled_meetings() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_integration_webhook_events() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoke_integration_reconcile() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_integration_maintenance() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.complete_stale_scheduled_meetings() TO service_role;
    GRANT EXECUTE ON FUNCTION public.prune_integration_webhook_events() TO service_role;
    GRANT EXECUTE ON FUNCTION public.invoke_integration_reconcile() TO service_role;
    GRANT EXECUTE ON FUNCTION public.run_integration_maintenance() TO service_role;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL OR to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'cron.schedule is unavailable; integration-reconcile was not scheduled. Enable pg_cron and re-run this migration.';
    RETURN;
  END IF;
  IF to_regnamespace('net') IS NULL THEN
    RAISE NOTICE 'pg_net is unavailable; integration-reconcile was not scheduled.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'integration-reconcile') THEN
    PERFORM cron.unschedule('integration-reconcile');
  END IF;

  PERFORM cron.schedule(
    'integration-reconcile',
    '*/30 * * * *',
    'SELECT public.run_integration_maintenance()'
  );
END $$;

-- One-time backfill of the stale "scheduled" rows. The same function runs
-- every 30 minutes afterward. Advisor-owned statuses are not changed.
DO $$
DECLARE
  n integer;
BEGIN
  n := public.complete_stale_scheduled_meetings();
  RAISE NOTICE 'completed % stale scheduled meeting(s)', n;
END $$;

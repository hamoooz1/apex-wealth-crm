-- Phase 2: field ownership for meetings.
--
-- Idempotent. Does not delete meetings and does not change client_id, lead_id,
-- or notes. Apply after 20261115120000_meeting_sync_foundation.sql.
-- Nothing here is run against the live project by the agent that wrote it.
--
-- Provider sync may refresh title, times, location, URL, attendees, and the
-- advisor only while field_origins for that column is not "advisor". An edit
-- from a signed-in user sets that origin. The service role can release a lock
-- by writing field_origins in the same update (a Calendly reschedule does this
-- for time and location). It cannot change notes, and it cannot change a
-- client or lead link. Those links are filled in by the later linking migration.
--
-- provider_snapshot stores the last value the provider sent, including values
-- the CRM kept. The meeting screen uses it to show both.

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RAISE NOTICE 'public.meetings is missing; skipped field ownership';
    RETURN;
  END IF;

  ALTER TABLE public.meetings
    ADD COLUMN IF NOT EXISTS field_origins jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
END $$;

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NOT NULL THEN
    COMMENT ON COLUMN public.meetings.field_origins IS
      'Per-column owner. advisor means sync must not overwrite that column. provider means the last write came from Calendly or Zoom. status uses status_origin instead.';
    COMMENT ON COLUMN public.meetings.provider_snapshot IS
      'Last title, times, location, and URL received from Calendly or Zoom. The CRM columns stay as the advisor left them when field_origins says advisor.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_meeting_field_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  jwt_role text := coalesce(auth.role(), '');
  privileged boolean;
  proposed jsonb;
  revised jsonb;
  origins jsonb;
  key text;
  provider_keys text[] := ARRAY[
    'title', 'start_time', 'end_time', 'meeting_type', 'meeting_url',
    'location', 'attendees', 'advisor_id', 'zoom_meeting_id', 'zoom_meeting_uuid'
  ];
BEGIN
  privileged := jwt_role IN ('service_role', 'supabase_admin')
    OR (
      jwt_role = ''
      AND session_user IN ('postgres', 'supabase_admin', 'supabase_auth_admin')
    );

  IF TG_OP = 'INSERT' THEN
    IF NEW.field_origins IS NULL THEN
      NEW.field_origins := '{}'::jsonb;
    END IF;
    IF NEW.provider_snapshot IS NULL THEN
      NEW.provider_snapshot := '{}'::jsonb;
    END IF;
    RETURN NEW;
  END IF;

  proposed := to_jsonb(NEW);
  revised := proposed;
  origins := coalesce(revised -> 'field_origins', '{}'::jsonb);
  IF jsonb_typeof(origins) IS DISTINCT FROM 'object' THEN
    origins := '{}'::jsonb;
  END IF;

  IF privileged THEN
    FOREACH key IN ARRAY provider_keys LOOP
      IF NOT (to_jsonb(OLD) ? key) THEN
        CONTINUE;
      END IF;
      IF coalesce(to_jsonb(OLD) -> 'field_origins' ->> key, '') = 'advisor'
         AND coalesce(origins ->> key, '') = 'advisor'
         AND (revised -> key) IS DISTINCT FROM (to_jsonb(OLD) -> key) THEN
        revised := jsonb_set(revised, ARRAY[key], coalesce(to_jsonb(OLD) -> key, 'null'::jsonb), true);
      END IF;
    END LOOP;

    IF (to_jsonb(OLD) ? 'notes')
       AND (revised -> 'notes') IS DISTINCT FROM (to_jsonb(OLD) -> 'notes') THEN
      revised := jsonb_set(revised, ARRAY['notes'], coalesce(to_jsonb(OLD) -> 'notes', 'null'::jsonb), true);
    END IF;

    -- Linking is a later migration. Until then a provider write cannot attach
    -- or move a client or lead, including filling a null.
    IF (to_jsonb(OLD) ? 'client_id')
       AND (revised -> 'client_id') IS DISTINCT FROM (to_jsonb(OLD) -> 'client_id') THEN
      revised := jsonb_set(revised, ARRAY['client_id'], coalesce(to_jsonb(OLD) -> 'client_id', 'null'::jsonb), true);
    END IF;
    IF (to_jsonb(OLD) ? 'lead_id')
       AND (revised -> 'lead_id') IS DISTINCT FROM (to_jsonb(OLD) -> 'lead_id') THEN
      revised := jsonb_set(revised, ARRAY['lead_id'], coalesce(to_jsonb(OLD) -> 'lead_id', 'null'::jsonb), true);
    END IF;
  ELSE
    origins := coalesce(to_jsonb(OLD) -> 'field_origins', '{}'::jsonb);
    IF jsonb_typeof(origins) IS DISTINCT FROM 'object' THEN
      origins := '{}'::jsonb;
    END IF;
    FOREACH key IN ARRAY provider_keys LOOP
      IF NOT (to_jsonb(OLD) ? key) THEN
        CONTINUE;
      END IF;
      IF (revised -> key) IS DISTINCT FROM (to_jsonb(OLD) -> key) THEN
        origins := jsonb_set(origins, ARRAY[key], '"advisor"'::jsonb, true);
      END IF;
    END LOOP;
    revised := jsonb_set(revised, ARRAY['field_origins'], origins, true);
    IF to_jsonb(OLD) ? 'provider_snapshot' THEN
      revised := jsonb_set(
        revised,
        ARRAY['provider_snapshot'],
        coalesce(to_jsonb(OLD) -> 'provider_snapshot', '{}'::jsonb),
        true
      );
    END IF;
  END IF;

  IF revised IS DISTINCT FROM proposed THEN
    NEW := jsonb_populate_record(NEW, revised);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_meeting_field_ownership() IS
  'Keeps advisor-edited meeting columns, notes, and client/lead links from being overwritten by the service role. A signed-in edit marks that column advisor in field_origins.';

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS guard_meeting_field_ownership ON public.meetings;
  CREATE TRIGGER guard_meeting_field_ownership
    BEFORE INSERT OR UPDATE ON public.meetings
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_meeting_field_ownership();
END $$;

REVOKE ALL ON FUNCTION public.guard_meeting_field_ownership() FROM PUBLIC, anon, authenticated;

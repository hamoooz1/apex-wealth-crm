-- Phase 3: link meetings to clients and leads.
--
-- Idempotent. Does not delete meetings, clients, or leads. A second run only
-- fills rows that are still unlinked. An advisor link, or an advisor choice
-- to clear the link, is left alone.
--
-- Match is case-insensitive on the primary email and alternate_emails.
-- A client wins over a lead. No match creates one lead for that email,
-- assigned to the meeting's advisor.

CREATE OR REPLACE FUNCTION public.normalize_email(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT nullif(lower(btrim(raw)), '');
$$;

REVOKE ALL ON FUNCTION public.normalize_email(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_email(text) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RAISE NOTICE 'public.meetings is missing; skipped meeting links';
    RETURN;
  END IF;

  ALTER TABLE public.meetings
    ADD COLUMN IF NOT EXISTS invitee_email text,
    ADD COLUMN IF NOT EXISTS link_origin text,
    ADD COLUMN IF NOT EXISTS attendees jsonb;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meetings_link_origin_check'
      AND conrelid = 'public.meetings'::regclass
  ) THEN
    ALTER TABLE public.meetings
      ADD CONSTRAINT meetings_link_origin_check
      CHECK (link_origin IS NULL OR link_origin IN ('auto', 'advisor', 'unlinked'));
  END IF;

  CREATE INDEX IF NOT EXISTS idx_meetings_invitee_email
    ON public.meetings (invitee_email)
    WHERE invitee_email IS NOT NULL;

  COMMENT ON COLUMN public.meetings.link_origin IS
    'auto: matched or created by email. advisor: set in the app. unlinked: an advisor cleared it, so sync must not fill it again. NULL means not considered yet.';
END $$;

DO $$
BEGIN
  IF to_regclass('public.clients') IS NOT NULL THEN
    ALTER TABLE public.clients
      ADD COLUMN IF NOT EXISTS alternate_emails text[] NOT NULL DEFAULT '{}'::text[];
  END IF;
  IF to_regclass('public.leads') IS NOT NULL THEN
    ALTER TABLE public.leads
      ADD COLUMN IF NOT EXISTS alternate_emails text[] NOT NULL DEFAULT '{}'::text[];
  END IF;
END $$;

-- Same ownership rules as phase 2, plus: the service role may fill a null
-- client_id or lead_id only when it also sets link_origin to auto.
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
  old_row jsonb;
  key text;
  provider_keys text[] := ARRAY[
    'title', 'start_time', 'end_time', 'meeting_type', 'meeting_url',
    'location', 'attendees', 'advisor_id', 'zoom_meeting_id', 'zoom_meeting_uuid'
  ];
  client_was_null boolean;
  lead_was_null boolean;
  auto_link boolean;
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

  old_row := to_jsonb(OLD);
  proposed := to_jsonb(NEW);
  revised := proposed;
  origins := coalesce(revised -> 'field_origins', '{}'::jsonb);
  IF jsonb_typeof(origins) IS DISTINCT FROM 'object' THEN
    origins := '{}'::jsonb;
  END IF;

  IF privileged THEN
    FOREACH key IN ARRAY provider_keys LOOP
      IF NOT (old_row ? key) THEN
        CONTINUE;
      END IF;
      IF coalesce(old_row -> 'field_origins' ->> key, '') = 'advisor'
         AND coalesce(origins ->> key, '') = 'advisor'
         AND (revised -> key) IS DISTINCT FROM (old_row -> key) THEN
        revised := jsonb_set(revised, ARRAY[key], coalesce(old_row -> key, 'null'::jsonb), true);
      END IF;
    END LOOP;

    IF (old_row ? 'notes')
       AND (revised -> 'notes') IS DISTINCT FROM (old_row -> 'notes') THEN
      revised := jsonb_set(revised, ARRAY['notes'], coalesce(old_row -> 'notes', 'null'::jsonb), true);
    END IF;

    client_was_null := NOT (old_row ? 'client_id')
      OR (old_row -> 'client_id') IS NULL
      OR (old_row -> 'client_id') = 'null'::jsonb;
    lead_was_null := NOT (old_row ? 'lead_id')
      OR (old_row -> 'lead_id') IS NULL
      OR (old_row -> 'lead_id') = 'null'::jsonb;
    auto_link := coalesce(revised ->> 'link_origin', '') = 'auto';

    IF (old_row ? 'client_id')
       AND (revised -> 'client_id') IS DISTINCT FROM (old_row -> 'client_id')
       AND NOT (client_was_null AND auto_link) THEN
      revised := jsonb_set(revised, ARRAY['client_id'], coalesce(old_row -> 'client_id', 'null'::jsonb), true);
    END IF;
    IF (old_row ? 'lead_id')
       AND (revised -> 'lead_id') IS DISTINCT FROM (old_row -> 'lead_id')
       AND NOT (lead_was_null AND auto_link) THEN
      revised := jsonb_set(revised, ARRAY['lead_id'], coalesce(old_row -> 'lead_id', 'null'::jsonb), true);
    END IF;
  ELSE
    origins := coalesce(old_row -> 'field_origins', '{}'::jsonb);
    IF jsonb_typeof(origins) IS DISTINCT FROM 'object' THEN
      origins := '{}'::jsonb;
    END IF;
    FOREACH key IN ARRAY provider_keys LOOP
      IF NOT (old_row ? key) THEN
        CONTINUE;
      END IF;
      IF (revised -> key) IS DISTINCT FROM (old_row -> key) THEN
        origins := jsonb_set(origins, ARRAY[key], '"advisor"'::jsonb, true);
      END IF;
    END LOOP;
    revised := jsonb_set(revised, ARRAY['field_origins'], origins, true);
    IF old_row ? 'provider_snapshot' THEN
      revised := jsonb_set(
        revised,
        ARRAY['provider_snapshot'],
        coalesce(old_row -> 'provider_snapshot', '{}'::jsonb),
        true
      );
    END IF;
    IF old_row ? 'link_origin' THEN
      IF (revised -> 'client_id') IS DISTINCT FROM (old_row -> 'client_id')
         OR (revised -> 'lead_id') IS DISTINCT FROM (old_row -> 'lead_id') THEN
        IF coalesce(revised ->> 'client_id', '') = '' AND coalesce(revised ->> 'lead_id', '') = '' THEN
          revised := jsonb_set(revised, ARRAY['link_origin'], '"unlinked"'::jsonb, true);
        ELSE
          revised := jsonb_set(revised, ARRAY['link_origin'], '"advisor"'::jsonb, true);
        END IF;
      ELSE
        revised := jsonb_set(
          revised,
          ARRAY['link_origin'],
          coalesce(old_row -> 'link_origin', 'null'::jsonb),
          true
        );
      END IF;
    END IF;
  END IF;

  IF revised IS DISTINCT FROM proposed THEN
    NEW := jsonb_populate_record(NEW, revised);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_meeting_field_ownership() IS
  'Keeps advisor-edited meeting columns and notes. The service role may set client_id or lead_id only when the previous value is null and link_origin is auto.';

CREATE OR REPLACE FUNCTION public.meeting_invitee_email(invitee_email text, attendees jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT public.normalize_email(
    COALESCE(
      NULLIF(btrim(invitee_email), ''),
      attendees -> 'invitee' ->> 'email',
      attendees ->> 'email',
      CASE
        WHEN jsonb_typeof(attendees) = 'array' THEN attendees -> 0 ->> 'email'
        ELSE NULL
      END
    )
  );
$$;

REVOKE ALL ON FUNCTION public.meeting_invitee_email(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.meeting_invitee_email(text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.link_meetings_to_people(target_meeting uuid DEFAULT NULL)
RETURNS TABLE (linked_clients integer, linked_existing_leads integer, created_leads integer)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  meeting record;
  v_email text;
  v_name text;
  v_first text;
  v_last text;
  v_client uuid;
  v_lead uuid;
  created_this boolean;
  n_clients integer := 0;
  n_leads integer := 0;
  n_created integer := 0;
BEGIN
  IF to_regclass('public.meetings') IS NULL
     OR to_regclass('public.clients') IS NULL
     OR to_regclass('public.leads') IS NULL THEN
    linked_clients := 0;
    linked_existing_leads := 0;
    created_leads := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR meeting IN
    SELECT m.id, m.advisor_id, m.invitee_email, m.attendees, m.source, m.external_provider
    FROM public.meetings m
    WHERE m.client_id IS NULL
      AND m.lead_id IS NULL
      AND m.link_origin IS NULL
      AND m.advisor_id IS NOT NULL
      AND (target_meeting IS NULL OR m.id = target_meeting)
  LOOP
    v_email := public.meeting_invitee_email(meeting.invitee_email, meeting.attendees);
    IF v_email IS NULL THEN
      CONTINUE;
    END IF;

    IF meeting.invitee_email IS NULL THEN
      UPDATE public.meetings SET invitee_email = v_email WHERE id = meeting.id AND invitee_email IS NULL;
    END IF;

    SELECT c.id INTO v_client
    FROM public.clients c
    WHERE public.normalize_email(c.email) = v_email
       OR EXISTS (
         SELECT 1
         FROM unnest(coalesce(c.alternate_emails, '{}'::text[])) AS alt
         WHERE public.normalize_email(alt) = v_email
       )
    ORDER BY c.created_at NULLS LAST
    LIMIT 1;

    IF v_client IS NOT NULL THEN
      UPDATE public.meetings
      SET client_id = v_client, link_origin = 'auto', invitee_email = v_email
      WHERE id = meeting.id
        AND client_id IS NULL
        AND lead_id IS NULL
        AND link_origin IS NULL;
      IF FOUND THEN
        n_clients := n_clients + 1;
      END IF;
      CONTINUE;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(v_email));

    SELECT l.id INTO v_lead
    FROM public.leads l
    WHERE public.normalize_email(l.email) = v_email
       OR EXISTS (
         SELECT 1
         FROM unnest(coalesce(l.alternate_emails, '{}'::text[])) AS alt
         WHERE public.normalize_email(alt) = v_email
       )
    ORDER BY l.created_at NULLS LAST
    LIMIT 1;

    created_this := false;
    IF v_lead IS NULL THEN
      v_name := btrim(COALESCE(meeting.attendees -> 'invitee' ->> 'name', meeting.attendees ->> 'name', ''));
      IF position(' ' in v_name) > 0 THEN
        v_first := split_part(v_name, ' ', 1);
        v_last := btrim(substr(v_name, length(v_first) + 1));
      ELSIF v_name <> '' THEN
        v_first := v_name;
        v_last := NULL;
      ELSE
        v_first := split_part(v_email, '@', 1);
        v_last := NULL;
      END IF;

      BEGIN
        INSERT INTO public.leads (first_name, last_name, email, source, status, assigned_to)
        VALUES (
          v_first,
          v_last,
          v_email,
          CASE
            WHEN meeting.source = 'zoom' OR meeting.external_provider = 'zoom' THEN 'zoom'
            WHEN meeting.source = 'calendly' OR meeting.external_provider = 'calendly' THEN 'calendly'
            ELSE 'meeting'
          END,
          'new',
          meeting.advisor_id
        )
        RETURNING id INTO v_lead;
        n_created := n_created + 1;
        created_this := true;
      EXCEPTION
        WHEN not_null_violation OR check_violation THEN
          RAISE NOTICE 'skipped lead for %: %', v_email, SQLERRM;
          CONTINUE;
      END;
    END IF;

    UPDATE public.meetings
    SET lead_id = v_lead, link_origin = 'auto', invitee_email = v_email
    WHERE id = meeting.id
      AND client_id IS NULL
      AND lead_id IS NULL
      AND link_origin IS NULL;
    IF FOUND AND NOT created_this THEN
      n_leads := n_leads + 1;
    END IF;
  END LOOP;

  linked_clients := n_clients;
  linked_existing_leads := n_leads;
  created_leads := n_created;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.link_meetings_to_people(uuid) IS
  'Links unlinked meetings to a client or lead by invitee email. Creates one lead per new email, assigned to the meeting advisor. Pass a meeting id to link one row. Safe to run again.';

REVOKE ALL ON FUNCTION public.link_meetings_to_people(uuid) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.link_meetings_to_people(uuid) TO service_role;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.sync_recording_people()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF to_regclass('public.meeting_recordings') IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.client_id IS NOT DISTINCT FROM OLD.client_id
     AND NEW.lead_id IS NOT DISTINCT FROM OLD.lead_id THEN
    RETURN NEW;
  END IF;
  UPDATE public.meeting_recordings
  SET client_id = NEW.client_id, lead_id = NEW.lead_id
  WHERE meeting_id = NEW.id
    AND (client_id IS DISTINCT FROM NEW.client_id OR lead_id IS DISTINCT FROM NEW.lead_id);
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NULL OR to_regclass('public.meeting_recordings') IS NULL THEN
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS sync_recording_people ON public.meetings;
  CREATE TRIGGER sync_recording_people
    AFTER UPDATE OF client_id, lead_id ON public.meetings
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_recording_people();
END $$;

REVOKE ALL ON FUNCTION public.sync_recording_people() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  result record;
BEGIN
  IF to_regclass('public.clients') IS NULL OR to_regclass('public.leads') IS NULL THEN
    RAISE NOTICE 'clients or leads are missing; meeting link backfill was skipped';
    RETURN;
  END IF;
  SELECT * INTO result FROM public.link_meetings_to_people(NULL);
  RAISE NOTICE 'linked % meeting(s) to clients, % to leads, created % lead(s)',
    result.linked_clients, result.linked_existing_leads, result.created_leads;
END $$;

-- Assertions for 20261115140000_meeting_field_ownership.sql.
-- Safe to run more than once.

DELETE FROM public.meetings WHERE title LIKE 'case-own-%' OR title = 'From Calendly' OR title = 'Renamed by advisor';

INSERT INTO public.meetings (
  title, start_time, end_time, status, status_origin, source, external_provider,
  external_event_uri, external_invitee_uri, notes, client_id, lead_id, field_origins, provider_snapshot
)
VALUES (
  'case-own-locked',
  now() + interval '5 days',
  now() + interval '5 days' + interval '30 minutes',
  'scheduled',
  'provider',
  'calendly',
  'calendly',
  'https://api.calendly.com/scheduled_events/case-own',
  'case-own-invitee',
  'advisor notes stay',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '{"title":"advisor"}'::jsonb,
  '{"title":"Previous provider title"}'::jsonb
);

DO $$
DECLARE
  row public.meetings;
  kept timestamptz;
BEGIN
  SELECT start_time INTO kept FROM public.meetings WHERE external_invitee_uri = 'case-own-invitee';

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  UPDATE public.meetings
  SET
    title = 'From Calendly',
    notes = 'sync tried to replace notes',
    client_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    lead_id = NULL,
    provider_snapshot = '{"title":"From Calendly"}'::jsonb
  WHERE external_invitee_uri = 'case-own-invitee';

  SELECT * INTO row FROM public.meetings WHERE external_invitee_uri = 'case-own-invitee';
  IF row.title IS DISTINCT FROM 'case-own-locked' THEN
    RAISE EXCEPTION 'service role overwrote an advisor title (%)', row.title;
  END IF;
  IF row.notes IS DISTINCT FROM 'advisor notes stay' THEN
    RAISE EXCEPTION 'service role overwrote notes';
  END IF;
  IF row.client_id IS DISTINCT FROM '11111111-1111-1111-1111-111111111111'::uuid
     OR row.lead_id IS DISTINCT FROM '22222222-2222-2222-2222-222222222222'::uuid THEN
    RAISE EXCEPTION 'service role changed client or lead link';
  END IF;
  IF row.provider_snapshot ->> 'title' IS DISTINCT FROM 'From Calendly' THEN
    RAISE EXCEPTION 'provider snapshot was not stored';
  END IF;
  IF row.start_time IS DISTINCT FROM kept THEN
    RAISE EXCEPTION 'ownership trigger changed start_time while reverting other columns';
  END IF;

  UPDATE public.meetings
  SET
    title = 'From Calendly',
    field_origins = '{"title":"provider"}'::jsonb
  WHERE external_invitee_uri = 'case-own-invitee';
  SELECT * INTO row FROM public.meetings WHERE external_invitee_uri = 'case-own-invitee';
  IF row.title IS DISTINCT FROM 'From Calendly' OR row.field_origins ->> 'title' IS DISTINCT FROM 'provider' THEN
    RAISE EXCEPTION 'service role could not release a lock it cleared in the same update';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  UPDATE public.meetings
  SET title = 'Renamed by advisor', field_origins = '{}'::jsonb, provider_snapshot = '{"title":"tampered"}'::jsonb
  WHERE external_invitee_uri = 'case-own-invitee';
  SELECT * INTO row FROM public.meetings WHERE external_invitee_uri = 'case-own-invitee';
  IF row.title IS DISTINCT FROM 'Renamed by advisor' THEN
    RAISE EXCEPTION 'advisor rename did not stick';
  END IF;
  IF row.field_origins ->> 'title' IS DISTINCT FROM 'advisor' THEN
    RAISE EXCEPTION 'advisor rename did not lock the title (origins=%)', row.field_origins;
  END IF;
  IF row.provider_snapshot ->> 'title' IS DISTINCT FROM 'From Calendly' THEN
    RAISE EXCEPTION 'browser was able to rewrite provider_snapshot';
  END IF;
  IF row.status_origin IS DISTINCT FROM 'provider' THEN
    RAISE EXCEPTION 'title edit changed status_origin';
  END IF;

  UPDATE public.meetings
  SET notes = 'advisor notes stay — edited'
  WHERE external_invitee_uri = 'case-own-invitee';
  SELECT notes INTO row.notes FROM public.meetings WHERE external_invitee_uri = 'case-own-invitee';
  IF row.notes IS DISTINCT FROM 'advisor notes stay — edited' THEN
    RAISE EXCEPTION 'advisor could not edit notes';
  END IF;

  PERFORM set_config('request.jwt.claim.role', '', true);
END $$;

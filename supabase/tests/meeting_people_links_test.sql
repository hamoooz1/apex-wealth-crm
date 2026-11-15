-- Assertions for 20261115160000_meeting_people_links.sql.

CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text,
  last_name text,
  email text,
  alternate_emails text[] NOT NULL DEFAULT '{}',
  advisor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text,
  last_name text,
  email text,
  alternate_emails text[] NOT NULL DEFAULT '{}',
  source text,
  status text,
  assigned_to uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS alternate_emails text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS alternate_emails text[] NOT NULL DEFAULT '{}';

DELETE FROM public.meetings WHERE external_invitee_uri LIKE 'case-link-%';
DELETE FROM public.leads WHERE email LIKE 'case-link-%';
DELETE FROM public.clients WHERE email LIKE 'case-link-%' OR 'case-link-alt@firm.test' = ANY (alternate_emails);

INSERT INTO public.clients (first_name, last_name, email, alternate_emails, advisor_id)
VALUES ('Ada', 'Client', 'case-link-client@firm.test', ARRAY['case-link-alt@firm.test'], '44444444-4444-4444-4444-444444444444');

INSERT INTO public.meetings (
  title, status, source, external_provider, advisor_id, external_event_uri, external_invitee_uri,
  attendees, notes, link_origin, client_id
)
VALUES
  (
    'case-link-client',
    'scheduled',
    'calendly',
    'calendly',
    '44444444-4444-4444-4444-444444444444',
    'https://api.calendly.com/scheduled_events/case-link-client',
    'case-link-client',
    '{"invitee":{"email":"Case-Link-Client@Firm.Test","name":"Ada Client"}}'::jsonb,
    'keep notes',
    NULL,
    NULL
  ),
  (
    'case-link-alt',
    'scheduled',
    'calendly',
    'calendly',
    '44444444-4444-4444-4444-444444444444',
    'https://api.calendly.com/scheduled_events/case-link-alt',
    'case-link-alt',
    '{"invitee":{"email":"CASE-LINK-ALT@firm.test","name":"Ada Alt"}}'::jsonb,
    NULL,
    NULL,
    NULL
  ),
  (
    'case-link-new',
    'scheduled',
    'calendly',
    'calendly',
    '44444444-4444-4444-4444-444444444444',
    'https://api.calendly.com/scheduled_events/case-link-new',
    'case-link-new',
    '{"invitee":{"email":"case-link-new@firm.test","name":"New Person"}}'::jsonb,
    NULL,
    NULL,
    NULL
  ),
  (
    'case-link-new-again',
    'scheduled',
    'zoom',
    'zoom',
    '44444444-4444-4444-4444-444444444444',
    'zoom:55566677788',
    'case-link-new-again',
    '{"invitee":{"email":"case-link-new@firm.test","name":"New Person"}}'::jsonb,
    NULL,
    NULL,
    NULL
  ),
  (
    'case-link-cleared',
    'scheduled',
    'calendly',
    'calendly',
    '44444444-4444-4444-4444-444444444444',
    'https://api.calendly.com/scheduled_events/case-link-cleared',
    'case-link-cleared',
    '{"invitee":{"email":"case-link-new@firm.test"}}'::jsonb,
    NULL,
    'unlinked',
    NULL
  );

DO $$
DECLARE
  stats record;
  row public.meetings;
  lead_count integer;
  found_lead uuid;
  found_client uuid;
BEGIN
  SELECT * INTO stats FROM public.link_meetings_to_people(NULL);
  IF stats.linked_clients <> 2 OR stats.created_leads <> 1 OR stats.linked_existing_leads <> 1 THEN
    RAISE EXCEPTION 'link stats clients=% created=% leads=%', stats.linked_clients, stats.created_leads, stats.linked_existing_leads;
  END IF;

  SELECT id INTO found_client FROM public.clients WHERE email = 'case-link-client@firm.test';
  SELECT * INTO row FROM public.meetings WHERE external_invitee_uri = 'case-link-client';
  IF row.client_id IS DISTINCT FROM found_client OR row.link_origin IS DISTINCT FROM 'auto' OR row.notes IS DISTINCT FROM 'keep notes' THEN
    RAISE EXCEPTION 'client match failed (client=%, origin=%)', row.client_id, row.link_origin;
  END IF;
  IF row.invitee_email IS DISTINCT FROM 'case-link-client@firm.test' THEN
    RAISE EXCEPTION 'invitee email was not normalized (%)', row.invitee_email;
  END IF;

  SELECT * INTO row FROM public.meetings WHERE external_invitee_uri = 'case-link-alt';
  IF row.client_id IS DISTINCT FROM found_client THEN
    RAISE EXCEPTION 'alternate email did not match the client';
  END IF;

  SELECT count(*) INTO lead_count FROM public.leads WHERE email = 'case-link-new@firm.test';
  IF lead_count <> 1 THEN
    RAISE EXCEPTION 'expected one created lead, found %', lead_count;
  END IF;
  SELECT id INTO found_lead FROM public.leads WHERE email = 'case-link-new@firm.test';
  IF NOT EXISTS (
    SELECT 1 FROM public.leads
    WHERE id = found_lead AND first_name = 'New' AND last_name = 'Person' AND assigned_to = '44444444-4444-4444-4444-444444444444' AND source = 'calendly'
  ) THEN
    RAISE EXCEPTION 'created lead was not assigned to the meeting advisor';
  END IF;

  SELECT * INTO row FROM public.meetings WHERE external_invitee_uri = 'case-link-new-again';
  IF row.lead_id IS DISTINCT FROM found_lead OR row.link_origin IS DISTINCT FROM 'auto' THEN
    RAISE EXCEPTION 'second booking did not reuse the lead';
  END IF;

  SELECT * INTO row FROM public.meetings WHERE external_invitee_uri = 'case-link-cleared';
  IF row.lead_id IS NOT NULL OR row.client_id IS NOT NULL OR row.link_origin IS DISTINCT FROM 'unlinked' THEN
    RAISE EXCEPTION 'cleared link was filled again';
  END IF;

  SELECT * INTO stats FROM public.link_meetings_to_people(NULL);
  IF stats.linked_clients <> 0 OR stats.created_leads <> 0 OR stats.linked_existing_leads <> 0 THEN
    RAISE EXCEPTION 'second link pass was not a no-op';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  UPDATE public.meetings
  SET client_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', notes = 'replaced'
  WHERE external_invitee_uri = 'case-link-client';
  SELECT * INTO row FROM public.meetings WHERE external_invitee_uri = 'case-link-client';
  IF row.client_id IS DISTINCT FROM found_client OR row.notes IS DISTINCT FROM 'keep notes' THEN
    RAISE EXCEPTION 'service role moved an existing link or notes';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  UPDATE public.meetings
  SET lead_id = found_lead, client_id = NULL
  WHERE external_invitee_uri = 'case-link-client';
  SELECT * INTO row FROM public.meetings WHERE external_invitee_uri = 'case-link-client';
  IF row.lead_id IS DISTINCT FROM found_lead OR row.client_id IS NOT NULL OR row.link_origin IS DISTINCT FROM 'advisor' THEN
    RAISE EXCEPTION 'advisor relink did not stick (origin=%)', row.link_origin;
  END IF;

  PERFORM set_config('request.jwt.claim.role', '', true);
END $$;

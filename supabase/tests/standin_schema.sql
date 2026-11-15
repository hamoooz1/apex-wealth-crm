-- Local stand-in for the tables this migration touches. Not applied to production.
-- service_role is BYPASSRLS, matching hosted Supabase.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '');
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT false;
$$;

CREATE TABLE public.meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text,
  start_time timestamptz,
  end_time timestamptz,
  status text,
  advisor_id uuid,
  client_id uuid,
  lead_id uuid,
  source text,
  notes text,
  external_provider text,
  external_event_uri text,
  external_invitee_uri text,
  last_synced_at timestamptz
);

ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_external_event_uri_key UNIQUE (external_event_uri);
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_external_invitee_uri_key UNIQUE (external_invitee_uri);

CREATE TABLE public.calendly_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  calendly_user_uri text,
  status text,
  revoked_at timestamptz,
  connected_at timestamptz,
  webhook_subscription_uri text,
  webhook_last_error text
);

ALTER TABLE public.calendly_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY calendly_connections_select_own
  ON public.calendly_connections
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE TABLE public.calendly_connection_tokens (
  connection_id uuid PRIMARY KEY,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz
);

CREATE TABLE public.zoom_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  zoom_user_id text,
  email text,
  status text,
  revoked_at timestamptz
);

ALTER TABLE public.zoom_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY zoom_connections_select_own
  ON public.zoom_connections
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE TABLE public.zoom_connection_tokens (
  connection_id uuid PRIMARY KEY,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz
);

CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text,
  description text,
  status text,
  client_id uuid
);

GRANT SELECT ON public.calendly_connections, public.zoom_connections TO authenticated;

-- Rows that exist before the migration, so the backfill inside it has work to do.
INSERT INTO public.meetings (title, start_time, end_time, status, source, external_provider, external_event_uri, external_invitee_uri, client_id, lead_id, notes)
VALUES
  (
    'seed-past-calendly',
    now() - interval '10 days',
    now() - interval '10 days' + interval '30 minutes',
    'scheduled',
    'calendly',
    'calendly',
    'https://api.calendly.com/scheduled_events/seed-past',
    'https://api.calendly.com/scheduled_events/seed-past/invitees/1',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    'keep these notes'
  ),
  (
    'seed-future-calendly',
    now() + interval '3 days',
    now() + interval '3 days' + interval '30 minutes',
    'scheduled',
    'calendly',
    'calendly',
    'https://api.calendly.com/scheduled_events/seed-future',
    'https://api.calendly.com/scheduled_events/seed-future/invitees/1',
    NULL,
    NULL,
    NULL
  ),
  (
    'seed-past-manual',
    now() - interval '2 days',
    now() - interval '2 days' + interval '30 minutes',
    'scheduled',
    'manual',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  ),
  (
    'seed-past-zoom',
    now() - interval '1 day',
    now() - interval '1 day' + interval '30 minutes',
    'scheduled',
    'zoom',
    'zoom',
    'zoom:seed',
    NULL,
    NULL,
    NULL,
    NULL
  );

INSERT INTO public.calendly_connections (id, user_id, calendly_user_uri, status)
VALUES ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 'https://api.calendly.com/users/advisor', 'connected');

INSERT INTO public.calendly_connection_tokens (connection_id, access_token, refresh_token, token_expires_at)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  'access-token-standin',
  'refresh-token-standin',
  now() - interval '1 day'
);

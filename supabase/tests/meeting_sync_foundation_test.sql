-- Assertions for 20261115120000_meeting_sync_foundation.sql.
-- Safe to run more than once against the stand-in database.

DELETE FROM public.integration_webhook_events WHERE event_key LIKE 'case-%';
DELETE FROM public.meeting_external_aliases WHERE external_id LIKE 'case-%';
DELETE FROM public.tasks WHERE title LIKE 'case-%' OR source_ref LIKE 'zoom:recap:case%';
DELETE FROM public.meetings WHERE title LIKE 'case-%';

DO $$
DECLARE
  row public.meetings;
  n integer;
  unique_event integer;
BEGIN
  SELECT * INTO row FROM public.meetings WHERE title = 'seed-past-calendly';
  IF row.status IS DISTINCT FROM 'completed' OR row.status_origin IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'past Calendly meeting was not auto-completed (status=%, origin=%)', row.status, row.status_origin;
  END IF;
  IF row.client_id IS DISTINCT FROM '11111111-1111-1111-1111-111111111111'::uuid
     OR row.notes IS DISTINCT FROM 'keep these notes' THEN
    RAISE EXCEPTION 'backfill changed CRM-owned fields';
  END IF;

  SELECT * INTO row FROM public.meetings WHERE title = 'seed-future-calendly';
  IF row.status IS DISTINCT FROM 'scheduled' OR row.status_origin IS NOT NULL THEN
    RAISE EXCEPTION 'future meeting should stay scheduled (status=%, origin=%)', row.status, row.status_origin;
  END IF;

  SELECT * INTO row FROM public.meetings WHERE title = 'seed-past-manual';
  IF row.status IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION 'manual meetings must not be auto-completed';
  END IF;

  SELECT * INTO row FROM public.meetings WHERE title = 'seed-past-zoom';
  IF row.status IS DISTINCT FROM 'completed' OR row.status_origin IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'past Zoom meeting was not auto-completed';
  END IF;

  SELECT count(*) INTO unique_event
  FROM pg_index ix
  JOIN pg_class idx ON idx.oid = ix.indexrelid
  JOIN pg_class tbl ON tbl.oid = ix.indrelid
  JOIN pg_namespace nsp ON nsp.oid = tbl.relnamespace
  WHERE nsp.nspname = 'public'
    AND tbl.relname = 'meetings'
    AND ix.indisunique
    AND NOT ix.indisprimary
    AND (
      SELECT array_agg(att.attname ORDER BY k.ord)
      FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute att ON att.attrelid = ix.indrelid AND att.attnum = k.attnum
      WHERE k.attnum > 0
    ) = ARRAY['external_event_uri']::name[];
  IF unique_event <> 0 THEN
    RAISE EXCEPTION 'external_event_uri is still unique';
  END IF;
END $$;

-- Group event: two invitees, one event URI.
INSERT INTO public.meetings (title, start_time, end_time, status, source, external_provider, external_event_uri, external_invitee_uri)
VALUES
  ('case-group-a', now() + interval '1 day', now() + interval '1 day' + interval '30 minutes', 'scheduled', 'calendly', 'calendly', 'https://api.calendly.com/scheduled_events/group', 'case-invitee-a'),
  ('case-group-b', now() + interval '1 day', now() + interval '1 day' + interval '30 minutes', 'scheduled', 'calendly', 'calendly', 'https://api.calendly.com/scheduled_events/group', 'case-invitee-b');

DO $$
BEGIN
  BEGIN
    INSERT INTO public.meetings (title, status, source, external_provider, external_event_uri, external_invitee_uri)
    VALUES ('case-dup-invitee', 'scheduled', 'calendly', 'calendly', 'https://api.calendly.com/scheduled_events/other', 'case-invitee-a');
    RAISE EXCEPTION 'duplicate invitee URI was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.meetings (title, status, source, external_provider, external_event_uri)
    VALUES ('case-dup-zoom', 'scheduled', 'zoom', 'zoom', 'zoom:seed');
    RAISE EXCEPTION 'duplicate Zoom event URI was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

-- Advisor lock survives auto-complete. A second pass is a no-op.
INSERT INTO public.meetings (title, start_time, end_time, status, status_origin, source, external_provider, external_event_uri, external_invitee_uri, notes)
VALUES (
  'case-advisor-past',
  now() - interval '4 days',
  now() - interval '4 days' + interval '30 minutes',
  'scheduled',
  'advisor',
  'calendly',
  'calendly',
  'https://api.calendly.com/scheduled_events/advisor-lock',
  'case-invitee-advisor',
  'advisor left this scheduled'
);

DO $$
DECLARE
  n integer;
  row public.meetings;
BEGIN
  n := public.complete_stale_scheduled_meetings();
  IF n <> 0 THEN
    RAISE EXCEPTION 'second auto-complete changed % row(s); expected 0', n;
  END IF;
  SELECT * INTO row FROM public.meetings WHERE title = 'case-advisor-past';
  IF row.status IS DISTINCT FROM 'scheduled' OR row.status_origin IS DISTINCT FROM 'advisor' THEN
    RAISE EXCEPTION 'advisor status was overwritten (status=%, origin=%)', row.status, row.status_origin;
  END IF;
END $$;

-- Browser status edits become advisor-owned. Service role can still set provider.
INSERT INTO public.meetings (title, start_time, end_time, status, source, external_invitee_uri)
VALUES ('case-trigger', now() + interval '2 days', now() + interval '2 days' + interval '30 minutes', 'scheduled', 'calendly', 'case-invitee-trigger');

DO $$
DECLARE
  row public.meetings;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  UPDATE public.meetings SET status = 'no_show' WHERE title = 'case-trigger';
  SELECT * INTO row FROM public.meetings WHERE title = 'case-trigger';
  IF row.status_origin IS DISTINCT FROM 'advisor' OR row.status IS DISTINCT FROM 'no_show' THEN
    RAISE EXCEPTION 'authenticated status edit did not lock origin (status=%, origin=%)', row.status, row.status_origin;
  END IF;

  UPDATE public.meetings SET notes = 'still locked' WHERE title = 'case-trigger';
  SELECT * INTO row FROM public.meetings WHERE title = 'case-trigger';
  IF row.status_origin IS DISTINCT FROM 'advisor' THEN
    RAISE EXCEPTION 'notes edit cleared the advisor lock';
  END IF;

  UPDATE public.meetings SET status_origin = 'provider' WHERE title = 'case-trigger';
  SELECT * INTO row FROM public.meetings WHERE title = 'case-trigger';
  IF row.status_origin IS DISTINCT FROM 'advisor' THEN
    RAISE EXCEPTION 'browser was able to clear status_origin';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  UPDATE public.meetings
  SET status = 'canceled', status_origin = 'provider'
  WHERE title = 'case-trigger';
  SELECT * INTO row FROM public.meetings WHERE title = 'case-trigger';
  IF row.status IS DISTINCT FROM 'canceled' OR row.status_origin IS DISTINCT FROM 'provider' THEN
    RAISE EXCEPTION 'service role could not set provider status (status=%, origin=%)', row.status, row.status_origin;
  END IF;

  PERFORM set_config('request.jwt.claim.role', '', true);
END $$;

-- Reschedule alias keeps one meeting id.
INSERT INTO public.meeting_external_aliases (meeting_id, provider, kind, external_id)
SELECT id, 'calendly', 'invitee', 'case-old-invitee'
FROM public.meetings
WHERE title = 'case-trigger';

DO $$
BEGIN
  BEGIN
    INSERT INTO public.meeting_external_aliases (meeting_id, provider, kind, external_id)
    SELECT id, 'calendly', 'invitee', 'case-old-invitee'
    FROM public.meetings WHERE title = 'case-trigger';
    RAISE EXCEPTION 'duplicate alias was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

INSERT INTO public.tasks (title, description, status, client_id, source_ref)
VALUES ('case-recap', 'Auto-created when the Zoom meeting ended.', 'todo', '11111111-1111-1111-1111-111111111111', 'zoom:recap:case');

DO $$
BEGIN
  BEGIN
    INSERT INTO public.tasks (title, status, source_ref)
    VALUES ('case-recap-dup', 'todo', 'zoom:recap:case');
    RAISE EXCEPTION 'duplicate recap source_ref was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END $$;

-- Webhook log is not readable by the browser role.
DO $$
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    PERFORM 1 FROM public.integration_webhook_events;
    RAISE EXCEPTION 'authenticated read the webhook log';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  PERFORM set_config('role', 'postgres', true);
END $$;

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('role', 'service_role', true);
  INSERT INTO public.integration_webhook_events (provider, event_key, event_type, status)
  VALUES ('calendly', 'case-event', 'invitee.created', 'processed');
  INSERT INTO public.integration_webhook_events (provider, event_key, event_type, status)
  VALUES ('calendly', 'case-event', 'invitee.created', 'processed')
  ON CONFLICT (provider, event_key) DO NOTHING;
  SELECT count(*) INTO n FROM public.integration_webhook_events WHERE event_key = 'case-event';
  IF n <> 1 THEN
    RAISE EXCEPTION 'webhook idempotency key accepted % rows', n;
  END IF;
  PERFORM set_config('role', 'postgres', true);
END $$;

-- Expired token is mirrored onto the connection without copying the secret.
DO $$
DECLARE
  status text;
  expires timestamptz;
  token text;
BEGIN
  SELECT c.token_status, c.token_expires_at
    INTO status, expires
  FROM public.calendly_connections c
  WHERE c.id = '33333333-3333-3333-3333-333333333333';
  IF status IS DISTINCT FROM 'expired' OR expires IS NULL THEN
    RAISE EXCEPTION 'token health was not mirrored (status=%)', status;
  END IF;

  SELECT column_name INTO token
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'calendly_connections'
    AND column_name IN ('access_token', 'refresh_token');
  IF token IS NOT NULL THEN
    RAISE EXCEPTION 'connection health table gained a token column';
  END IF;
END $$;

-- Own row still visible, other rows hidden, admin can see the team.
DO $$
DECLARE
  n integer;
BEGIN
  CREATE OR REPLACE FUNCTION public.is_admin()
  RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO n FROM public.calendly_connections;
  IF n <> 1 THEN
    RAISE EXCEPTION 'advisor should see their own connection, saw %', n;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  SELECT count(*) INTO n FROM public.calendly_connections;
  IF n <> 0 THEN
    RAISE EXCEPTION 'advisor saw another connection';
  END IF;

  PERFORM set_config('role', 'postgres', true);
  CREATE OR REPLACE FUNCTION public.is_admin()
  RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;

  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO n FROM public.calendly_connections;
  IF n <> 1 THEN
    RAISE EXCEPTION 'admin should see team connections, saw %', n;
  END IF;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

SELECT public.invoke_integration_reconcile();
SELECT public.run_integration_maintenance();

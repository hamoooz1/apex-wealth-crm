-- Assertions for 20261115150000_zoom_source_of_truth.sql.

DELETE FROM public.meeting_external_aliases WHERE external_id IN ('83726104521', '11122233344');
DELETE FROM public.meetings WHERE external_invitee_uri LIKE 'case-zoom-%' OR external_event_uri IN ('zoom:83726104521', 'zoom:11122233344');

DO $$
DECLARE
  n integer;
  got text;
  row public.meetings;
BEGIN
  IF public.extract_zoom_meeting_id('https://us02web.zoom.us/j/83726104521?pwd=abc') IS DISTINCT FROM '83726104521' THEN
    RAISE EXCEPTION 'join URL was not parsed';
  END IF;
  IF public.extract_zoom_meeting_id('https://zoom.us/wc/join/83726104521') IS DISTINCT FROM '83726104521' THEN
    RAISE EXCEPTION 'wc/join URL was not parsed';
  END IF;
  IF public.extract_zoom_meeting_id('https://zoom.us/my/advisor') IS NOT NULL THEN
    RAISE EXCEPTION 'personal zoom link was treated as a meeting id';
  END IF;
  IF public.extract_zoom_meeting_id('zoom:seed') IS NOT NULL THEN
    RAISE EXCEPTION 'non-numeric zoom uri was accepted';
  END IF;

  INSERT INTO public.meetings (title, status, source, external_provider, external_event_uri, external_invitee_uri)
  VALUES ('case-zoom-uri', 'scheduled', 'zoom', 'zoom', 'zoom:83726104521', 'case-zoom-uri');

  ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS meeting_url text;
  ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS location jsonb;
  INSERT INTO public.meetings (
    title, status, source, external_provider, external_event_uri, external_invitee_uri, meeting_url, location
  )
  VALUES (
    'case-zoom-calendly',
    'scheduled',
    'calendly',
    'calendly',
    'https://api.calendly.com/scheduled_events/case-zoom',
    'case-zoom-calendly',
    'https://zoom.us/j/11122233344',
    '{"type":"zoom","join_url":"https://zoom.us/j/11122233344","data":{"id":"11122233344"}}'::jsonb
  );

  n := public.backfill_zoom_meeting_ids();
  IF n < 2 THEN
    RAISE EXCEPTION 'backfill returned %; expected at least 2', n;
  END IF;

  SELECT zoom_meeting_id INTO got FROM public.meetings WHERE external_invitee_uri = 'case-zoom-uri';
  IF got IS DISTINCT FROM '83726104521' THEN
    RAISE EXCEPTION 'zoom uri backfill produced %', got;
  END IF;
  SELECT * INTO row FROM public.meetings WHERE external_invitee_uri = 'case-zoom-calendly';
  IF row.zoom_meeting_id IS DISTINCT FROM '11122233344' THEN
    RAISE EXCEPTION 'calendly location backfill produced %', row.zoom_meeting_id;
  END IF;

  n := public.backfill_zoom_meeting_ids();
  IF n <> 0 THEN
    RAISE EXCEPTION 'second backfill changed % row(s)', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.meeting_external_aliases
    WHERE provider = 'zoom' AND kind = 'zoom_meeting' AND external_id = '83726104521'
  ) THEN
    RAISE EXCEPTION 'zoom id was not aliased';
  END IF;

  SELECT zoom_meeting_id INTO got FROM public.meetings WHERE title = 'seed-past-zoom';
  IF got IS NOT NULL THEN
    RAISE EXCEPTION 'non-numeric zoom:seed was stored as an id';
  END IF;
END $$;

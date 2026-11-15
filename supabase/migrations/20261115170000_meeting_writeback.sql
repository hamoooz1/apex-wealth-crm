-- Phase 4: remember the last write-back to Calendly or Zoom.
--
-- Idempotent. The columns are status for the UI. They are not secrets.
-- Webhooks do not call Calendly or Zoom, so a write-back cannot loop.

DO $$
BEGIN
  IF to_regclass('public.meetings') IS NULL THEN
    RAISE NOTICE 'public.meetings is missing; skipped write-back columns';
    RETURN;
  END IF;

  ALTER TABLE public.meetings
    ADD COLUMN IF NOT EXISTS last_writeback_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_writeback_error text,
    ADD COLUMN IF NOT EXISTS last_writeback_note text;

  COMMENT ON COLUMN public.meetings.last_writeback_error IS
    'Set when Calendly or Zoom rejected a cancel, reschedule, or delete the CRM already saved.';
  COMMENT ON COLUMN public.meetings.last_writeback_note IS
    'A limit rather than a failure. Calendly cannot move an existing booking; the CRM keeps the advisor time.';
END $$;

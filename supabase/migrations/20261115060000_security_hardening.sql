-- Apex Wealth CRM security hardening.
--
-- Idempotent: safe to run more than once. Does not update or delete CRM rows.
-- Apply yourself in the Supabase SQL editor (one script) or with
-- `supabase db push`. Do not run this from an automated agent against production.
--
-- Before applying:
--   * Confirm at least one profiles row has role = 'admin' AND is_active = true.
--     is_admin() starts requiring an active admin. The SQL editor (postgres)
--     can still reactivate a row if you lock yourself out of the app.
--   * Read the pull request checklist for Auth dashboard settings.
--
-- This script is defensive about objects that are not in the repo: it drops
-- policies by the names in the live audit and also replaces every policy on
-- public.profiles, rewrites other policies in place, and skips grants/indexes
-- when the table or column is absent.

-- ---------------------------------------------------------------------------
-- Helpers. Active flag matches the app: NULL is treated as active.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.caller_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND coalesce(is_active, true)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'admin'
      AND coalesce(is_active, true)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'manager'
      AND coalesce(is_active, true)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_advisor()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'advisor'
      AND coalesce(is_active, true)
  );
$$;

-- Advisor peers: same manager_id. Managers use the downline helper, not this.
CREATE OR REPLACE FUNCTION public.shares_manager(target_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles me
    JOIN public.profiles them ON them.id = target_user
    WHERE me.id = (SELECT auth.uid())
      AND me.role = 'advisor'
      AND coalesce(me.is_active, true)
      AND me.manager_id IS NOT NULL
      AND them.manager_id = me.manager_id
  );
$$;

-- Active manager's recursive reports, including inactive reports (so they can
-- be reactivated). Does not include the caller.
CREATE OR REPLACE FUNCTION public.is_downline(target_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE tree AS (
    SELECT p.id, ARRAY[p.id] AS path
    FROM public.profiles p
    WHERE p.manager_id = (SELECT auth.uid())
    UNION ALL
    SELECT c.id, t.path || c.id
    FROM public.profiles c
    JOIN tree t ON c.manager_id = t.id
    WHERE NOT c.id = ANY (t.path)
  )
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles me
    WHERE me.id = (SELECT auth.uid())
      AND me.role = 'manager'
      AND coalesce(me.is_active, true)
      AND EXISTS (SELECT 1 FROM tree WHERE tree.id = target_user)
  );
$$;

-- ---------------------------------------------------------------------------
-- Profile writes.
-- Safe columns stay on the table API. role / manager_id / is_active / email
-- are admin-only (managers may flip is_active on their downline) and are
-- enforced by a trigger plus column privileges. The RPC is what Settings uses.
-- Service role and the SQL editor bypass the trigger so invites and repairs work.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_profile_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jwt_role text := coalesce(auth.role(), '');
  actor uuid := auth.uid();
BEGIN
  IF jwt_role IN ('service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- Dashboard SQL and the auth hook have no end-user JWT.
  IF jwt_role = '' AND session_user IN ('postgres', 'supabase_admin', 'supabase_auth_admin') THEN
    RETURN NEW;
  END IF;

  IF jwt_role = 'anon' OR actor IS NULL THEN
    RAISE EXCEPTION 'Not allowed to modify profiles';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'Not allowed to create this profile';
    END IF;
    NEW.role := 'advisor';
    NEW.manager_id := NULL;
    NEW.is_active := true;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Profile id cannot be changed';
  END IF;

  IF OLD.role = 'admin'
     AND coalesce(OLD.is_active, true)
     AND (
       NEW.role IS DISTINCT FROM 'admin'
       OR coalesce(NEW.is_active, true) = false
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.profiles p
       WHERE p.role = 'admin'
         AND coalesce(p.is_active, true)
         AND p.id <> OLD.id
     )
  THEN
    RAISE EXCEPTION 'Cannot remove or deactivate the last active admin';
  END IF;

  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.manager_id IS DISTINCT FROM OLD.manager_id
     OR NEW.email IS DISTINCT FROM OLD.email
  THEN
    RAISE EXCEPTION 'Only an active admin can change role, manager, or email';
  END IF;

  IF OLD.id = actor THEN
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'You cannot change your own active status';
    END IF;
    RETURN NEW;
  END IF;

  IF public.is_downline(OLD.id) THEN
    IF (to_jsonb(NEW) - 'is_active' - 'updated_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'is_active' - 'updated_at')
    THEN
      RAISE EXCEPTION 'Managers can only change active status for people on their team';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Not allowed to update this profile';
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_privileged_columns ON public.profiles;
DROP TRIGGER IF EXISTS aaa_guard_profile_privileged_columns ON public.profiles;
CREATE TRIGGER aaa_guard_profile_privileged_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_privileged_columns();

CREATE OR REPLACE FUNCTION public.update_profile_access(
  target_id uuid,
  new_role text DEFAULT NULL,
  new_manager_id uuid DEFAULT NULL,
  new_is_active boolean DEFAULT NULL,
  set_role boolean DEFAULT false,
  set_manager boolean DEFAULT false,
  set_active boolean DEFAULT false
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result public.profiles;
  actor uuid := auth.uid();
BEGIN
  IF actor IS NULL OR NOT public.caller_is_active() THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  IF NOT set_role AND NOT set_manager AND NOT set_active THEN
    RAISE EXCEPTION 'Nothing to update';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = target_id) THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF set_role OR set_manager THEN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'Only an active admin can change role or manager';
    END IF;
  END IF;

  IF set_role AND (new_role IS NULL OR new_role NOT IN ('admin', 'manager', 'advisor')) THEN
    RAISE EXCEPTION 'Role must be admin, manager, or advisor';
  END IF;

  IF set_manager AND new_manager_id IS NOT NULL THEN
    IF new_manager_id = target_id THEN
      RAISE EXCEPTION 'A person cannot be their own manager';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = new_manager_id
        AND role IN ('admin', 'manager')
        AND coalesce(is_active, true)
    ) THEN
      RAISE EXCEPTION 'Manager must be an active admin or manager';
    END IF;
    IF EXISTS (
      WITH RECURSIVE chain AS (
        SELECT p.manager_id AS id, ARRAY[p.id] AS path
        FROM public.profiles p
        WHERE p.id = new_manager_id
        UNION ALL
        SELECT parent.manager_id, c.path || parent.id
        FROM public.profiles parent
        JOIN chain c ON parent.id = c.id
        WHERE c.id IS NOT NULL
          AND NOT parent.id = ANY (c.path)
      )
      SELECT 1 FROM chain WHERE id = target_id
    ) THEN
      RAISE EXCEPTION 'That manager assignment would create a cycle';
    END IF;
  END IF;

  IF set_active THEN
    IF new_is_active IS NULL THEN
      RAISE EXCEPTION 'Active status is required';
    END IF;
    IF NOT public.is_admin() THEN
      IF target_id = actor OR NOT public.is_downline(target_id) THEN
        RAISE EXCEPTION 'You can only change active status for people on your team';
      END IF;
    END IF;
  END IF;

  UPDATE public.profiles
  SET
    role = CASE WHEN set_role THEN new_role ELSE role END,
    manager_id = CASE WHEN set_manager THEN new_manager_id ELSE manager_id END,
    is_active = CASE WHEN set_active THEN new_is_active ELSE is_active END
  WHERE id = target_id
  RETURNING * INTO result;

  IF result.id IS NULL THEN
    RAISE EXCEPTION 'Profile update failed';
  END IF;

  RETURN result;
END;
$$;

-- Column privileges: authenticated keeps the non-privileged columns so the
-- profile form can save a name and avatar. Privileged columns go through
-- update_profile_access (security definer), which bypasses column grants.
DO $$
DECLARE
  col text;
BEGIN
  REVOKE INSERT, DELETE ON public.profiles FROM PUBLIC, anon, authenticated;
  REVOKE UPDATE ON public.profiles FROM PUBLIC, anon, authenticated;

  FOR col IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name NOT IN ('id', 'role', 'manager_id', 'is_active', 'email', 'created_at')
  LOOP
    EXECUTE format('GRANT UPDATE (%I) ON public.profiles TO authenticated', col);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Profiles RLS. Team model:
--   admin    -> every profile
--   manager  -> self + recursive downline
--   advisor  -> self + same-manager peers
-- Own-row SELECT stays available when the account is inactive so the app can
-- show the deactivated screen. Other access requires an active caller.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can update own basic profile" ON public.profiles;
DROP POLICY IF EXISTS "Managers can update downline profiles" ON public.profiles;
DROP POLICY IF EXISTS "Advisors can view peers with same manager" ON public.profiles;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.profiles', pol.policyname);
  END LOOP;
END $$;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_own"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (id = (SELECT auth.uid()));

CREATE POLICY "profiles_select_admin"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "profiles_select_downline"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.is_downline(id));

CREATE POLICY "profiles_select_peers"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.shares_manager(id));

CREATE POLICY "profiles_update_own"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = (SELECT auth.uid()) AND public.caller_is_active())
  WITH CHECK (id = (SELECT auth.uid()) AND public.caller_is_active());

CREATE POLICY "profiles_update_admin"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "profiles_update_manager_downline"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (public.is_downline(id))
  WITH CHECK (public.is_downline(id));

-- ---------------------------------------------------------------------------
-- New users. Never trust raw_user_meta_data for role or manager_id.
-- app_metadata is optional and only the service role can write it; invite-user
-- also patches the profile row after the auth user exists.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  full_name text;
  role_text text;
  manager_text text;
  manager_uuid uuid;
BEGIN
  full_name := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), '');
  IF full_name IS NULL THEN
    full_name := NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), '');
  END IF;
  IF full_name IS NULL THEN
    full_name := 'New user';
  END IF;

  role_text := COALESCE(NEW.raw_app_meta_data->>'role', 'advisor');
  IF role_text NOT IN ('admin', 'manager', 'advisor') THEN
    role_text := 'advisor';
  END IF;

  manager_text := NULLIF(btrim(COALESCE(NEW.raw_app_meta_data->>'manager_id', '')), '');
  IF manager_text IS NULL THEN
    manager_uuid := NULL;
  ELSE
    BEGIN
      manager_uuid := manager_text::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        manager_uuid := NULL;
    END;
  END IF;

  INSERT INTO public.profiles (id, email, full_name, role, manager_id, is_active)
  VALUES (NEW.id, NEW.email, full_name, role_text, manager_uuid, true)
  ON CONFLICT (id) DO UPDATE
    SET
      email = EXCLUDED.email,
      full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name);
  -- Role and manager are intentionally left untouched on conflict.

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE NOTICE 'auth.users is missing; handle_new_user was replaced but not attached';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger tg
    JOIN pg_proc p ON p.oid = tg.tgfoid
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth'
      AND c.relname = 'users'
      AND NOT tg.tgisinternal
      AND p.proname = 'handle_new_user'
  ) THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_new_user();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Rewrite existing policies: (select auth.uid()), TO authenticated, and
-- require an active profile. profiles is already rebuilt above.
-- Public avatar reads stay public so <img> URLs keep working.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._security_migration_wrap_auth(expr text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  out text := expr;
BEGIN
  IF out IS NULL THEN
    RETURN NULL;
  END IF;

  out := regexp_replace(out, '\(\s*select\s+auth\s*\.\s*uid\s*\(\s*\)\s*\)', '___UID___', 'gi');
  out := regexp_replace(out, '\(\s*select\s+auth\s*\.\s*role\s*\(\s*\)\s*\)', '___ROLE___', 'gi');
  out := regexp_replace(out, '\(\s*select\s+auth\s*\.\s*jwt\s*\(\s*\)\s*\)', '___JWT___', 'gi');
  out := regexp_replace(out, 'auth\s*\.\s*uid\s*\(\s*\)', '(select auth.uid())', 'gi');
  out := regexp_replace(out, 'auth\s*\.\s*role\s*\(\s*\)', '(select auth.role())', 'gi');
  out := regexp_replace(out, 'auth\s*\.\s*jwt\s*\(\s*\)', '(select auth.jwt())', 'gi');
  out := replace(out, '___UID___', '(select auth.uid())');
  out := replace(out, '___ROLE___', '(select auth.role())');
  out := replace(out, '___JWT___', '(select auth.jwt())');
  RETURN out;
END;
$$;

DO $$
DECLARE
  pol record;
  new_qual text;
  new_check text;
  role_list text;
  needs_role boolean;
  needs_wrap boolean;
  needs_active boolean;
  exempt boolean;
BEGIN
  DROP TABLE IF EXISTS _policy_rewrite;
  CREATE TEMP TABLE _policy_rewrite ON COMMIT DROP AS
  SELECT *
  FROM pg_policies
  WHERE schemaname IN ('public', 'storage')
    AND NOT (schemaname = 'public' AND tablename = 'profiles');

  FOR pol IN
    SELECT *
    FROM _policy_rewrite
  LOOP
    exempt :=
      pol.schemaname = 'storage'
      AND pol.tablename = 'objects'
      AND pol.cmd = 'SELECT'
      AND (
        pol.policyname ILIKE '%avatar%'
        OR coalesce(pol.qual, '') ~* 'avatars'
      )
      AND coalesce(pol.qual, '') !~* 'auth\s*\.\s*uid';

    IF exempt THEN
      CONTINUE;
    END IF;

    -- Leave service-role-only policies alone.
    IF pol.roles <@ ARRAY['service_role']::name[] AND NOT ('public' = ANY (pol.roles) OR 'anon' = ANY (pol.roles)) THEN
      CONTINUE;
    END IF;

    new_qual := public._security_migration_wrap_auth(pol.qual);
    new_check := public._security_migration_wrap_auth(pol.with_check);

    IF new_qual IS NOT NULL AND new_qual !~* 'caller_is_active\s*\(' THEN
      new_qual := '(' || new_qual || ') AND public.caller_is_active()';
    END IF;
    IF new_check IS NOT NULL AND new_check !~* 'caller_is_active\s*\(' THEN
      new_check := '(' || new_check || ') AND public.caller_is_active()';
    END IF;

    SELECT string_agg(quote_ident(role_name), ', ' ORDER BY role_name)
      INTO role_list
    FROM (
      SELECT DISTINCT CASE
        WHEN r::text IN ('public', 'anon') THEN 'authenticated'
        ELSE r::text
      END AS role_name
      FROM unnest(pol.roles) AS r
    ) mapped;

    IF role_list IS NULL OR role_list = '' THEN
      RAISE NOTICE 'Skipping policy % on %.% (no roles)', pol.policyname, pol.schemaname, pol.tablename;
      CONTINUE;
    END IF;

    needs_role := 'public' = ANY (pol.roles) OR 'anon' = ANY (pol.roles);
    needs_wrap := new_qual IS DISTINCT FROM public._security_migration_wrap_auth(pol.qual)
      OR new_check IS DISTINCT FROM public._security_migration_wrap_auth(pol.with_check);
    -- needs_wrap above compares post-active text to wrap-only text, so it is
    -- true whenever caller_is_active was added. Also detect a real auth wrap:
    needs_wrap := needs_wrap
      OR public._security_migration_wrap_auth(pol.qual) IS DISTINCT FROM pol.qual
      OR public._security_migration_wrap_auth(pol.with_check) IS DISTINCT FROM pol.with_check;
    needs_active :=
      (pol.qual IS NOT NULL AND pol.qual !~* 'caller_is_active\s*\(')
      OR (pol.with_check IS NOT NULL AND pol.with_check !~* 'caller_is_active\s*\(');

    IF NOT needs_role AND NOT needs_wrap AND NOT needs_active THEN
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);

    EXECUTE format(
      'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s %s %s',
      pol.policyname,
      pol.schemaname,
      pol.tablename,
      pol.permissive,
      pol.cmd,
      role_list,
      CASE WHEN new_qual IS NOT NULL THEN format('USING (%s)', new_qual) ELSE '' END,
      CASE WHEN new_check IS NOT NULL THEN format('WITH CHECK (%s)', new_check) ELSE '' END
    );
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public._security_migration_wrap_auth(text);

-- ---------------------------------------------------------------------------
-- notifications.read_at and client_notes.body are the only client updates.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.notifications') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'read_at'
     )
  THEN
    REVOKE UPDATE ON public.notifications FROM PUBLIC, anon, authenticated;
    GRANT UPDATE (read_at) ON public.notifications TO authenticated;
  END IF;

  IF to_regclass('public.client_notes') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'client_notes' AND column_name = 'body'
     )
  THEN
    REVOKE UPDATE ON public.client_notes FROM PUBLIC, anon, authenticated;
    GRANT UPDATE (body) ON public.client_notes TO authenticated;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- OAuth token tables stay in public so the deployed edge functions (service
-- role, PostgREST) keep working. API roles lose every grant. RLS is forced
-- and policies are removed, so a future GRANT still does not expose rows to
-- anon/authenticated. service_role is BYPASSRLS in Supabase and is re-granted.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  pol record;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'calendly_connection_tokens',
    'zoom_connection_tokens',
    'calendly_oauth_states',
    'zoom_oauth_states'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    FOR pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, t);
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
       AND EXISTS (
         SELECT 1
         FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = 'public'
           AND tablename = t
       )
    THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Avatars: keep the bucket public, cap size and MIME type, and only let a
-- user write inside their own folder (<uid>/...).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE 'storage schema is missing; skipped avatar bucket limits';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'storage'
      AND table_name = 'buckets'
      AND column_name = 'file_size_limit'
  ) THEN
    UPDATE storage.buckets
    SET
      file_size_limit = 2097152,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    WHERE id = 'avatars';
  END IF;
END $$;

DO $$
DECLARE
  pol record;
  expr text;
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND cmd IN ('SELECT', 'ALL')
      AND (
        policyname ILIKE '%avatar%'
        OR coalesce(qual, '') ~* 'avatars'
        OR coalesce(with_check, '') ~* 'avatars'
      )
  ) THEN
    CREATE POLICY "Anyone can view avatars"
      ON storage.objects
      FOR SELECT
      TO public
      USING (bucket_id = 'avatars');
  END IF;

  DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
  DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
  DROP POLICY IF EXISTS "Users can delete their own avatar" ON storage.objects;

  CREATE POLICY "Users can upload their own avatar"
    ON storage.objects
    FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'avatars'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
      AND public.caller_is_active()
    );

  CREATE POLICY "Users can update their own avatar"
    ON storage.objects
    FOR UPDATE
    TO authenticated
    USING (
      bucket_id = 'avatars'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
      AND public.caller_is_active()
    )
    WITH CHECK (
      bucket_id = 'avatars'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
      AND public.caller_is_active()
    );

  CREATE POLICY "Users can delete their own avatar"
    ON storage.objects
    FOR DELETE
    TO authenticated
    USING (
      bucket_id = 'avatars'
      AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
      AND public.caller_is_active()
    );

  FOR pol IN
    SELECT policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname NOT IN (
        'Users can upload their own avatar',
        'Users can update their own avatar',
        'Users can delete their own avatar'
      )
  LOOP
    expr := coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '');
    IF pol.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       AND expr ~* 'avatars'
       AND expr !~* 'auth\s*\.\s*uid'
    THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Indexes: every public foreign key that is not already a leading index,
-- plus meetings.start_time (the calendar filter).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
  idx_cols text;
  idx_name text;
  covered boolean;
BEGIN
  FOR r IN
    SELECT
      n.nspname AS schema_name,
      t.relname AS table_name,
      c.conrelid,
      array_agg(a.attname ORDER BY cols.ord) AS colnames
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS cols(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = cols.attnum
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
    GROUP BY n.nspname, t.relname, c.conname, c.conrelid
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_index i
      WHERE i.indrelid = r.conrelid
        AND i.indisvalid
        AND (
          SELECT array_agg(ia.attname ORDER BY k.ord)
          FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute ia
            ON ia.attrelid = r.conrelid
           AND ia.attnum = k.attnum
          WHERE k.ord <= cardinality(r.colnames)
            AND k.attnum > 0
        ) = r.colnames
    ) INTO covered;

    IF covered THEN
      CONTINUE;
    END IF;

    SELECT string_agg(format('%I', c), ', ')
      INTO idx_cols
    FROM unnest(r.colnames) AS c;

    idx_name := 'idx_' || r.table_name || '_' || array_to_string(r.colnames, '_');
    IF char_length(idx_name) > 60 THEN
      idx_name := left(idx_name, 50) || '_' || substr(md5(idx_name), 1, 8);
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
      idx_name,
      r.schema_name,
      r.table_name,
      idx_cols
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'meetings'
      AND column_name = 'start_time'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_meetings_start_time ON public.meetings (start_time)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- search_path on functions that do not already pin one (includes set_updated_at).
-- EXECUTE: anon/PUBLIC lose every public function. authenticated keeps helpers
-- and update_profile_access. Trigger functions, handle_new_user, and
-- log_activity are not callable through /rest/v1/rpc. Triggers still fire.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
  internal boolean;
BEGIN
  FOR r IN
    SELECT
      p.oid,
      p.oid::regprocedure AS sig,
      p.proname,
      p.proconfig,
      t.typname AS return_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_type t ON t.oid = p.prorettype
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.objid = p.oid
          AND d.deptype = 'e'
      )
  LOOP
    IF r.proconfig IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM unnest(r.proconfig) cfg
         WHERE cfg LIKE 'search_path=%'
       )
    THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public', r.sig);
    END IF;

    internal :=
      r.return_type = 'trigger'
      OR r.proname IN (
        'log_activity',
        'handle_new_user',
        'guard_profile_privileged_columns',
        'set_updated_at'
      )
      OR r.proname LIKE 'trg\_%';

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;

    IF internal THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE role = 'admin'
      AND coalesce(is_active, true)
  ) THEN
    RAISE WARNING 'No active admin profile. Sign-in as admin will not pass is_admin() until you set profiles.is_active = true for an admin from the SQL editor.';
  END IF;
END $$;

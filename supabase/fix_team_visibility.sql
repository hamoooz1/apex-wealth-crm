-- Fix admin org visibility + advisor peers + manager downline updates
-- Root cause: is_admin() required is_active=true, but the admin profile was inactive,
-- so RLS only returned their own row.

update public.profiles
set is_active = true
where email = 'kaderidev@gmail.com' and role = 'admin';

create or replace function public.shares_manager(target_user uuid)
returns boolean
language sql
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.profiles me
    join public.profiles them on them.id = target_user
    where me.id = auth.uid()
      and me.manager_id is not null
      and them.manager_id = me.manager_id
  );
$$;

drop policy if exists "Advisors can view peers with same manager" on public.profiles;
create policy "Advisors can view peers with same manager"
on public.profiles
for select
to public
using (shares_manager(id));

drop policy if exists "Managers can update downline profiles" on public.profiles;
create policy "Managers can update downline profiles"
on public.profiles
for update
to public
using (is_downline(id))
with check (is_downline(id));

-- Role-based admin check (inactive flag is for assignment lists, not authz)
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

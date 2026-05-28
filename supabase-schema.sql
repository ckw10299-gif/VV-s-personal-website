create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.app_items (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('todos', 'goals', 'materials', 'ideas', 'docs', 'memory')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);

insert into storage.buckets (id, name, public)
values ('personal-assets', 'personal-assets', false)
on conflict (id) do nothing;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do update
  set email = excluded.email,
      last_seen_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.app_items enable row level security;

drop policy if exists "profiles self read or admin" on public.profiles;
create policy "profiles self read or admin" on public.profiles
for select using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles self insert" on public.profiles;
create policy "profiles self insert" on public.profiles
for insert with check (auth.uid() = id and role = 'user');

drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update" on public.profiles
for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "app_items own data" on public.app_items;
create policy "app_items own data" on public.app_items
for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own files select" on storage.objects;
create policy "own files select" on storage.objects
for select using (
  bucket_id = 'personal-assets'
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists "own files insert" on storage.objects;
create policy "own files insert" on storage.objects
for insert with check (
  bucket_id = 'personal-assets'
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists "own files update" on storage.objects;
create policy "own files update" on storage.objects
for update using (
  bucket_id = 'personal-assets'
  and auth.uid()::text = (storage.foldername(name))[1]
) with check (
  bucket_id = 'personal-assets'
  and auth.uid()::text = (storage.foldername(name))[1]
);

drop policy if exists "own files delete" on storage.objects;
create policy "own files delete" on storage.objects
for delete using (
  bucket_id = 'personal-assets'
  and auth.uid()::text = (storage.foldername(name))[1]
);

-- 注册并登录你的账号后，再把下面这句里的邮箱改成你自己的邮箱并单独执行。
-- update public.profiles set role = 'admin' where email = 'your-email@example.com';

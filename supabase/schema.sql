begin;

create table if not exists public.catalog_images (
  id uuid primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  category text not null check (char_length(btrim(category)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 1000),
  tags text[] not null default '{}' check (cardinality(tags) <= 15),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  file_name text not null check (char_length(file_name) between 1 and 255),
  file_size integer not null check (file_size between 1 and 10485760),
  storage_path text not null unique,
  created_at timestamptz not null default now()
);

alter table public.catalog_images
  add column if not exists author text,
  add column if not exists slot integer,
  alter column owner_id drop not null,
  drop constraint if exists catalog_images_check,
  drop constraint if exists catalog_images_storage_path_check,
  drop constraint if exists catalog_images_author_check,
  drop constraint if exists catalog_images_slot_check,
  drop constraint if exists catalog_images_slot_key;

alter table public.catalog_images
  add constraint catalog_images_storage_path_check check (
    storage_path ~ ('^' || coalesce(owner_id::text, 'token') || '/' || id::text || '[.](jpg|png|webp|gif|avif)$')
  ),
  add constraint catalog_images_author_check check (char_length(btrim(author)) between 1 and 80),
  add constraint catalog_images_slot_check check (slot between 1 and 30),
  add constraint catalog_images_slot_key unique (slot);

create index if not exists catalog_images_date_id_idx
  on public.catalog_images (created_at desc, id desc);

alter table public.catalog_images enable row level security;
revoke all on table public.catalog_images from public, anon, authenticated;
grant select on table public.catalog_images to anon, authenticated;
grant insert on table public.catalog_images to authenticated;
revoke update on table public.catalog_images from service_role;
grant select, insert on table public.catalog_images to service_role;
grant update (author, category) on table public.catalog_images to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'catalog-images',
  'catalog-images',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from storage.buckets
    where id = 'catalog-images' and public and file_size_limit = 10485760
      and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
      and allowed_mime_types <@ array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
  ) then
    raise exception 'Já existe um bucket catalog-images com configurações diferentes das exigidas pelo catálogo.';
  end if;
end
$$;

drop policy if exists catalog_images_read on public.catalog_images;
create policy catalog_images_read
  on public.catalog_images for select to anon, authenticated
  using (true);

drop policy if exists catalog_images_insert on public.catalog_images;
create policy catalog_images_insert
  on public.catalog_images for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and slot is null
    and exists (
      select 1 from storage.objects as object
      where object.bucket_id = 'catalog-images' and object.name = storage_path
    )
  );

drop policy if exists catalog_files_insert on storage.objects;
create policy catalog_files_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'catalog-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and cardinality(storage.foldername(name)) = 1
    and storage.filename(name) ~ '^[a-f0-9-]{36}[.](jpg|png|webp|gif|avif)$'
  );

drop policy if exists catalog_files_read_own on storage.objects;
create policy catalog_files_read_own
  on storage.objects for select to authenticated
  using (
    bucket_id = 'catalog-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists catalog_files_cleanup on storage.objects;
create policy catalog_files_cleanup
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'catalog-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and not exists (
      select 1 from public.catalog_images as picture where picture.storage_path = name
    )
  );

notify pgrst, 'reload schema';

commit;

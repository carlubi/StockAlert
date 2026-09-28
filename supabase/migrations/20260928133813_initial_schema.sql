create type public.product_status as enum ('active', 'archived');

create table public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 180),
  brand text check (char_length(brand) <= 120),
  expiration_date date not null,
  date_label text check (char_length(date_label) <= 120),
  confidence numeric(3,2) not null check (confidence between 0 and 1),
  source_image_path text not null,
  status public.product_status not null default 'active',
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_owner_status_expiry_idx on public.products (owner_id, status, expiration_date);

create table public.product_versions (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  previous_expiration_date date not null, previous_image_path text not null, replacement_image_path text not null,
  created_at timestamptz not null default now()
);
create index product_versions_owner_product_idx on public.product_versions (owner_id, product_id, created_at desc);

create table public.web_push_subscriptions (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null, p256dh text not null, auth text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (owner_id, endpoint)
);
create table public.notification_log (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade, milestone_days smallint not null check (milestone_days in (0,1,5,10)), sent_at timestamptz not null default now(),
  unique (product_id, milestone_days)
);

create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
create trigger products_updated_at before update on public.products for each row execute function public.set_updated_at();
create trigger subscriptions_updated_at before update on public.web_push_subscriptions for each row execute function public.set_updated_at();

alter table public.products enable row level security;
alter table public.product_versions enable row level security;
alter table public.web_push_subscriptions enable row level security;
alter table public.notification_log enable row level security;

create policy "Users read own products" on public.products for select to authenticated using ((select auth.uid()) = owner_id);
create policy "Users add own products" on public.products for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "Users update own products" on public.products for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "Users read own product history" on public.product_versions for select to authenticated using ((select auth.uid()) = owner_id);
create policy "Users add own product history" on public.product_versions for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "Users manage own subscriptions" on public.web_push_subscriptions for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "Users read own notification log" on public.notification_log for select to authenticated using ((select auth.uid()) = owner_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('product-images', 'product-images', false, 5242880, array['image/jpeg','image/png','image/webp']) on conflict (id) do nothing;
create policy "Users upload own product photos" on storage.objects for insert to authenticated with check (bucket_id = 'product-images' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "Users read own product photos" on storage.objects for select to authenticated using (bucket_id = 'product-images' and owner_id = (select auth.uid()::text));
create policy "Users delete own product photos" on storage.objects for delete to authenticated using (bucket_id = 'product-images' and owner_id = (select auth.uid()::text));

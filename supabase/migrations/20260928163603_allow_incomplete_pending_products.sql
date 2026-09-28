alter table public.products
add column needs_review boolean not null default false;

alter table public.products
alter column expiration_date drop not null,
alter column units drop not null;

alter table public.products
add constraint products_active_complete_check
check (
  status <> 'active'
  or (needs_review = false and expiration_date is not null and units is not null)
);

alter table public.products
add column units integer not null default 1 check (units between 1 and 9999);

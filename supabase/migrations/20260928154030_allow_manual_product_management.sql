-- A manually entered product has no source photo. Keep the history nullable too,
-- so it can later be updated with a replacement photo.
alter table public.products alter column source_image_path drop not null;
alter table public.product_versions alter column previous_image_path drop not null;

-- RLS remains the authorization boundary: a signed-in user can only delete
-- rows whose owner_id matches their authenticated identity.
create policy "Users delete own products"
on public.products
for delete
to authenticated
using ((select auth.uid()) = owner_id);

-- NUMA doesn't cost stickers separately, so the "sticker" component type is
-- gone from the app (src/lib/products/component-types.ts). Narrow the CHECK to
-- match. No component used the type when this ran; any that did would need
-- re-typing first, or this fails and rolls back.
alter table product_components drop constraint if exists product_components_type_check;
alter table product_components add constraint product_components_type_check
  check (type in ('raw_material', 'product_package', 'other'));

notify pgrst, 'reload schema';

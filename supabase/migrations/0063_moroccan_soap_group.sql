-- The second (and last) inventory group: Original Moroccan Soap.
--
-- Same situation as the essential oils in 0062. The product's two variants each
-- carry their own raw material - beldi uses 'الصابون المغربي - Moroccan Black
-- Soap', nila uses 'الصابون المغربي بالنيلة الزرقاء - Moroccan Nila Soap' - so
-- whole-product counting spread every soap shipment evenly across both lines.
-- Counting them as one "Moroccan soap" balance is what the owner actually does
-- with the stock.
--
-- Costing is untouched: the two soaps cost 70 and 80 per kg and stay separate
-- components everywhere except this ledger view.
--
-- These are the only two products whose variants use DIFFERENT components. Body
-- Mist, Creamy Tint and Natural Body Butter each use one single component across
-- all their variants, so they already read as one line and need no group.
insert into inventory_groups (name, unit)
select 'Moroccan soap', 'kg'
where not exists (select 1 from inventory_groups where name = 'Moroccan soap');

update product_components
   set inventory_group_id = (select id from inventory_groups where name = 'Moroccan soap'),
       updated_at = now()
 where unit = 'kg'
   and inventory_group_id is null
   and account in (
     'الصابون المغربي - Moroccan Black Soap',
     'الصابون المغربي بالنيلة الزرقاء - Moroccan Nila Soap'
   );

notify pgrst, 'reload schema';

-- Every essential oil is counted as ONE line of stock.
--
-- 0062 seeded the 'Essential oil' group with the seven per-variant scents and
-- deliberately left out the raw generic oil. Two lines survived that:
--   * 'Essential oil - Oud Malaki' - a scent added after 0062 ran, attached to no
--     variant, no BOM, no purchases. It simply never joined the group.
--   * 'الزيت العطري الخام - Essential oil' - the raw oil, in the shared BOM of the
--     8ml mist (4 ml) and Sudanese Dalka (5 ml).
-- The owner counts all of it off one shelf, so all of it is one line.
--
-- Still a COUNTING view only: every component keeps its own cost (the scents run
-- 2,500-3,450 per litre), its own purchases and its own BOM rows. Nothing about
-- costing, margins or the Purchasing report changes.
update product_components
   set inventory_group_id = (select id from inventory_groups where name = 'Essential oil'),
       updated_at = now()
 where unit = 'l'
   and inventory_group_id is null
   and (account like 'Essential oil - %' or account = 'الزيت العطري الخام - Essential oil');

-- An opening balance is keyed to the ledger line, so a component that joins a
-- group must hand its counted quantity to the group's row or it drops out of the
-- count. (Both were zero when this ran; the merge is written out anyway so a
-- replay on other data stays correct.)
update inventory_opening_balances ob
   set quantity = ob.quantity + coalesce((
         select sum(m.quantity) from inventory_opening_balances m
          join product_components pc on pc.id = m.component_id
         where pc.inventory_group_id = ob.group_id), 0),
       updated_at = now()
 where ob.group_id = (select id from inventory_groups where name = 'Essential oil');

delete from inventory_opening_balances ob
 using product_components pc
 where pc.id = ob.component_id
   and pc.inventory_group_id is not null;

notify pgrst, 'reload schema';

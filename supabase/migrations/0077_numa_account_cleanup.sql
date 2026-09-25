-- NUMA skipped Laurel's account reset (0044), so account_types started from the
-- original template. Drop the ones NUMA doesn't use - the old couriers (Bosta,
-- Moverz), the template's Arabizi accounts and the Laurel-era additions the
-- owner asked to remove.
--
-- Only accounts with nothing recorded against them are removed, so a replay on
-- a database that has since been used can't orphan a transaction.
delete from account_types a
where a.name in (
    'Top Management Salary',
    'Office supplies',
    'Refunds',
    'Assets',
    'Bosta',
    'Moverz',
    'Ta7selat',
    'Tasne3'
  )
  and not exists (select 1 from recorded_transactions t where t.account_type_id = a.id);

notify pgrst, 'reload schema';

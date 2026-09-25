-- Optional free-text description the buyer can attach when recording a purchase
-- (e.g. supplier, invoice number, or any remark), matching the Expense tab's
-- Description field. Nullable; existing rows and the seeded baseline rows have
-- no description.
alter table purchases add column if not exists description text;

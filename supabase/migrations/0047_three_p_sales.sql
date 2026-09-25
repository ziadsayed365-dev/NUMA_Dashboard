-- 3P (third-party) sales: finished goods sold outside the normal courier flow,
-- recorded by hand in the Shipping Orders → 3P Sales tab. They are real,
-- 100%-delivered sales, shown as their own "3P Sales" and "3P COGS" lines in the
-- Actual income statement (3P COGS = the product's built cost x quantity).
create table if not exists three_p_sales (
  id bigint generated always as identity primary key,
  date date not null,
  product_id bigint not null references products(id) on delete cascade,
  quantity numeric(12, 3) not null,
  amount numeric(12, 2) not null, -- total sale value for the line (revenue)
  created_at timestamptz not null default now()
);

create index if not exists three_p_sales_date_idx on three_p_sales (date);

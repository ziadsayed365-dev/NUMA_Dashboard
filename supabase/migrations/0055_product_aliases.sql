-- Arabic names for finished goods, learned from pasted WhatsApp orders.
--
-- The catalog is English ("Original Moroccan Hammam Set") but chat orders arrive
-- in Arabic ("باكدج حمام مغربي بلدي وي ورد"), so nothing can be matched by string
-- comparison. This table is the bridge: the Chat Orders paste box matches each
-- product line against these aliases, and every line the owner resolves by hand
-- in the review step is written back here - so the same phrasing matches itself
-- next time. It starts empty and fills up over the first days of use.
--
-- alias_norm is the matching key: the alias put through normalizeArabic() in
-- src/lib/chat-orders/whatsapp.ts (Arabic-Indic digits folded to ASCII, diacritics
-- and tatweel stripped, أإآ→ا ى→ي ة→ه, punctuation collapsed). It is UNIQUE, so a
-- phrase can only ever point at one product - re-teaching it repoints it rather
-- than creating a rival row. alias_text keeps the original spelling for display.
create table if not exists product_aliases (
  id bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  alias_norm text not null unique,
  alias_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists product_aliases_product_idx on product_aliases (product_id);

notify pgrst, 'reload schema';

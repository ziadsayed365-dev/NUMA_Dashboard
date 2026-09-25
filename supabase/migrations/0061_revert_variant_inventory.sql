-- Reverts the per-variant inventory work (0058, 0059).
--
-- Inventory counts stock per WHOLE PRODUCT, not per variant: a sold item takes
-- its product's bill of materials off the shelf whichever variant it was. So the
-- two things that existed only to tell variants apart for stock purposes go
-- away again:
--
--   variant_bundle_items      (0058) - which member variant was in which box
--   chat_order_items.variant_id (0059) - which variant a chat sale was
--
-- Per-variant COSTING is untouched: variant_components and the margin engine
-- still price a 100ml differently from a 10ml. That is a separate question from
-- what physically left the warehouse.
--
-- Both objects were added today and carry no data worth keeping (the bundle
-- table was only ever written by a verification run, which cleaned up after
-- itself; the chat column was never populated).
drop table if exists variant_bundle_items;

alter table chat_order_items drop column if exists variant_id;

notify pgrst, 'reload schema';

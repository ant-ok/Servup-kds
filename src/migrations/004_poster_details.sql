-- Details learned from the Poster API typings.
ALTER TABLE products
  ADD COLUMN cooking_seconds integer,   -- Poster "cooking_time", the default norm
  ADD COLUMN description     text;      -- Poster "product_production_description"

ALTER TABLE transactions
  ADD COLUMN sent_count     integer,    -- "sendtokitchen" events seen in the check history
  ADD COLUMN released_sent  integer NOT NULL DEFAULT 0; -- sent_count at the last release to screens

-- Webhooks carry both the subdomain (`account`) and `account_number`;
-- the in-Poster ("manage") sign-in only returns the number.
ALTER TABLE accounts ADD COLUMN poster_account_number text UNIQUE;

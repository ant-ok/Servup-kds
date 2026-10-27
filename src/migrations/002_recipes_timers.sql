-- Recipes come from Poster tech cards (fetched on demand, cached);
-- the venue's own additions live in product_info so a catalog sync never overwrites them.
ALTER TABLE products
  ADD COLUMN recipe            jsonb,        -- [{ name, netto, unit }]
  ADD COLUMN recipe_fetched_at timestamptz,
  ADD COLUMN photo             text;

CREATE TABLE product_info (
  account_id        integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  poster_product_id integer NOT NULL,
  norm_seconds      integer CHECK (norm_seconds > 0), -- target time from "taken" to "ready"
  recipe_note       text,                             -- how to make / serve, written by the venue
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, poster_product_id)
);

-- Screens and Poster registers connect with a short one-time code instead of
-- a long link. A register (kind 'pos') is a device too: same token, same rights.
ALTER TABLE devices
  ADD COLUMN kind             text NOT NULL DEFAULT 'screen' CHECK (kind IN ('screen', 'pos')),
  ADD COLUMN pair_code        text,
  ADD COLUMN pair_exp         timestamptz,
  ADD COLUMN poster_tablet_id integer;
CREATE UNIQUE INDEX devices_pair_code ON devices (pair_code) WHERE pair_code IS NOT NULL;

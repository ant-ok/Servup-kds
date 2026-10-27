-- One installation serves many venues. Every row belongs to an account;
-- Poster ids are only unique inside one Poster account.

CREATE TABLE accounts (
  id             serial PRIMARY KEY,
  name           text NOT NULL,
  poster_account text UNIQUE,             -- Poster subdomain, sent in every webhook
  poster_token   text,
  admin_password text,                    -- scrypt hash; optional when signing in through Poster
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  account_id integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);

-- A station is one production point: bar, hot kitchen, cold kitchen, pastry...
-- kind 'expo' is the pass where finished orders are handed to waiters.
CREATE TABLE stations (
  id           serial PRIMARY KEY,
  account_id   integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'prep' CHECK (kind IN ('prep', 'expo')),
  workshop_ids integer[] NOT NULL DEFAULT '{}', -- empty on a prep station = every workshop no other station claims
  group_items  boolean NOT NULL DEFAULT false,  -- show "Бургер ×4" as one row (kitchens)
  sort         integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true
);
CREATE INDEX stations_account ON stations (account_id);

CREATE TABLE employees (
  id             serial PRIMARY KEY,
  account_id     integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  poster_user_id integer,
  name           text NOT NULL,
  role_name      text,
  pin_lookup     text,                    -- HMAC(APP_SECRET, account:pin): PIN alone identifies the person
  kds_access     boolean NOT NULL DEFAULT false, -- may sign in on KDS screens (cooks, bartenders, runners)
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, poster_user_id),
  UNIQUE (account_id, pin_lookup)
);

CREATE TABLE workshops (
  account_id         integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  poster_workshop_id integer NOT NULL,
  name               text NOT NULL,
  PRIMARY KEY (account_id, poster_workshop_id)
);

CREATE TABLE products (
  account_id        integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  poster_product_id integer NOT NULL,
  name              text NOT NULL,
  category_name     text,
  workshop_id       integer,
  modifications     jsonb NOT NULL DEFAULT '{}', -- modification_id -> name
  hidden            boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, poster_product_id)
);

-- Piece rate paid to whoever marks a unit ready. Snapshotted onto the unit at
-- that moment so later rate changes never rewrite past payroll.
CREATE TABLE product_rates (
  account_id        integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  poster_product_id integer NOT NULL,
  rate              numeric(12,2) NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, poster_product_id)
);

CREATE TABLE transactions (
  id              bigserial PRIMARY KEY,
  account_id      integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  poster_transaction_id bigint NOT NULL,
  status          smallint NOT NULL,      -- 1 open, 2 closed, 3 removed
  table_name      text,
  hall_name       text,
  waiter_poster_id integer,
  waiter_name     text,
  spot_id         integer,
  tablet_id       integer,                -- which cash register
  guests          integer,
  comment         text,
  opened_at       timestamptz,
  closed_at       timestamptz,
  sum_total       numeric(14,2),
  payed_sum       numeric(14,2),
  products_hash   text,
  raw             jsonb,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, poster_transaction_id)
);
CREATE INDEX transactions_closed_at ON transactions (account_id, closed_at);
CREATE INDEX transactions_open ON transactions (account_id) WHERE status = 1;

-- One ticket per arrival: the first order and every later addition ("дозаказ").
CREATE TABLE tickets (
  id             serial PRIMARY KEY,
  account_id     integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  transaction_id bigint NOT NULL REFERENCES transactions ON DELETE CASCADE,
  round          integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  served_at      timestamptz,             -- handed to the guest (expo screen)
  served_by      integer REFERENCES employees,
  UNIQUE (transaction_id, round)
);
CREATE INDEX tickets_open ON tickets (account_id, created_at) WHERE served_at IS NULL;

-- One row per portion. Three mojitos = three units, each can be made by a different person.
CREATE TABLE units (
  id              bigserial PRIMARY KEY,
  account_id      integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  ticket_id       integer NOT NULL REFERENCES tickets ON DELETE CASCADE,
  transaction_id  bigint NOT NULL REFERENCES transactions ON DELETE CASCADE,
  station_id      integer REFERENCES stations,
  item_key        text NOT NULL,          -- product_id:modification
  poster_product_id integer NOT NULL,
  name            text NOT NULL,
  modifiers       text,
  qty             numeric(12,3) NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','taken','ready','cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  taken_by        integer REFERENCES employees,
  taken_at        timestamptz,
  ready_by        integer REFERENCES employees,
  ready_at        timestamptz,
  rate            numeric(12,2),
  cancelled_at    timestamptz,
  cancel_reason   text,
  cancel_ack      boolean NOT NULL DEFAULT false, -- the station saw the cancellation
  made_then_removed boolean NOT NULL DEFAULT false
);
CREATE INDEX units_ticket ON units (ticket_id);
CREATE INDEX units_tx_key ON units (transaction_id, item_key);
CREATE INDEX units_open ON units (account_id, station_id) WHERE status IN ('new','taken');
CREATE INDEX units_ready ON units (account_id, ready_at) WHERE ready_by IS NOT NULL;

CREATE TABLE devices (
  id           serial PRIMARY KEY,
  account_id   integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  station_id   integer REFERENCES stations,   -- which station this screen shows
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE kds_sessions (
  token_hash  text PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees ON DELETE CASCADE,
  device_id   integer REFERENCES devices ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

-- Client-generated operation ids: a retried tap (bad Wi-Fi) is applied once.
CREATE TABLE applied_ops (
  op_id      text PRIMARY KEY,
  result     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  account_id     integer NOT NULL REFERENCES accounts ON DELETE CASCADE,
  at             timestamptz NOT NULL DEFAULT now(),
  actor          text NOT NULL,           -- employee / admin / poster / device
  employee_id    integer REFERENCES employees ON DELETE SET NULL,
  device_id      integer REFERENCES devices ON DELETE SET NULL,
  action         text NOT NULL,
  unit_id        bigint,
  transaction_id bigint,                  -- Poster check number
  details        jsonb
);
CREATE INDEX audit_log_at ON audit_log (account_id, at);
CREATE INDEX audit_log_unit ON audit_log (unit_id);

-- Raw Poster webhooks, kept to diagnose integration issues on a live account.
CREATE TABLE webhook_log (
  id          bigserial PRIMARY KEY,
  account_id  integer REFERENCES accounts ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL,
  verified    boolean NOT NULL,
  error       text
);
CREATE INDEX webhook_log_received ON webhook_log (account_id, received_at);

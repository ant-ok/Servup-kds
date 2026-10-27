CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('bar_workshop_ids', '[]'),          -- empty = every product goes to the KDS
  ('credit_made_then_removed', 'true'),-- pay for a drink that was made but later removed from the check
  ('warn_minutes', '5'),
  ('critical_minutes', '10'),
  ('ready_visible_seconds', '60'),
  ('day_start_hour', '6');            -- business day boundary for reports (bar works past midnight)

-- Everyone who appears in reports: waiters/cashiers synced from Poster and bartenders.
CREATE TABLE employees (
  id             serial PRIMARY KEY,
  poster_user_id integer UNIQUE,
  name           text NOT NULL,
  role_name      text,
  pin_lookup     text UNIQUE,            -- HMAC(APP_SECRET, pin): PIN alone identifies the person
  is_bartender   boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workshops (
  poster_workshop_id integer PRIMARY KEY,
  name               text NOT NULL
);

CREATE TABLE products (
  poster_product_id integer PRIMARY KEY,
  name              text NOT NULL,
  category_name     text,
  workshop_id       integer,
  modifications     jsonb NOT NULL DEFAULT '{}', -- modification_id -> name
  hidden            boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Piece rate paid to whoever marks a unit ready. Snapshotted onto the unit at
-- that moment so later rate changes never rewrite past payroll.
CREATE TABLE product_rates (
  poster_product_id integer PRIMARY KEY,
  rate              numeric(12,2) NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  poster_transaction_id bigint PRIMARY KEY,
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
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_closed_at ON transactions (closed_at);
CREATE INDEX transactions_waiter ON transactions (waiter_poster_id);

-- One ticket per arrival: the first order and every later addition ("дозаказ").
CREATE TABLE tickets (
  id             serial PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES transactions,
  round          integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  bumped_at      timestamptz,             -- removed from the board
  UNIQUE (transaction_id, round)
);
CREATE INDEX tickets_active ON tickets (bumped_at) WHERE bumped_at IS NULL;

-- One row per portion. Three mojitos = three units, each can be made by a different person.
CREATE TABLE units (
  id              bigserial PRIMARY KEY,
  ticket_id       integer NOT NULL REFERENCES tickets,
  transaction_id  bigint NOT NULL REFERENCES transactions,
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
  made_then_removed boolean NOT NULL DEFAULT false
);
CREATE INDEX units_ticket ON units (ticket_id);
CREATE INDEX units_tx_key ON units (transaction_id, item_key);
CREATE INDEX units_ready ON units (ready_at) WHERE ready_by IS NOT NULL;

CREATE TABLE devices (
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE kds_sessions (
  token_hash  text PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees,
  device_id   integer REFERENCES devices,
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
  at             timestamptz NOT NULL DEFAULT now(),
  actor          text NOT NULL,           -- employee / admin / poster / system
  employee_id    integer REFERENCES employees,
  device_id      integer REFERENCES devices,
  action         text NOT NULL,
  unit_id        bigint,
  transaction_id bigint,
  details        jsonb
);
CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_unit ON audit_log (unit_id);

-- Raw Poster webhooks, kept to diagnose integration issues on a live account.
CREATE TABLE webhook_log (
  id          bigserial PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL,
  verified    boolean NOT NULL,
  error       text
);
CREATE INDEX webhook_log_received ON webhook_log (received_at);

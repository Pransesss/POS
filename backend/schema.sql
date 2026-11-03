-- MMSU Auxiliary POS — PostgreSQL schema.  Run with:  python init_db.py   (it also loads the known data)
-- Safe to re-run: drops everything first.
DROP VIEW  IF EXISTS v_daily_inventory, v_daily_sales CASCADE;
DROP TABLE IF EXISTS sales_history, weather_daily, audit_log, predictions, model_runs, events, remittances, sales_batches, sales_day_closures, line_parts, transaction_lines,
                     transactions, daily_cash, stock_movements, delivery_items, deliveries, inventory,
                     products, meal_prices, settings, accounts, auxiliaries CASCADE;

-- setup
CREATE TABLE auxiliaries (
  aux_id     SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,                 -- COE, CAS ...
  name       TEXT NOT NULL,
  logo_path  TEXT,                                 -- file path only, e.g. uploads/logos/cas-1a2b.png
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  account_id           SERIAL PRIMARY KEY,
  aux_id               INTEGER REFERENCES auxiliaries(aux_id),   -- NULL for admin
  username             TEXT NOT NULL,
  password_hash        TEXT NOT NULL,                            -- never plain text
  role                 TEXT NOT NULL CHECK (role IN ('admin','staff')),
  logo_path            TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role = 'admin' AND aux_id IS NULL) OR (role = 'staff' AND aux_id IS NOT NULL))
);
CREATE UNIQUE INDEX accounts_username_uq ON accounts (lower(username));

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE meal_prices (                         -- the price list on the wall; the server computes every meal from this
  price_key TEXT PRIMARY KEY,                      -- beef, chicken, fish, pork, veg, rice, fried_rice, budget_beef ..., take_out_box
  label     TEXT NOT NULL,
  amount    NUMERIC(10,2) NOT NULL
);

CREATE TABLE products (
  product_id         SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  barcode            TEXT UNIQUE,                  -- blank = no barcode
  category           TEXT NOT NULL,                -- Snacks | Drinks | Meals (Meals = the 6 meal servings)
  meal_key           TEXT UNIQUE,                  -- rice, pork, beef, chicken, fish, veg (only for the meal servings)
  price              NUMERIC(10,2) NOT NULL DEFAULT 0,
  low_stock_level    INTEGER NOT NULL DEFAULT 15,
  use_for_prediction BOOLEAN NOT NULL DEFAULT FALSE,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE inventory (                           -- current stock of one product at one auxiliary
  aux_id      INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
  product_id  INTEGER NOT NULL REFERENCES products(product_id),
  qty_on_hand NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (aux_id, product_id)
);

-- deliveries (admin sends, staff counts and accepts)
CREATE TABLE deliveries (                           -- pending deliveries can be cancelled; accepted deliveries remain auditable
  delivery_id   SERIAL PRIMARY KEY,
  aux_id        INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
  delivery_date DATE NOT NULL,
  initial_cash  NUMERIC(10,2) NOT NULL DEFAULT 0,  -- listed by admin
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled')),
  created_by    INTEGER REFERENCES accounts(account_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_by   INTEGER REFERENCES accounts(account_id),
  accepted_at   TIMESTAMPTZ,
  cash_counted  NUMERIC(10,2),
  has_mismatch  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE delivery_items (
  delivery_id INTEGER NOT NULL REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(product_id),
  listed_qty  NUMERIC(10,2) NOT NULL,
  counted_qty NUMERIC(10,2),
  PRIMARY KEY (delivery_id, product_id)
);

-- every change of stock is one row here (this is what the paper slip adds up)
CREATE TABLE stock_movements (
  movement_id   BIGSERIAL PRIMARY KEY,
  aux_id        INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
  product_id    INTEGER NOT NULL REFERENCES products(product_id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('delivery','sale','adjustment','spoilage')),
  qty           NUMERIC(10,2) NOT NULL,            -- + in, - out
  business_date DATE NOT NULL,
  delivery_id   INTEGER REFERENCES deliveries(delivery_id),
  transaction_id UUID,
  created_by    INTEGER REFERENCES accounts(account_id),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_mov_idx ON stock_movements (aux_id, product_id, business_date);

CREATE TABLE daily_cash (                          -- initial cash per outlet per business day (set when delivery is accepted)
  aux_id        INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
  business_date DATE NOT NULL,
  initial_cash  NUMERIC(10,2) NOT NULL,
  delivery_id   INTEGER REFERENCES deliveries(delivery_id),
  PRIMARY KEY (aux_id, business_date)
);

-- sales
CREATE TABLE sales_batches (
  batch_id         SERIAL PRIMARY KEY,
  aux_id           INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
  business_date    DATE NOT NULL,
  batch_number     INTEGER NOT NULL,
  total_cash       NUMERIC(10,2) NOT NULL,
  total_ewallet    NUMERIC(10,2) NOT NULL,
  total_sales      NUMERIC(10,2) NOT NULL,
  transaction_count INTEGER NOT NULL,
  sealed_by        INTEGER NOT NULL REFERENCES accounts(account_id),
  sealed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (aux_id, business_date, batch_number)
);
CREATE INDEX sales_batches_aux_date_idx ON sales_batches (aux_id, business_date);

CREATE TABLE transactions (
  transaction_id    UUID PRIMARY KEY,              -- made on the device, so offline sales never clash
  receipt_no        TEXT NOT NULL,
  aux_id            INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
  cashier_id        INTEGER NOT NULL REFERENCES accounts(account_id),
  device_id         TEXT,
  batch_id          INTEGER REFERENCES sales_batches(batch_id),
  created_at        TIMESTAMPTZ NOT NULL,          -- time on the device (when the sale happened)
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),   -- time the server got it (sync time)
  business_date     DATE NOT NULL,                 -- actual calendar sales date in the MMSU timezone
  payment_method    TEXT NOT NULL CHECK (payment_method IN ('Cash','E-Wallet')),
  amount_tendered   NUMERIC(10,2),
  ewallet_ref_last4 TEXT,
  dine_type         TEXT NOT NULL DEFAULT 'Dine-in' CHECK (dine_type IN ('Dine-in','Take-out')),
  total_amount      NUMERIC(10,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
  void_reason       TEXT,
  CHECK (payment_method <> 'E-Wallet' OR ewallet_ref_last4 ~ '^[0-9]{4}$')
);
CREATE INDEX tx_aux_date_idx ON transactions (aux_id, business_date);

CREATE TABLE transaction_lines (
  line_id        BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE,
  item_name      TEXT NOT NULL,                    -- e.g. Budget Meal (Rice, Beef & Vegetable)
  section        TEXT NOT NULL CHECK (section IN ('Meals','Snacks')),
  kind           TEXT,                             -- Budget meal, Double meat, Double rice, Meat only, Add-on ...
  product_id     INTEGER REFERENCES products(product_id),   -- snacks / drinks only
  meat           TEXT, meat_qty NUMERIC(4,1), veg_qty NUMERIC(4,1), rice_type TEXT, rice_qty NUMERIC(4,1),
  is_budget      BOOLEAN NOT NULL DEFAULT FALSE,
  unit_price     NUMERIC(10,2) NOT NULL,
  qty            INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX tl_tx_idx ON transaction_lines (transaction_id);

CREATE TABLE line_parts (                          -- which servings a line used (a meal = rice + meat + veggy)
  part_id    BIGSERIAL PRIMARY KEY,
  line_id    BIGINT NOT NULL REFERENCES transaction_lines(line_id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(product_id),
  servings   NUMERIC(6,2) NOT NULL
);

CREATE TABLE remittances (
  remittance_id   SERIAL PRIMARY KEY,
  aux_id          INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
  business_date   DATE NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,
  expected_amount NUMERIC(10,2),
  batch_id        INTEGER REFERENCES sales_batches(batch_id),
  recorded_by     INTEGER REFERENCES accounts(account_id),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX remittances_batch_uq ON remittances (batch_id) WHERE batch_id IS NOT NULL;

-- prediction
CREATE TABLE events (
  event_id   SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('no_classes','exam','event','other')),
  event_date DATE NOT NULL,
  notes      TEXT,
  created_by INTEGER REFERENCES accounts(account_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE model_runs (                          -- one row each time the model is trained (LSTM, ARIMA, moving average ...)
  model_run_id SERIAL PRIMARY KEY,
  aux_id       INTEGER REFERENCES auxiliaries(aux_id),      -- NULL = one model for all outlets
  algorithm    TEXT NOT NULL,
  version      TEXT NOT NULL,
  trained_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  train_from   DATE, train_to DATE,
  horizon_days INTEGER, epochs INTEGER, window_days INTEGER,
  rmse NUMERIC(10,3), mae NUMERIC(10,3), mape NUMERIC(10,3),
  is_active    BOOLEAN NOT NULL DEFAULT FALSE,              -- the dashboard shows predictions of the ACTIVE run
  notes        TEXT
);
CREATE TABLE predictions (                         -- THE MODEL WRITES HERE, the dashboard reads from here
  prediction_id SERIAL PRIMARY KEY,
  model_run_id  INTEGER NOT NULL REFERENCES model_runs(model_run_id),
  aux_id        INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
  product_id    INTEGER NOT NULL REFERENCES products(product_id),
  target_date   DATE NOT NULL,
  predicted_qty NUMERIC(10,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_run_id, aux_id, product_id, target_date)
);

CREATE TABLE audit_log (
  log_id     BIGSERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(account_id),
  action     TEXT NOT NULL,
  details    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- views for reports and for the model notebook
CREATE VIEW v_daily_sales AS                       -- units sold per outlet / product / business day  (model training data)
SELECT m.aux_id, m.product_id, m.business_date, -SUM(m.qty) AS qty_sold
FROM stock_movements m WHERE m.movement_type = 'sale'
GROUP BY m.aux_id, m.product_id, m.business_date;

CREATE VIEW v_daily_inventory AS                   -- same columns as the paper slip
WITH d AS (
  SELECT aux_id, product_id, business_date,
         COALESCE(SUM(qty) FILTER (WHERE movement_type = 'delivery'), 0)  AS rcvd,
         COALESCE(-SUM(qty) FILTER (WHERE movement_type = 'sale'), 0)     AS sold,
         COALESCE(SUM(qty) FILTER (WHERE movement_type IN ('adjustment','spoilage')), 0) AS adj,
         SUM(qty) AS net
  FROM stock_movements GROUP BY aux_id, product_id, business_date)
SELECT aux_id, product_id, business_date,
       COALESCE(SUM(net) OVER w_before, 0) AS beginning_qty, rcvd AS received_qty, sold AS sold_qty, adj AS adjusted_qty,
       SUM(net) OVER w_upto AS left_qty
FROM d
WINDOW w_before AS (PARTITION BY aux_id, product_id ORDER BY business_date ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
       w_upto   AS (PARTITION BY aux_id, product_id ORDER BY business_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW);

-- predictions (LSTM)
CREATE TABLE sales_history (                       -- past daily sales typed from the paper slips (CSV), one row per item per day it was on the menu
  history_id    SERIAL PRIMARY KEY,
  aux_id        INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
  category      TEXT NOT NULL CHECK (category IN ('snacks','meals')),
  item_name     TEXT NOT NULL,
  business_date DATE NOT NULL,
  prepared_qty  NUMERIC(10,2),
  sold_qty      NUMERIC(10,2) NOT NULL,
  left_qty      NUMERIC(10,2),
  unit_price    NUMERIC(10,2),
  UNIQUE (aux_id, category, item_name, business_date)
);
CREATE INDEX sales_history_idx ON sales_history (aux_id, category, business_date);

CREATE TABLE weather_daily (                       -- Open-Meteo values already fetched (cache), so the model never asks twice
  weather_date DATE PRIMARY KEY,
  temperature_2m_max NUMERIC(5,2), temperature_2m_min NUMERIC(5,2), precipitation_sum NUMERIC(6,2),
  weather_code INTEGER, is_rainy SMALLINT, is_hot SMALLINT,
  source TEXT NOT NULL DEFAULT 'archive',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

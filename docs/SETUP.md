# MMSU Auxiliary POS — setup, step by step

## What talks to what
```
Browser (staff POS / admin)            Flask API (backend/app.py)            PostgreSQL
 ├─ pages: HTML + CSS (unchanged)  ───▶  /api/...   (JSON)            ───▶   tables in schema.sql
 ├─ js/api.js     (one place that calls the API)
 └─ js/offline.js (IndexedDB: sales wait here when there is no internet, then sync)
```
* The browser **never** talks to PostgreSQL. Only `backend/app.py` does (through `backend/db.py`).
* Flask also serves the frontend files, so you open **one** address: http://localhost:5000
* Prices of meals are decided by the **server** (`backend/pricing.py`, from the `meal_prices` table). The browser only shows a preview.

## 1. Install (once)
1. **Python 3.10+**  (python.org). Tick "Add to PATH".
2. **PostgreSQL 14+**  (postgresql.org). Remember the password you give to the `postgres` user. pgAdmin is optional.

## 2. Create the database (once)
Open **SQL Shell (psql)** or pgAdmin's Query Tool, log in as `postgres`, run:
```sql
CREATE USER mmsu WITH PASSWORD 'mmsu123';
CREATE DATABASE mmsu OWNER mmsu;
```

## 3. Set up the backend (once)
```bash
cd backend
python -m venv venv
venv\Scripts\activate            # Windows        (Mac/Linux:  source venv/bin/activate)
pip install -r requirements.txt
copy .env.example .env           # Mac/Linux:  cp .env.example .env
```
Open `.env` and check `DATABASE_URL` (user, password, database name) and set a long random `SECRET_KEY`.

## 4. Create the tables + load what we already know
```bash
python init_db.py --demo
```
This runs `schema.sql` (all tables) and inserts: the meal price list, the 6 meal servings, snacks, the drinks list, chips/cake, the
auxiliaries **COE** and **CAS**, and the accounts below. `--demo` also adds a *pending delivery for today* so you can try Receiving + POS at once.
Running it again **wipes and rebuilds** the database.

| Account | Password | Role |
|---|---|---|
| admin | admin123 | Admin (all outlets) |
| coe | coe123 | Staff, College of Engineering |
| cas | cas123 | Staff, College of Arts and Sciences |

**Change these passwords** (Admin → Settings). Passwords are stored hashed, never as plain text.

Optional, for charts and predictions to have something to show: `python demo_sales.py` (14 days of made-up sales).

## 5. Run
```bash
python app.py
```
Open **http://localhost:5000** and sign in. (Opening the HTML files directly with double-click does not work any more: the pages need the API.)

## 6. Daily flow
1. **Admin → Deliveries**: choose an auxiliary, enter initial cash + quantities, *Send*.
2. **Staff → Receiving**: count what arrived, *Accept* → stock goes up, initial cash is recorded. A difference is saved as "mismatch".
3. **Staff → POS**: sell. **Staff → Transactions → Record remittance** at 2:00 PM.
4. **Admin**: dashboard (all or one outlet), inventory, events, report slips (Print / Excel), settings.

## 7. Offline mode — how it works and how to test it
1. Open the POS **online once** → the products, prices and stock are copied into the browser (IndexedDB).
2. Every COMPLETE SALE is saved in the browser **first** (`outbox`), with a UUID made on the device. The receipt prints at once.
3. When the internet is back (the `online` event, every 30 s, or when any staff page opens) the outbox is sent to `POST /api/sync/transactions`.
   The server skips a sale it already has (same UUID), so a retry can never double-count. Rejected sales stay in the outbox ("need attention").
4. **Test:** Chrome → F12 → Network → *Offline*. Make a sale (badge: "Offline · 1 waiting to sync"). Switch back to *No throttling* → the badge returns to "Online" and the sale appears in Transactions.

Notes: the dashboard, inventory, transactions, receiving pages need the server (they show a message when offline); the POS does not.
The service worker (`sw.js`, opens pages without internet) only works on `localhost` or **HTTPS**. For real use on the shop computers, put the app behind HTTPS.

## 8. Business rules (already built)
* **Cut-off:** a sale made at/after `cutoff_time` (settings table, 13:45) is counted on the next business day. The server computes it from the sale time (Asia/Manila).
  The Transactions page shows these under "Carried over". The POS "Prototype clock" box lets you test it: type a time after 1:45 PM.
* **Budget meal:** plain rice + 1 meat + veggy uses the fixed budget price. Everything else = sum of the servings.
* **Take-out:** +₱5 per meal line (the `take_out_box` price).
* **E-wallet:** the last 4 digits are required, saved on the transaction, and a repeated number on the same day is flagged.
* **Stock** goes down by servings (a meal = rice + meat + veggy servings). Fried rice uses the rice servings.

## 9. Connecting the prediction model (no frontend/backend change needed)
The dashboard reads the table `predictions` (rows of the **active** `model_runs`). If there are none it shows a 7-day moving average.
1. Training data: `SELECT * FROM v_daily_sales;` (units sold per outlet/product/business day) + the `events` table. Load it into pandas.
2. After training, write the result:
```sql
UPDATE model_runs SET is_active = FALSE;
INSERT INTO model_runs (algorithm, version, is_active, rmse, mae, mape) VALUES ('LSTM','lstm_v1',TRUE, 12.3, 9.8, 8.4) RETURNING model_run_id;
INSERT INTO predictions (model_run_id, aux_id, product_id, target_date, predicted_qty) VALUES (…);
```
`backend/run_prediction.py` is a working example of exactly this (it writes a moving average). Replace its `predict()` with the LSTM, and run it every evening.
`v_daily_inventory` gives the same columns as the paper slip (beginning, received, sold, left).

## 9b. Prediction page for staff and admins (LSTM, pick a canteen, date and items)

Staff open **Prediction** in the sidebar. Admins first choose an auxiliary. Select a Monday-Friday date, Snacks or Meals, tick the items to include,
and press **Predict**. The result is the notebook's Section 7 table (item, prediction_for, predicted_qty,
last_3school_day_avg, exam_day, event_day, method) and can be downloaded as CSV.

One-time setup (use Python 3.10-3.12, TensorFlow has no wheel for 3.13):

```
cd backend
pip install -r requirements.txt
python init_db.py                      # or, on an existing database, skip: the new tables are created automatically
python import_history.py --aux CAS --snacks Snacks_SY2025-26.csv --meals Meals_SY2025-26.csv --calendar calendar.csv
python train_model.py --aux CAS        # a few minutes; saves backend/models/CAS/
python app.py
```

* Do the same for COE with its own CSVs (`--aux COE`). Each canteen has its own model and history.
* Staff only see their own canteen. Admins can choose any active canteen. The model does not guess the menu; select the items.
* Exam/event flags come from the **Events** page (and calendar.csv). Add the date there before making a prediction.
* Weather comes from Open-Meteo (internet needed). If it is unreachable the page says so and uses the recent average.
* New sales entered in the POS are used automatically (products ticked *use for prediction*), but the network itself
  only learns new patterns when you run `train_model.py` again (every few weeks).
* An item with too few records (or a new item) gets a plain average and the Method column says so.
* Meal names in the history are Rice, Pork, Veggies, Chicken @99. POS meal servings are matched through `MEAL_ALIASES`
  in `prediction_engine.py`; change it if your names differ.

## 10. Things to confirm / change
* **Snack prices** (banana cue, turon, kwek-kwek, kamote cue, puto, cheese stick) were **not** in the two price-list photos → sample prices. Fix in Admin → Inventory → Edit (one price for all outlets).
* **Barcodes** of drinks, chips and cake are unknown → drinks have none (found by searching the name), chips/cake have placeholders. Add the real ones in Edit. A product *without* a barcode and in category Snacks becomes a quick tile in the POS.
* The drinks photo shows "Cloud 9 Chocolate Drinks 180ml" twice (₱23 and ₱33). The second is saved as "(second listing)". Check the real price list.
* **Meal prices** come from `meal_prices`; to change one: `UPDATE meal_prices SET amount = 62 WHERE price_key = 'chicken';`
* **Negative stock:** if a sale syncs for something the server thinks is out, the sale is still recorded (it already happened) and stock shows negative/out, so the admin can investigate.
* Admin password is required for every account change; 5 wrong passwords lock an account for 15 minutes.

## 11. Folders
```
backend/   app.py (API)  db.py  pricing.py  prediction.py  run_prediction.py  schema.sql  init_db.py  demo_sales.py  requirements.txt
mmsu-frontend/   pages (unchanged HTML/CSS)  js/ (common, api, offline, pos, dashboard, inventory, receiving, deliveries, transactions, events, settings, login)  sw.js
docs/SETUP.md
```

## Troubleshooting
* `connection refused` → PostgreSQL is not running, or the port/password in `.env` is wrong.
* `password authentication failed` → fix `DATABASE_URL` in `.env`.
* Page says "Please sign in again" → the token expired (30 days) or the database was re-created: sign in again.
* POS says "Connect to the internet once to download the products and prices" → open the POS online one time first.

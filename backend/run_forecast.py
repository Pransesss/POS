"""WHERE THE MODEL PLUGS IN.

The model (notebook / LSTM) only has to do 3 things:
  1. read the training data           ->  SELECT * FROM v_daily_sales   (+ the events table)
  2. register the training run        ->  INSERT INTO model_runs (...)   with is_active = TRUE
  3. write tomorrow's numbers         ->  INSERT INTO predictions (...)
The dashboard then shows them automatically (see forecast.py). Nothing else in the system changes.

This file is a working example that writes a simple moving average. Replace `predict()` with the real model.

    python run_forecast.py            # predicts tomorrow for every auxiliary
"""
from datetime import date, timedelta
from db import connect


def training_data(cur):
    """One row per outlet / product / day: units sold. Load this into pandas for the model."""
    cur.execute("SELECT aux_id, product_id, business_date, qty_sold FROM v_daily_sales ORDER BY business_date")
    return cur.fetchall()


def predict(history, product_id, aux_id, target_date):
    """REPLACE ME with the LSTM. history = list of rows from training_data(). Return units for target_date."""
    last = [float(r["qty_sold"]) for r in history if r["product_id"] == product_id and r["aux_id"] == aux_id][-7:]
    return sum(last) / len(last) if last else 0.0


def main():
    conn = connect()
    cur = conn.cursor()
    target = date.today() + timedelta(days=1)
    history = training_data(cur)
    cur.execute("UPDATE model_runs SET is_active = FALSE")
    cur.execute("INSERT INTO model_runs (algorithm, version, is_active, notes) VALUES ('MovingAverage','moving_avg_7d',TRUE,'example') RETURNING model_run_id")
    run_id = cur.fetchone()["model_run_id"]
    cur.execute("""SELECT i.aux_id, p.product_id FROM inventory i JOIN products p USING (product_id)
                   WHERE p.use_for_prediction AND p.is_active AND i.is_active""")
    for r in cur.fetchall():
        qty = predict(history, r["product_id"], r["aux_id"], target)
        cur.execute("""INSERT INTO predictions (model_run_id, aux_id, product_id, target_date, predicted_qty)
                       VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""", (run_id, r["aux_id"], r["product_id"], target, round(qty, 2)))
    conn.commit()
    print("predictions written for", target)


if __name__ == "__main__":
    main()

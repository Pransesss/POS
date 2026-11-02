"""Forecast for the dashboard.

1. If the trained model has written rows into `predictions` for tomorrow (and its model_run is_active), we show those.
2. Otherwise we show a simple baseline (7-day moving average) so the dashboard is never empty.
   -> To plug in the real model, see run_forecast.py. The dashboard code does not change.
"""
from datetime import timedelta


def get_forecast(cur, aux_ids, as_of):
    target = as_of + timedelta(days=1)

    # last actual sold on the selected date + average of the last 7 days  (all products used for prediction)
    cur.execute("""
        SELECT p.product_id, p.name, p.category, p.meal_key,
               COALESCE(SUM(-m.qty) FILTER (WHERE m.business_date = %(d)s), 0) AS last_sold,
               COALESCE(SUM(-m.qty) FILTER (WHERE m.business_date BETWEEN %(d)s - 6 AND %(d)s), 0) AS sold7,
               COUNT(DISTINCT m.business_date) FILTER (WHERE m.business_date BETWEEN %(d)s - 6 AND %(d)s) AS days_with_sales
        FROM products p
        JOIN inventory i ON i.product_id = p.product_id AND i.aux_id = ANY(%(aux)s) AND i.is_active
        LEFT JOIN stock_movements m ON m.product_id = p.product_id AND m.aux_id = i.aux_id AND m.movement_type = 'sale'
        WHERE p.is_active AND p.use_for_prediction
        GROUP BY p.product_id
    """, {"d": as_of, "aux": aux_ids})
    base = {r["product_id"]: r for r in cur.fetchall()}

    # event tomorrow?
    cur.execute("SELECT name, event_type FROM events WHERE event_date = %s ORDER BY event_id LIMIT 1", (target,))
    event = cur.fetchone()
    no_classes = bool(event and event["event_type"] == "no_classes")

    # rows written by the model
    cur.execute("""
        SELECT pr.product_id, SUM(pr.predicted_qty) AS qty, MAX(mr.version) AS version
        FROM predictions pr JOIN model_runs mr ON mr.model_run_id = pr.model_run_id AND mr.is_active
        WHERE pr.aux_id = ANY(%s) AND pr.target_date = %s GROUP BY pr.product_id
    """, (aux_ids, target))
    from_model = {r["product_id"]: r for r in cur.fetchall()}

    items, version = [], "moving_avg_7d"
    for pid, r in base.items():
        if pid in from_model:
            predicted, version = float(from_model[pid]["qty"]), from_model[pid]["version"]
        else:
            n = r["days_with_sales"] or 0
            predicted = float(r["sold7"]) / n if n else 0.0     # average over the days that had sales
        if no_classes:
            predicted = 0.0
        if float(r["last_sold"]) == 0 and predicted == 0:
            continue
        cat = "meal" if r["category"] == "Meals" else ("drink" if r["category"] == "Drinks" else "snack")
        items.append({"name": r["name"], "category": cat, "last_sold": float(r["last_sold"]), "predicted": round(predicted)})
    items.sort(key=lambda x: (-x["last_sold"], x["name"]))
    return {"as_of": as_of, "target_date": target, "model_version": version,
            "total_predicted": sum(i["predicted"] for i in items), "items": items,
            "event": dict(event) if event else None}

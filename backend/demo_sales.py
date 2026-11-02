"""OPTIONAL: fills the database with 14 days of made-up sales so the dashboards, charts and the forecast have something to show.
Run it AFTER init_db.py:      python demo_sales.py
It goes through the same code as a real sale (prices recomputed, stock lowered, business day computed)."""
import random, uuid
from datetime import datetime, timedelta
from app import app, TZ

random.seed(7)
c = app.test_client()


def call(method, url, token=None, **kw):
    r = getattr(c, method)(url, headers={"Authorization": f"Bearer {token}"} if token else {}, **kw)
    return r.get_json()


admin = call("post", "/api/auth/login", json={"username": "admin", "password": "admin123"})["token"]
for username, password in (("coe", "coe123"), ("cas", "cas123")):
    login = call("post", "/api/auth/login", json={"username": username, "password": password})
    token, aux = login["token"], login["user"]["aux_id"]
    # plenty of stock: an admin delivery that the staff accepts
    boot = call("get", "/api/pos/bootstrap", token)
    meals = {k: 600 for k in ("rice", "pork", "beef", "chicken", "fish", "veg")}
    items = [{"product_id": p["product_id"], "qty": 300} for p in boot["products"]]
    call("post", "/api/deliveries", admin, json={"aux_id": aux, "initial_cash": 2000, "meals": meals, "items": items})
    for d in call("get", "/api/deliveries/pending", token):
        call("post", f"/api/deliveries/{d['delivery_id']}/accept", token, json={"cash_counted": 2000})
    snacks = [p for p in boot["products"] if not p["barcode"] and p["category"] == "Snacks"]
    others = [p for p in boot["products"] if p["barcode"] or p["category"] == "Drinks"]
    for back in range(14, 0, -1):
        day = datetime.now(TZ) - timedelta(days=back)
        if day.weekday() == 6:
            continue                                                    # closed on Sundays
        batch = []
        for _ in range(random.randint(25, 45)):
            lines = []
            if random.random() < 0.6:
                meat = random.choice(["beef", "chicken", "fish", "pork", None])
                lines.append({"type": "meal", "meat": meat, "meat_qty": random.choice([1, 1, 1, 2]), "veg_qty": 1 if (random.random() < .5 or not meat) else 0,
                              "rice_type": random.choice(["plain"] * 4 + ["fried"]), "rice_qty": random.choice([1, 1, 1, 2, 0.5]), "qty": 1})
            if not lines or random.random() < 0.4:
                lines.append({"type": "product", "product_id": random.choice(snacks if random.random() < .8 else others)["product_id"], "qty": random.randint(1, 3)})
            ew = random.random() < 0.25
            batch.append({"id": str(uuid.uuid4()), "receipt_no": f"DEMO-{random.randint(1000, 9999)}", "lines": lines, "dine": random.choice(["in", "in", "out"]),
                          "created_at": day.replace(hour=random.randint(8, 15), minute=random.randint(0, 59)).isoformat(),
                          "payment_method": "E-Wallet" if ew else "Cash", "amount_tendered": None if ew else 1000, "ewallet_ref4": f"{random.randint(0, 9999):04d}" if ew else None})
        call("post", "/api/sync/transactions", token, json={"device_id": "demo", "transactions": batch})
print("demo sales added for the last 14 days (COE and CAS).")

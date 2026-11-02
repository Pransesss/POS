"""Create all tables and load the data we already know.

    python init_db.py          # tables + known data (menu, products, accounts, auxiliaries)
    python init_db.py --demo   # ALSO adds a pending delivery for today so you can try Receiving + POS

Running it again wipes the database and starts fresh.
"""
import sys
from datetime import date
from pathlib import Path
from werkzeug.security import generate_password_hash
from db import connect

# ------------------------------------------------------------------ known data
SETTINGS = {
    "remit_time": "14:00",
    "open_time": "08:00",
    "close_time": "16:00",
}

# MMSU Food Service price list (photo 1). Meals are computed from these on the SERVER.
MEAL_PRICES = [
    ("beef", "Beef (per serving)", 60), ("chicken", "Chicken (per serving)", 50),
    ("fish", "Fish (per serving)", 50), ("pork", "Pork (per serving)", 45),
    ("veg", "Vegetable (per serving)", 25), ("fried_rice", "Fried rice (per serving)", 15),
    ("rice", "Rice (per serving)", 12),
    ("budget_beef", "Budget meal (Rice, Beef & Vegetable)", 90),
    ("budget_chicken", "Budget meal (Rice, Chicken & Vegetable)", 60),
    ("budget_fish", "Budget meal (Rice, Fish & Vegetable)", 60),
    ("budget_pork", "Budget meal (Rice, Pork & Vegetable)", 50),
    ("take_out_box", "Take-out box", 5),
]

# the six meal servings that stock is counted in (fried rice uses the 'rice' servings)
MEAL_PARTS = [("Rice", "rice"), ("Pork", "pork"), ("Beef", "beef"), ("Chicken", "chicken"), ("Fish", "fish"), ("Veggy", "veg")]

# Snacks: prices are NOT in the two photos -> sample prices, CONFIRM and edit them in Admin > Inventory
SNACKS = [("Banana cue", 12), ("Turon", 15), ("Kwek-kwek", 20), ("Kamote cue", 12), ("Puto", 5), ("Cheese stick", 10)]

# Drinks/Beverages price list (photo 2). Barcodes are unknown, add them in Admin > Inventory > Edit.
DRINKS = [
    ("PC - Gatorade 350ml", 37), ("PC - Tropicana Twister 480ml", 30), ("PC - Lipton Tea Lemon/Red 480ml", 29),
    ("PC - Pepsi/Seven-Up/Mirinda In Can", 25), ("PC - Mountain Dew/MD Ice In Can", 25), ("PC - Sting Energy Drink 300ml", 20),
    ("PC - Pepsi/Seven-Up/Mirinda 300ml", 20), ("PC - Mountain Dew/MD Ice 300ml", 20), ("PC - Premier Water 500ml", 15),
    ("C2 - Green Tea Assorted 1ltr", 63), ("C2 - B'lue Water Assorted 500ml", 43), ("C2 - Milk Tea Assorted 270ml", 38),
    ("C2 - Green Tea Assorted 350ml", 31), ("C2 - Green Tea Solo 220ml", 16),
    ("SIP Purified Water 1 liter", 22), ("SIP Purified Water 500ml", 11), ("Sip Purified Water 330ml", 8),
    ("Crystal Dew Mineral Water 1ltr", 22), ("Crystal Dew Mineral Water 500ml", 15), ("Crystal Dew Mineral Water 320ml", 10),
    ("DM Pineapple Juice Sweetened/Four Season", 37), ("DM Pineapple Juice Bone Smart/Heart Smart", 37),
    ("DM Fit N Right Assorted Flavor", 37), ("Cloud 9 Chocolate Drinks 180ml", 23), ("Vita Soy/Vita Milk", 26),
    ("NS - Purified Water 1ltr", 20), ("NS - Purified Water 500ml", 15), ("NS - Purified Water 350ml", 10),
    ("Coffee 3 in 1", 10), ("Milo Powder Sachet", 10), ("Cloud 9 Chocolate Drinks 180ml (second listing)", 33),
    ("Coca-Cola 1.5ltrs Assorted", 70), ("Coca-Cola Mismo Assorted", 20), ("Coca-Cola Sakto", 12),
    ("Coca-Cola Minute Maid Tetra Pack", 11), ("Coca-Cola Minute Maid 220ml", 14),
    ("Coca-Cola Real Leaf 480ml", 24), ("Coca-Cola Nestea 350ml", 23),
]
# Chips/cake that the canteen sells with a barcode (placeholder barcodes, replace with the real ones)
BARCODE_ITEMS = [("Cornick", "Snacks", 10, "4800000000011"), ("Chips", "Snacks", 20, "4800000000012"), ("Cake", "Snacks", 35, "4800000000013")]

AUXILIARIES = [("COE", "College of Engineering"), ("CAS", "College of Arts and Sciences")]
# first accounts  (CHANGE THESE PASSWORDS after the first login: Admin > Settings)
ACCOUNTS = [("admin", "admin123", "admin", None), ("coe", "coe123", "staff", "COE"), ("cas", "cas123", "staff", "CAS")]


def main(demo=False):
    conn = connect()
    cur = conn.cursor()
    cur.execute((Path(__file__).parent / "schema.sql").read_text(encoding="utf-8"))

    cur.executemany("INSERT INTO settings (key, value) VALUES (%s, %s)", SETTINGS.items())
    cur.executemany("INSERT INTO meal_prices (price_key, label, amount) VALUES (%s, %s, %s)", MEAL_PRICES)

    for name, key in MEAL_PARTS:
        cur.execute("INSERT INTO products (name, category, meal_key, price, low_stock_level) VALUES (%s,'Meals',%s,0,10)", (name, key))
    for name, price in SNACKS:
        cur.execute("INSERT INTO products (name, category, price) VALUES (%s,'Snacks',%s)", (name, price))
    for name, cat, price, bc in BARCODE_ITEMS:
        cur.execute("INSERT INTO products (name, category, price, barcode) VALUES (%s,%s,%s,%s)", (name, cat, price, bc))
    for name, price in DRINKS:
        cur.execute("INSERT INTO products (name, category, price) VALUES (%s,'Drinks',%s)", (name, price))

    codes = {}
    for code, name in AUXILIARIES:
        cur.execute("INSERT INTO auxiliaries (code, name) VALUES (%s,%s) RETURNING aux_id", (code, name))
        codes[code] = cur.fetchone()["aux_id"]
    for username, password, role, code in ACCOUNTS:
        cur.execute("INSERT INTO accounts (username, password_hash, role, aux_id) VALUES (%s,%s,%s,%s)",
                    (username, generate_password_hash(password), role, codes.get(code)))
    # every auxiliary gets a stock row (qty 0) for every product
    cur.execute("INSERT INTO inventory (aux_id, product_id) SELECT a.aux_id, p.product_id FROM auxiliaries a CROSS JOIN products p")

    if demo:  # a pending delivery for today so Receiving and the POS can be tried right away
        cur.execute("SELECT account_id FROM accounts WHERE role='admin'")
        admin_id = cur.fetchone()["account_id"]
        for code, aux_id in codes.items():
            cur.execute("INSERT INTO deliveries (aux_id, delivery_date, initial_cash, created_by) VALUES (%s,%s,2000,%s) RETURNING delivery_id",
                        (aux_id, date.today(), admin_id))
            did = cur.fetchone()["delivery_id"]
            cur.execute("""INSERT INTO delivery_items (delivery_id, product_id, listed_qty)
                           SELECT %s, product_id, CASE WHEN category='Meals' THEN 60 WHEN barcode IS NULL AND category='Snacks' THEN 40 ELSE 24 END
                           FROM products""", (did,))
    conn.commit()
    cur.execute("SELECT count(*) AS n FROM products")
    print("Database ready:", cur.fetchone()["n"], "products,", len(AUXILIARIES), "auxiliaries,", len(ACCOUNTS), "accounts.")
    conn.close()


if __name__ == "__main__":
    main(demo="--demo" in sys.argv)

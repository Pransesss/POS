"""MMSU Auxiliary POS — Flask API + serves the frontend.   Run:  python app.py   then open http://localhost:5000"""
import os, re, uuid, secrets
import shutil
import threading
from datetime import datetime, date, time, timedelta
from decimal import Decimal, InvalidOperation
from functools import wraps
from zoneinfo import ZoneInfo

from flask import Flask, g, jsonify, request, send_from_directory, redirect
from flask.json.provider import DefaultJSONProvider
from flask_cors import CORS
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from werkzeug.security import generate_password_hash, check_password_hash

import psycopg2
from flask import Response
from db import connect, TIMEZONE
from pricing import build_line, SaleError, D
import prediction as pred
import prediction_engine as pe
import auto_train

BASE = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.join(BASE, "..", "mmsu-frontend")
LEGACY_UPLOADS = os.path.join(BASE, "uploads")
UPLOADS = os.path.abspath(os.getenv("UPLOADS_DIR") or LEGACY_UPLOADS)
MAX_LOGO_SIZE = 2_000_000
TZ = ZoneInfo(TIMEZONE)
SECRET = os.getenv("SECRET_KEY", "dev-secret-change-me")
TOKEN_DAYS = 30            # long, so a cashier stays signed in while the internet is down


class Provider(DefaultJSONProvider):
    @staticmethod
    def default(o):
        if isinstance(o, Decimal):
            return float(o)
        if isinstance(o, (date, datetime)):
            return o.isoformat()          # 2026-10-16  (the default would be an HTTP-style date)
        return DefaultJSONProvider.default(o)


app = Flask(__name__, static_folder=None)
app.json = Provider(app)
CORS(app)


def migrate_legacy_uploads():
    if os.path.normcase(UPLOADS) == os.path.normcase(LEGACY_UPLOADS):
        return

    os.makedirs(UPLOADS, exist_ok=True)
    marker = os.path.join(UPLOADS, ".legacy-uploads-migrated")
    if os.path.isfile(marker) or not os.path.isdir(LEGACY_UPLOADS):
        return

    for root, _, filenames in os.walk(LEGACY_UPLOADS):
        relative = os.path.relpath(root, LEGACY_UPLOADS)
        destination = UPLOADS if relative == "." else os.path.join(UPLOADS, relative)
        os.makedirs(destination, exist_ok=True)
        for filename in filenames:
            source_file = os.path.join(root, filename)
            destination_file = os.path.join(destination, filename)
            if not os.path.exists(destination_file):
                shutil.copy2(source_file, destination_file)

    with open(marker, "w", encoding="utf-8") as migrated:
        migrated.write("Legacy uploads copied.\n")
    app.logger.info("Copied legacy uploads from %s to %s", LEGACY_UPLOADS, UPLOADS)


migrate_legacy_uploads()
ser = URLSafeTimedSerializer(SECRET)
pricing_ser = URLSafeTimedSerializer(SECRET, salt="pos-pricing-v1")
_account_logo_schema_ready = False
_account_logo_schema_lock = threading.Lock()
_delivery_status_schema_ready = False
_delivery_status_schema_lock = threading.Lock()


@app.before_request
def _start_auto_train():
    auto_train.start()          # retrain the prediction models every 14 days in the background (once per process)


# database helpers
def conn():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_):
    db = g.pop("db", None)
    if db:
        db.close()


def q(sql, params=None, one=False):
    cur = conn().cursor()
    cur.execute(sql, params or ())
    return (cur.fetchone() if one else cur.fetchall())


def run(sql, params=None):
    cur = conn().cursor()
    cur.execute(sql, params or ())
    return cur


def err(msg, code=400):
    return jsonify({"error": msg}), code


def settings():
    if "settings" not in g:
        g.settings = {r["key"]: r["value"] for r in q("SELECT key, value FROM settings")}
    return g.settings


def today():
    return datetime.now(TZ).date()


_logo_store_ready = False
_logo_store_lock = threading.Lock()
LOGO_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


def ensure_logo_store():
    """Logo images live IN the database (logo_files), so a redeploy / system update that wipes the
    uploads folder can no longer remove them. logo_path keeps its old shape: uploads/logos/<name>.
    The first time this runs it copies any logo still on disk into the database."""
    global _logo_store_ready
    if _logo_store_ready:
        return
    with _logo_store_lock:
        if _logo_store_ready:
            return
        run("""CREATE TABLE IF NOT EXISTS logo_files (
                 name       TEXT PRIMARY KEY,
                 mime       TEXT NOT NULL,
                 data       BYTEA NOT NULL,
                 created_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
        ensure_account_logo_schema()
        used = q("""SELECT logo_path FROM auxiliaries WHERE logo_path LIKE 'uploads/logos/%%'
                    UNION SELECT logo_path FROM accounts WHERE logo_path LIKE 'uploads/logos/%%'""")
        for r in used:
            name = os.path.basename(r["logo_path"])
            if not q("SELECT 1 FROM logo_files WHERE name=%s", (name,), one=True):
                _import_logo_from_disk(name)
        conn().commit()
        _logo_store_ready = True


def _import_logo_from_disk(name):
    mime = LOGO_MIME.get(os.path.splitext(name)[1].lower())
    path = os.path.join(UPLOADS, "logos", name)
    if not mime or not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        data = f.read()
    run("INSERT INTO logo_files (name, mime, data) VALUES (%s,%s,%s) ON CONFLICT (name) DO NOTHING",
        (name, mime, psycopg2.Binary(data)))
    return mime, data


def save_logo(name, ext, data):
    ensure_logo_store()
    run("INSERT INTO logo_files (name, mime, data) VALUES (%s,%s,%s) ON CONFLICT (name) DO UPDATE SET data=EXCLUDED.data, mime=EXCLUDED.mime",
        (name, LOGO_MIME[ext], psycopg2.Binary(data)))


def prune_logos():
    """drop stored logos that no auxiliary / account points to any more (call after a change is committed)"""
    run("""DELETE FROM logo_files f
           WHERE NOT EXISTS (SELECT 1 FROM auxiliaries x WHERE x.logo_path = 'uploads/logos/' || f.name)
             AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.logo_path = 'uploads/logos/' || f.name)""")
    conn().commit()


_sales_batch_schema_ready = False


MAX_CHANGE = 1000   # largest peso bill: a customer never hands over a whole extra ₱1,000 (stops typos like ₱9,000,000)


def ensure_sales_batch_schema():
    global _sales_batch_schema_ready
    if _sales_batch_schema_ready:
        return
    run("""CREATE TABLE IF NOT EXISTS sales_batches (
        batch_id SERIAL PRIMARY KEY,
        aux_id INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
        business_date DATE NOT NULL,
        batch_number INTEGER NOT NULL,
        total_cash NUMERIC(10,2) NOT NULL,
        total_ewallet NUMERIC(10,2) NOT NULL,
        total_sales NUMERIC(10,2) NOT NULL,
        transaction_count INTEGER NOT NULL,
        sealed_by INTEGER NOT NULL REFERENCES accounts(account_id),
        sealed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (aux_id, business_date, batch_number)
    )""")
    run("""ALTER TABLE transactions
           ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES sales_batches(batch_id)""")
    run("""ALTER TABLE remittances
           ADD COLUMN IF NOT EXISTS batch_id INTEGER REFERENCES sales_batches(batch_id)""")
    run("CREATE INDEX IF NOT EXISTS sales_batches_aux_date_idx ON sales_batches (aux_id, business_date)")
    run("""CREATE UNIQUE INDEX IF NOT EXISTS remittances_batch_uq
           ON remittances (batch_id) WHERE batch_id IS NOT NULL""")
    conn().commit()
    _sales_batch_schema_ready = True


def parse_day(s, default=None):
    try:
        return date.fromisoformat(s) if s else default
    except ValueError:
        return default


# auth
def current_user():
    ensure_account_logo_schema()
    h = request.headers.get("Authorization", "")
    if not h.startswith("Bearer "):
        return None
    try:
        uid = ser.loads(h[7:], max_age=TOKEN_DAYS * 86400)["uid"]
    except (BadSignature, SignatureExpired):
        return None
    return q("""SELECT a.account_id, a.username, a.role, a.aux_id, a.password_hash, x.code AS aux_code, x.name AS aux_name,
                       COALESCE(a.logo_path, x.logo_path) AS logo_path
                FROM accounts a LEFT JOIN auxiliaries x ON x.aux_id = a.aux_id
                WHERE a.account_id = %s AND a.is_active""", (uid,), one=True)


def ensure_account_logo_schema():
    global _account_logo_schema_ready
    if _account_logo_schema_ready:
        return
    with _account_logo_schema_lock:
        if _account_logo_schema_ready:
            return
        db = connect()
        try:
            with db.cursor() as cur:
                cur.execute("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS logo_path TEXT")
            db.commit()
        finally:
            db.close()
        _account_logo_schema_ready = True


def auth(role=None):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                return err("Please sign in again", 401)
            if role and u["role"] != role:
                return err("Not allowed", 403)
            g.user = u
            return fn(*a, **kw)
        return wrapper
    return deco


def public_user(u):
    return {"account_id": u["account_id"], "username": u["username"], "role": u["role"], "aux_id": u["aux_id"],
            "aux_code": u["aux_code"], "aux_name": u["aux_name"], "logo_path": u["logo_path"]}


def audit(action, details=""):
    run("INSERT INTO audit_log (account_id, action, details) VALUES (%s,%s,%s)", (g.user["account_id"] if "user" in g else None, action, details))


def scope(aux_param):
    """Which auxiliaries may this user look at?  staff = own only, admin = one or all."""
    u = g.user
    if u["role"] == "staff":
        return [u["aux_id"]]
    if aux_param in (None, "", "all"):
        return [r["aux_id"] for r in q("SELECT aux_id FROM auxiliaries WHERE is_active ORDER BY aux_id")]
    return [int(aux_param)]


@app.post("/api/auth/login")
def login():
    ensure_account_logo_schema()
    d = request.get_json(silent=True) or {}
    name, pw = (d.get("username") or "").strip().lower(), d.get("password") or ""
    a = q("""SELECT a.*, x.code AS aux_code, x.name AS aux_name,
                    COALESCE(a.logo_path, x.logo_path) AS logo_path FROM accounts a
             LEFT JOIN auxiliaries x ON x.aux_id = a.aux_id WHERE lower(a.username) = %s""", (name,), one=True)
    if not a or not a["is_active"]:
        return err("Incorrect username or password", 401)
    if a["locked_until"] and a["locked_until"] > datetime.now(TZ):
        return err("Account locked for 15 minutes after too many wrong passwords", 423)
    if not check_password_hash(a["password_hash"], pw):
        fails = a["failed_attempts"] + 1
        run("UPDATE accounts SET failed_attempts=%s, locked_until=%s WHERE account_id=%s",
            (0 if fails >= 5 else fails, datetime.now(TZ) + timedelta(minutes=15) if fails >= 5 else None, a["account_id"]))
        conn().commit()
        return err("Incorrect username or password", 401)
    run("UPDATE accounts SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE account_id=%s", (a["account_id"],))
    conn().commit()
    return jsonify({"token": ser.dumps({"uid": a["account_id"]}), "user": public_user(a), "must_change_password": a["must_change_password"]})


@app.get("/api/auth/me")
@auth()
def me():
    return jsonify(public_user(g.user))


@app.get("/api/settings")
@auth()
def get_settings():
    return jsonify({**settings(), "timezone": TIMEZONE, "server_time": datetime.now(TZ).isoformat()})


@app.get("/api/meal-prices")
@auth()
def meal_prices():
    return jsonify({r["price_key"]: r["amount"] for r in q("SELECT price_key, amount FROM meal_prices")})


# auxiliaries
@app.get("/api/auxiliaries")
@auth()
def list_aux():
    if g.user["role"] == "staff":
        rows = q("SELECT aux_id, code, name, logo_path, is_active FROM auxiliaries WHERE aux_id=%s", (g.user["aux_id"],))
    else:
        rows = q("SELECT aux_id, code, name, logo_path, is_active FROM auxiliaries ORDER BY aux_id")
    return jsonify(rows)


@app.post("/api/auxiliaries")
@auth("admin")
def add_aux():
    d = request.get_json(silent=True) or {}
    name, code = (d.get("name") or "").strip(), (d.get("code") or "").strip().upper()
    user, pw = (d.get("username") or "").strip().lower(), d.get("password") or ""
    if not name or not re.fullmatch(r"[A-Z0-9]{2,10}", code):
        return err("Enter a name and a short code (letters/numbers, 2-10 characters)")
    if not re.fullmatch(r"[a-z0-9._-]{3,30}", user) or len(pw) < 6:
        return err("Staff username (3+ characters) and password (6+ characters) are required")
    if q("SELECT 1 FROM auxiliaries WHERE code=%s", (code,), one=True):
        return err("That code is already used")
    if q("SELECT 1 FROM accounts WHERE lower(username)=%s", (user,), one=True):
        return err("That username is already used")
    aux_id = run("INSERT INTO auxiliaries (code, name) VALUES (%s,%s) RETURNING aux_id", (code, name)).fetchone()["aux_id"]
    run("INSERT INTO accounts (username, password_hash, role, aux_id) VALUES (%s,%s,'staff',%s)", (user, generate_password_hash(pw), aux_id))
    run("INSERT INTO inventory (aux_id, product_id) SELECT %s, product_id FROM products", (aux_id,))
    audit("aux_added", f"{code} {name}")
    conn().commit()
    return jsonify({"aux_id": aux_id}), 201


@app.post("/api/auxiliaries/<int:aux_id>/logo")
@auth("admin")
def upload_logo(aux_id):
    auxiliary = q("SELECT logo_path FROM auxiliaries WHERE aux_id=%s", (aux_id,), one=True)
    if not auxiliary:
        return err("Auxiliary not found", 404)
    staff_ids = q("SELECT account_id FROM accounts WHERE aux_id=%s AND role='staff'", (aux_id,))
    f = request.files.get("file")
    ext = {"image/png": ".png", "image/jpeg": ".jpg"}.get(f.mimetype if f else None)
    if not ext:
        return err("PNG or JPG only")
    data = f.read()
    if not data:
        return err("Logo file is empty")
    if len(data) > MAX_LOGO_SIZE:
        return err("File too large (max 2 MB)")
    if (ext == ".png" and not data.startswith(b"\x89PNG\r\n\x1a\n")) or (
        ext == ".jpg" and not data.startswith(b"\xff\xd8\xff")
    ):
        return err("The file contents do not match its image type")
    name = f"aux-{aux_id}-{secrets.token_hex(4)}{ext}"      # random name, never the original
    save_logo(name, ext, data)                              # stored in the database, not the uploads folder
    path = f"uploads/logos/{name}"
    run("UPDATE auxiliaries SET logo_path=%s WHERE aux_id=%s", (path, aux_id))
    audit("logo_changed", str(aux_id))
    conn().commit()
    prune_logos()
    _cleanup_aux_logo_files(aux_id, staff_ids, auxiliary["logo_path"], path)
    return jsonify({"logo_path": path})


def _remove_replaced_logo(previous_path, current_path):
    if not previous_path or previous_path == current_path:
        return
    normalized = os.path.normpath(previous_path).replace("\\", "/")
    if not normalized.startswith("uploads/logos/"):
        return
    filename = os.path.basename(normalized)
    if not filename:
        return
    old_file = os.path.join(UPLOADS, "logos", filename)
    try:
        os.remove(old_file)
    except FileNotFoundError:
        pass
    except OSError as exc:
        app.logger.warning("Could not remove replaced logo %s: %s", previous_path, exc)


def _cleanup_aux_logo_files(aux_id, staff_ids, previous_path, current_path):
    logo_dir = os.path.join(UPLOADS, "logos")
    current_name = os.path.basename(current_path)
    staff_prefixes = tuple(f"account-{staff['account_id']}-" for staff in staff_ids)
    filenames = set()
    if previous_path:
        normalized = os.path.normpath(previous_path).replace("\\", "/")
        if normalized.startswith("uploads/logos/"):
            filenames.add(os.path.basename(normalized))
    try:
        for name in os.listdir(logo_dir):
            legacy_id = name.split("-", 1)[0]
            is_legacy_aux_logo = legacy_id.isdigit() and int(legacy_id) == aux_id
            if is_legacy_aux_logo or name.startswith(f"aux-{aux_id}-") or name.startswith(staff_prefixes):
                filenames.add(name)
    except OSError as exc:
        app.logger.warning("Could not list auxiliary logo files for %s: %s", aux_id, exc)
    for filename in filenames:
        if filename == current_name:
            continue
        try:
            os.remove(os.path.join(logo_dir, filename))
        except FileNotFoundError:
            pass
        except OSError as exc:
            app.logger.warning("Could not remove replaced auxiliary logo %s: %s", filename, exc)


def _cleanup_account_logo_files(account_id, previous_path, current_path):
    logo_dir = os.path.join(UPLOADS, "logos")
    current_name = os.path.basename(current_path)
    prefix = f"account-{account_id}-"
    filenames = set()
    if previous_path:
        normalized = os.path.normpath(previous_path).replace("\\", "/")
        if normalized.startswith("uploads/logos/"):
            previous_name = os.path.basename(normalized)
            if previous_name.startswith(prefix):
                filenames.add(previous_name)
    try:
        filenames.update(name for name in os.listdir(logo_dir) if name.startswith(prefix))
    except OSError as exc:
        app.logger.warning("Could not list account logo files for %s: %s", account_id, exc)
    for filename in filenames:
        if filename == current_name:
            continue
        try:
            os.remove(os.path.join(logo_dir, filename))
        except FileNotFoundError:
            pass
        except OSError as exc:
            app.logger.warning("Could not remove replaced account logo %s: %s", filename, exc)


@app.post("/api/accounts/<int:aid>/logo")
@auth("admin")
def upload_account_logo(aid):
    account = q("""
        SELECT a.account_id, a.role, a.aux_id, a.logo_path, x.logo_path AS aux_logo_path
        FROM accounts a LEFT JOIN auxiliaries x ON x.aux_id=a.aux_id
        WHERE a.account_id=%s AND a.is_active
    """, (aid,), one=True)
    if not account:
        return err("Account not found", 404)
    f = request.files.get("file")
    ext = {"image/png": ".png", "image/jpeg": ".jpg"}.get(f.mimetype if f else None)
    if not ext:
        return err("PNG or JPG only")
    data = f.read()
    if not data:
        return err("Logo file is empty")
    if len(data) > MAX_LOGO_SIZE:
        return err("File too large (max 2 MB)")
    if (ext == ".png" and not data.startswith(b"\x89PNG\r\n\x1a\n")) or (
        ext == ".jpg" and not data.startswith(b"\xff\xd8\xff")
    ):
        return err("The file contents do not match its image type")
    is_admin_logo = account["role"] == "admin"
    staff_ids = [] if is_admin_logo else q(
        "SELECT account_id FROM accounts WHERE aux_id=%s AND role='staff'", (account["aux_id"],))
    name = f"account-{aid}-{secrets.token_hex(4)}{ext}" if is_admin_logo else (
        f"aux-{account['aux_id']}-{secrets.token_hex(4)}{ext}")
    save_logo(name, ext, data)                              # stored in the database, not the uploads folder
    path = f"uploads/logos/{name}"
    previous_path = account["logo_path"] if is_admin_logo else account["aux_logo_path"]
    if is_admin_logo:
        run("UPDATE accounts SET logo_path=%s WHERE account_id=%s", (path, aid))
    else:
        run("UPDATE auxiliaries SET logo_path=%s WHERE aux_id=%s", (path, account["aux_id"]))
    audit("logo_changed", str(aid))
    conn().commit()
    prune_logos()
    if is_admin_logo:
        _cleanup_account_logo_files(aid, previous_path, path)
    else:
        _cleanup_aux_logo_files(account["aux_id"], staff_ids, previous_path, path)
    return jsonify({"logo_path": path})


# POS data (cached on the device for offline use)
@app.get("/api/pos/bootstrap")
@auth("staff")
def pos_bootstrap():
    ensure_sales_batch_schema()
    aux = g.user["aux_id"]
    products = q("""
        SELECT p.product_id, p.name, p.barcode, p.category, p.price, i.qty_on_hand AS qty, COALESCE(s.sold7, 0) AS sold7
        FROM products p JOIN inventory i ON i.product_id = p.product_id AND i.aux_id = %(aux)s AND i.is_active
        LEFT JOIN (SELECT product_id, -SUM(qty) AS sold7 FROM stock_movements
                   WHERE aux_id = %(aux)s AND movement_type = 'sale' AND business_date >= %(d)s - 7 GROUP BY product_id) s
               ON s.product_id = p.product_id
        WHERE p.is_active AND p.category <> 'Meals' ORDER BY p.name""", {"aux": aux, "d": today()})
    meals = {r["meal_key"]: r["qty_on_hand"] for r in q(
        "SELECT p.meal_key, i.qty_on_hand FROM products p JOIN inventory i ON i.product_id=p.product_id AND i.aux_id=%s WHERE p.category='Meals'", (aux,))}
    meal_prices = {r["price_key"]: r["amount"] for r in q("SELECT price_key, amount FROM meal_prices")}
    pricing_token = pricing_ser.dumps({
        "aux_id": aux,
        "meal_prices": {key: str(value) for key, value in meal_prices.items()},
        "products": [{"product_id": p["product_id"], "name": p["name"], "price": str(p["price"])} for p in products],
    })
    return jsonify({"products": products, "meal_stock": meals,
                    "meal_prices": meal_prices, "pricing_token": pricing_token,
                    "settings": settings(), "user": public_user(g.user), "server_time": datetime.now(TZ).isoformat()})


# saving sales (also used when an offline outbox syncs)
def save_transaction(user, t, meal_ids):
    """Returns 'saved' | 'duplicate'.  Raises SaleError for a sale that can never be valid."""
    try:
        tid = uuid.UUID(str(t["id"]))
    except (KeyError, ValueError):
        raise SaleError("bad transaction id")
    if q("SELECT 1 FROM transactions WHERE transaction_id=%s", (str(tid),), one=True):
        return "duplicate"            # already received before (connection dropped before the reply) -> safe to ignore
    token = t.get("pricing_token")
    if not isinstance(token, str):
        raise SaleError("price snapshot missing; this queued sale needs manual review")
    try:
        snapshot = pricing_ser.loads(token)
    except BadSignature:
        raise SaleError("price snapshot invalid; this queued sale needs manual review")
    if not isinstance(snapshot, dict) or snapshot.get("aux_id") != user["aux_id"]:
        raise SaleError("price snapshot belongs to another outlet")
    try:
        mp = {key: D(value) for key, value in snapshot["meal_prices"].items()}
        prods = {
            int(p["product_id"]): {
                "product_id": int(p["product_id"]),
                "name": p["name"],
                "price": D(p["price"]),
                "is_active": True,
            }
            for p in snapshot["products"]
        }
    except (KeyError, TypeError, ValueError, InvalidOperation):
        raise SaleError("price snapshot is invalid; this queued sale needs manual review")
    try:
        created = datetime.fromisoformat(t["created_at"])
    except (KeyError, ValueError):
        raise SaleError("bad time")
    created = (created if created.tzinfo else created.replace(tzinfo=TZ)).astimezone(TZ)
    aux = user["aux_id"]
    biz = created.date()

    pay = t.get("payment_method")
    if pay not in ("Cash", "E-Wallet"):
        raise SaleError("bad payment method")
    ref4 = (t.get("ewallet_ref4") or "") if pay == "E-Wallet" else None
    if pay == "E-Wallet" and not re.fullmatch(r"[0-9]{4}", ref4):
        raise SaleError("e-wallet reference must be 4 digits")
    dine = "Take-out" if t.get("dine") in ("out", "Take-out") else "Dine-in"

    lines = []
    for spec in t.get("lines") or []:
        if spec.get("type") == "takeout_box":
            qty = int(spec.get("qty", 1))
            if not 1 <= qty <= 99: raise SaleError("bad qty")
            lines.append(dict(name="Takeout box", section="Meals", kind="Add-on", unit_price=mp["take_out_box"], qty=qty, parts={}, product_id=None,
                              meat=None, meat_qty=None, veg_qty=None, rice_type=None, rice_qty=None, is_budget=False))
            continue
        prod = prods.get(int(spec["product_id"])) if spec.get("type") == "product" and str(spec.get("product_id", "")).isdigit() else None
        lines.append(build_line(spec, mp, prod))
    if not lines:
        raise SaleError("empty sale")
    total = sum(l["unit_price"] * l["qty"] for l in lines)
    tendered = None
    if pay == "Cash":
        try:
            tendered = D(t["amount_tendered"])
        except (KeyError, TypeError, ValueError, InvalidOperation):
            raise SaleError("cash tendered must be a valid amount")
        if not tendered.is_finite() or tendered < total:
            raise SaleError("cash tendered is less than the sale total")
        if tendered >= 1_000_000:
            raise SaleError("cash tendered can have at most 6 digits")
        if tendered - total > MAX_CHANGE:
            raise SaleError(f"cash tendered is too high (change cannot exceed ₱{MAX_CHANGE:,})")

    run("""INSERT INTO transactions (transaction_id, receipt_no, aux_id, cashier_id, device_id, created_at, business_date,
                                      payment_method, amount_tendered, ewallet_ref_last4, dine_type, total_amount)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (str(tid), str(t.get("receipt_no") or str(tid)[:8])[:40], aux, user["account_id"], str(t.get("device_id") or "")[:60],
         created, biz, pay, tendered, ref4, dine, total))
    used = {}                                              # product_id -> units used by this sale
    for l in lines:
        lid = run("""INSERT INTO transaction_lines (transaction_id, item_name, section, kind, product_id, meat, meat_qty, veg_qty,
                         rice_type, rice_qty, is_budget, unit_price, qty) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING line_id""",
                  (str(tid), l["name"], l["section"], l["kind"], l["product_id"], l["meat"], l["meat_qty"], l["veg_qty"],
                   l["rice_type"], l["rice_qty"], l["is_budget"], l["unit_price"], l["qty"])).fetchone()["line_id"]
        for key, servings in l["parts"].items():
            pid = meal_ids[key]
            run("INSERT INTO line_parts (line_id, product_id, servings) VALUES (%s,%s,%s)", (lid, pid, servings))
            used[pid] = used.get(pid, 0) + servings * l["qty"]
        if l["product_id"]:
            used[l["product_id"]] = used.get(l["product_id"], 0) + l["qty"]
    for pid, qty in used.items():                          # stock goes down + one ledger row per product
        run("INSERT INTO stock_movements (aux_id, product_id, movement_type, qty, business_date, transaction_id, created_by) VALUES (%s,%s,'sale',%s,%s,%s,%s)",
            (aux, pid, -qty, biz, str(tid), user["account_id"]))
        run("UPDATE inventory SET qty_on_hand = qty_on_hand - %s WHERE aux_id=%s AND product_id=%s", (qty, aux, pid))
    return "saved"


@app.post("/api/sync/transactions")
@auth("staff")
def sync_transactions():
    d = request.get_json(silent=True) or {}
    meal_ids = {r["meal_key"]: r["product_id"] for r in q("SELECT product_id, meal_key FROM products WHERE category='Meals'")}
    results = []
    for t in d.get("transactions", []):
        try:
            status = save_transaction(g.user, {**t, "device_id": t.get("device_id") or d.get("device_id")}, meal_ids)
            conn().commit()
            results.append({"id": t.get("id"), "status": status})
        except (SaleError, KeyError, ValueError, TypeError) as e:
            conn().rollback()
            results.append({"id": t.get("id"), "status": "rejected", "reason": str(e)})   # device keeps it and shows a warning
    return jsonify({"results": results})


# sales batches
@app.post("/api/sales-batches/seal")
@auth("staff")
def seal_sales_batch():
    ensure_sales_batch_schema()
    d = request.get_json(silent=True) or {}
    password = str(d.get("password") or "")
    if not password:
        return err("Enter your password")
    if not check_password_hash(g.user["password_hash"], password):
        return err("Incorrect password")
    aux_id, day = g.user["aux_id"], today()
    run("SELECT pg_advisory_xact_lock(%s)", (aux_id,))
    rows = q("""SELECT transaction_id, payment_method, total_amount
                FROM transactions
                WHERE aux_id=%s AND business_date=%s AND status='completed' AND batch_id IS NULL
                ORDER BY created_at, transaction_id
                FOR UPDATE""", (aux_id, day))
    if not rows:
        conn().rollback()
        return err("There are no new sales to seal today")
    total_cash = sum((r["total_amount"] for r in rows if r["payment_method"] == "Cash"), D("0"))
    total_ewallet = sum((r["total_amount"] for r in rows if r["payment_method"] == "E-Wallet"), D("0"))
    total_sales = total_cash + total_ewallet
    latest = q("SELECT COALESCE(MAX(batch_number),0) AS n FROM sales_batches WHERE aux_id=%s AND business_date=%s",
               (aux_id, day), one=True)
    batch_number = latest["n"] + 1
    batch = q("""INSERT INTO sales_batches
                 (aux_id, business_date, batch_number, total_cash, total_ewallet, total_sales, transaction_count, sealed_by)
                 VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                 RETURNING batch_id, batch_number, business_date, total_cash, total_ewallet, total_sales, transaction_count, sealed_at""",
              (aux_id, day, batch_number, total_cash, total_ewallet, total_sales, len(rows), g.user["account_id"]), one=True)
    run("UPDATE transactions SET batch_id=%s WHERE transaction_id=ANY(%s::uuid[])",
        (batch["batch_id"], [str(r["transaction_id"]) for r in rows]))
    audit("sales_batch_sealed", f"{aux_id} {day.isoformat()} batch={batch_number} transactions={len(rows)}")
    conn().commit()
    batch["sealed_at"] = batch["sealed_at"].astimezone(TZ).isoformat()
    return jsonify({"ok": True, "batch": batch}), 201


# inventory + products
def stock_status(qty, level):
    return "out" if qty <= 0 else ("low" if qty < level else "in")


@app.get("/api/inventory")
@auth()
def inventory():
    ids = scope(request.args.get("aux"))
    rows = q("""SELECT p.product_id, p.name, p.barcode, p.category, p.price, p.low_stock_level, p.use_for_prediction, i.qty_on_hand AS qty,
                       (i.is_active AND p.is_active) AS is_active, a.aux_id, a.name AS aux_name
                FROM inventory i JOIN products p ON p.product_id = i.product_id JOIN auxiliaries a ON a.aux_id = i.aux_id
                WHERE i.aux_id = ANY(%s) AND p.category <> 'Meals'
                ORDER BY (i.is_active AND p.is_active) DESC, p.name, a.aux_id""", (ids,))
    for r in rows:
        r["status"] = stock_status(r["qty"], r["low_stock_level"])
    meals = {k: 0 for k in ("rice", "pork", "beef", "chicken", "fish", "veg")}
    for r in q("""SELECT p.meal_key, SUM(i.qty_on_hand) AS qty FROM inventory i JOIN products p ON p.product_id=i.product_id
                  WHERE i.aux_id = ANY(%s) AND p.category='Meals' GROUP BY p.meal_key""", (ids,)):
        meals[r["meal_key"]] = r["qty"]
    act = [r for r in rows if r["is_active"]]
    return jsonify({"products": rows, "meals": meals,
                    "kpi": {"total": len({r["product_id"] for r in rows}), "low": sum(r["status"] == "low" for r in act), "out": sum(r["status"] == "out" for r in act)}})


def _product_fields(d):
    name = (d.get("name") or "").strip()
    if not name:
        raise ValueError("Name is required")
    try:
        price = D(d.get("price") or 0)
        assert price >= 0
    except Exception:
        raise ValueError("Price must be a number")
    cat = (d.get("category") or "Snacks").strip().title() or "Snacks"
    if cat == "Meals":
        raise ValueError("Meals are set up from the price list, choose Snacks or Drinks")
    return name, ((d.get("barcode") or "").strip() or None), cat, price


@app.post("/api/products")
@auth("admin")
def add_product():
    d = request.get_json(silent=True) or {}
    try:
        name, barcode, cat, price = _product_fields(d)
        if barcode and q("SELECT 1 FROM products WHERE barcode=%s", (barcode,), one=True):
            return err("That barcode already exists")
        # use_for_prediction: its future POS sales feed the model (and the automatic retraining) even though it has none yet
        pid = run("INSERT INTO products (name, barcode, category, price, use_for_prediction) VALUES (%s,%s,%s,%s,%s) RETURNING product_id",
                  (name, barcode, cat, price, bool(d.get("use_for_prediction")))).fetchone()["product_id"]
        run("INSERT INTO inventory (aux_id, product_id) SELECT aux_id, %s FROM auxiliaries", (pid,))
        aux = d.get("aux_id")
        if aux and D(d.get("stock") or 0) > 0:
            _set_stock(int(aux), pid, D(d["stock"]))
        audit("product_added", name)
        conn().commit()
        return jsonify({"product_id": pid}), 201
    except ValueError as e:
        conn().rollback()
        return err(str(e))


def _set_stock(aux, pid, new_qty):
    cur = q("SELECT qty_on_hand FROM inventory WHERE aux_id=%s AND product_id=%s", (aux, pid), one=True)["qty_on_hand"]
    diff = new_qty - cur
    if diff != 0:
        run("INSERT INTO stock_movements (aux_id, product_id, movement_type, qty, business_date, created_by, note) VALUES (%s,%s,'adjustment',%s,%s,%s,'admin edit')",
            (aux, pid, diff, today(), g.user["account_id"]))
        run("UPDATE inventory SET qty_on_hand=%s WHERE aux_id=%s AND product_id=%s", (new_qty, aux, pid))


@app.put("/api/products/<int:pid>")
@auth("admin")
def edit_product(pid):
    d = request.get_json(silent=True) or {}
    try:
        name, barcode, cat, price = _product_fields(d)
        if barcode and q("SELECT 1 FROM products WHERE barcode=%s AND product_id<>%s", (barcode, pid), one=True):
            return err("That barcode already exists")
        run("UPDATE products SET name=%s, barcode=%s, category=%s, price=%s WHERE product_id=%s", (name, barcode, cat, price, pid))
        aux = d.get("aux_id")
        if aux:
            run("UPDATE inventory SET is_active=%s WHERE aux_id=%s AND product_id=%s", (bool(d.get("is_active", True)), int(aux), pid))
            if d.get("stock") not in (None, ""):
                _set_stock(int(aux), pid, D(d["stock"]))
        audit("product_edited", name)
        conn().commit()
        return jsonify({"ok": True})
    except ValueError as e:
        conn().rollback()
        return err(str(e))


@app.get("/api/prediction-products")
@auth("admin")
def prediction_products():
    return jsonify(q("""SELECT product_id, name, category, use_for_prediction
                      FROM products WHERE is_active ORDER BY category, name"""))


@app.patch("/api/products/<int:pid>/prediction")
@auth("admin")
def set_product_prediction(pid):
    d = request.get_json(silent=True) or {}
    if "use_for_prediction" not in d:
        return err("Choose whether this item is included in prediction")
    if not q("SELECT 1 FROM products WHERE product_id=%s", (pid,), one=True):
        return err("Product not found", 404)
    run("UPDATE products SET use_for_prediction=%s WHERE product_id=%s", (bool(d["use_for_prediction"]), pid))
    audit("prediction_product_changed", str(pid))
    conn().commit()
    return jsonify({"ok": True})


# deliveries (admin lists what to send, staff counts and accepts)
MEAL_ORDER = ["rice", "pork", "beef", "chicken", "fish", "veg"]


def ensure_delivery_status_schema():
    global _delivery_status_schema_ready
    if _delivery_status_schema_ready:
        return
    with _delivery_status_schema_lock:
        if _delivery_status_schema_ready:
            return
        cur = conn().cursor()
        cur.execute("SELECT pg_advisory_xact_lock(68143219)")
        cur.execute("""SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
                       WHERE conrelid='deliveries'::regclass AND conname='deliveries_status_check'""")
        constraint = cur.fetchone()
        if not constraint or "'cancelled'" not in constraint["definition"]:
            cur.execute("ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_status_check")
            cur.execute("""ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check
                           CHECK (status IN ('pending','accepted','cancelled'))""")
        conn().commit()
        _delivery_status_schema_ready = True


@app.post("/api/deliveries")
@auth("admin")
def create_delivery():
    ensure_delivery_status_schema()
    d = request.get_json(silent=True) or {}
    aux, day = d.get("aux_id"), parse_day(d.get("date"), today())
    if not aux:
        return err("Choose an auxiliary")
    items = {}
    for k, v in (d.get("meals") or {}).items():
        p = q("SELECT product_id FROM products WHERE meal_key=%s", (k,), one=True)
        if p and D(v or 0) > 0:
            items[p["product_id"]] = D(v)
    for it in d.get("items") or []:
        if D(it.get("qty") or 0) > 0:
            items[int(it["product_id"])] = D(it["qty"])
    cash = D(d.get("initial_cash") or 0)
    if not items and cash <= 0:
        return err("Enter at least one quantity or the initial cash")
    did = run("INSERT INTO deliveries (aux_id, delivery_date, initial_cash, created_by) VALUES (%s,%s,%s,%s) RETURNING delivery_id",
              (int(aux), day, cash, g.user["account_id"])).fetchone()["delivery_id"]
    for pid, qty in items.items():
        run("INSERT INTO delivery_items (delivery_id, product_id, listed_qty) VALUES (%s,%s,%s)", (did, pid, qty))
    audit("delivery_sent", f"aux {aux} {day}")
    conn().commit()
    return jsonify({"delivery_id": did}), 201


@app.get("/api/deliveries")
@auth()
def list_deliveries():
    ensure_delivery_status_schema()
    ids = scope(request.args.get("aux"))
    rows = q("""SELECT d.delivery_id, d.delivery_date, d.status, d.has_mismatch, d.initial_cash, d.cash_counted, a.name AS aux_name
                FROM deliveries d JOIN auxiliaries a ON a.aux_id = d.aux_id WHERE d.aux_id = ANY(%s)
                ORDER BY d.delivery_date DESC, d.delivery_id DESC LIMIT 60""", (ids,))
    if rows:
        item_rows = q("""SELECT di.delivery_id, di.product_id, p.name, p.category, di.listed_qty, di.counted_qty
                         FROM delivery_items di JOIN products p USING (product_id)
                         WHERE di.delivery_id = ANY(%s)
                         ORDER BY (p.category='Meals') DESC, p.name""", ([r["delivery_id"] for r in rows],))
        items_by_delivery = {}
        for item in item_rows:
            items_by_delivery.setdefault(item["delivery_id"], []).append(item)
        for row in rows:
            row["items"] = items_by_delivery.get(row["delivery_id"], [])
    return jsonify(rows)


@app.get("/api/deliveries/pending")
@auth("staff")
def pending_deliveries():
    ensure_delivery_status_schema()
    out = []
    for d in q("SELECT delivery_id, delivery_date, initial_cash FROM deliveries WHERE aux_id=%s AND status='pending' ORDER BY delivery_date, delivery_id", (g.user["aux_id"],)):
        d["items"] = q("""SELECT di.product_id, p.name, p.category, di.listed_qty FROM delivery_items di JOIN products p USING (product_id)
                          WHERE di.delivery_id=%s ORDER BY (p.category='Meals') DESC, p.name""", (d["delivery_id"],))
        out.append(d)
    return jsonify(out)


@app.patch("/api/deliveries/<int:did>")
@auth("admin")
def edit_delivery(did):
    ensure_delivery_status_schema()
    d = request.get_json(silent=True) or {}
    items = d.get("items")
    if not isinstance(items, list):
        return err("Provide the delivery items to save")
    day = parse_day(d.get("date"))
    if not day:
        return err("Choose a valid delivery date")
    try:
        cash = D(d.get("initial_cash"))
        if not cash.is_finite():
            return err("Initial cash must be a finite number")
        parsed_items = {}
        for item in items:
            product_id = int(item["product_id"])
            qty = D(item["qty"])
            if not qty.is_finite():
                return err("Quantities must be finite numbers")
            if qty < 0:
                return err("Quantities cannot be negative")
            if product_id in parsed_items:
                return err("A product can only appear once")
            parsed_items[product_id] = qty
    except (InvalidOperation, TypeError, ValueError, KeyError):
        return err("Enter valid cash and product quantities")
    if cash < 0:
        return err("Initial cash cannot be negative")
    if not parsed_items and cash == 0:
        return err("A delivery must include items or initial cash")
    existing = q("SELECT status FROM deliveries WHERE delivery_id=%s FOR UPDATE", (did,), one=True)
    if not existing or existing["status"] != "pending":
        conn().rollback()
        return err("Only pending deliveries can be edited", 409)
    product_ids = list(parsed_items)
    found = q("SELECT product_id FROM products WHERE product_id=ANY(%s)", (product_ids,))
    if len(found) != len(product_ids):
        conn().rollback()
        return err("One or more products no longer exist")
    run("UPDATE deliveries SET delivery_date=%s, initial_cash=%s WHERE delivery_id=%s", (day, cash, did))
    run("DELETE FROM delivery_items WHERE delivery_id=%s", (did,))
    for product_id, qty in parsed_items.items():
        if qty > 0:
            run("INSERT INTO delivery_items (delivery_id, product_id, listed_qty) VALUES (%s,%s,%s)",
                (did, product_id, qty))
    audit("delivery_edited", f"{did} items={sum(qty > 0 for qty in parsed_items.values())}")
    conn().commit()
    return jsonify({"ok": True})


@app.post("/api/deliveries/<int:did>/cancel")
@auth()
def cancel_delivery(did):
    ensure_delivery_status_schema()
    delivery = q("SELECT aux_id, status FROM deliveries WHERE delivery_id=%s FOR UPDATE", (did,), one=True)
    if not delivery:
        conn().rollback()
        return err("Delivery not found", 404)
    if g.user["role"] == "staff" and delivery["aux_id"] != g.user["aux_id"]:
        conn().rollback()
        return err("Not allowed", 403)
    if delivery["status"] != "pending":
        conn().rollback()
        return err("Only pending deliveries can be cancelled", 409)
    run("UPDATE deliveries SET status='cancelled' WHERE delivery_id=%s", (did,))
    audit("delivery_cancelled", str(did))
    conn().commit()
    return jsonify({"ok": True})


@app.post("/api/deliveries/<int:did>/accept")
@auth("staff")
def accept_delivery(did):
    ensure_delivery_status_schema()
    d = request.get_json(silent=True) or {}
    dl = q("SELECT * FROM deliveries WHERE delivery_id=%s AND aux_id=%s AND status='pending' FOR UPDATE", (did, g.user["aux_id"]), one=True)
    if not dl:
        return err("Delivery not found or already accepted", 404)
    counts = d.get("counts") or {}
    mismatch = False
    for it in q("SELECT product_id, listed_qty FROM delivery_items WHERE delivery_id=%s", (did,)):
        raw = counts.get(str(it["product_id"]))
        counted = D(raw) if raw not in (None, "") else it["listed_qty"]
        if counted < 0:
            return err("Counts cannot be negative")
        mismatch = mismatch or counted != it["listed_qty"]
        run("UPDATE delivery_items SET counted_qty=%s WHERE delivery_id=%s AND product_id=%s", (counted, did, it["product_id"]))
        if counted:
            run("INSERT INTO stock_movements (aux_id, product_id, movement_type, qty, business_date, delivery_id, created_by) VALUES (%s,%s,'delivery',%s,%s,%s,%s)",
                (dl["aux_id"], it["product_id"], counted, dl["delivery_date"], did, g.user["account_id"]))
            run("UPDATE inventory SET qty_on_hand = qty_on_hand + %s WHERE aux_id=%s AND product_id=%s", (counted, dl["aux_id"], it["product_id"]))
    cash_counted = D(d["cash_counted"]) if d.get("cash_counted") not in (None, "") else dl["initial_cash"]
    mismatch = mismatch or cash_counted != dl["initial_cash"]
    run("""INSERT INTO daily_cash (aux_id, business_date, initial_cash, delivery_id) VALUES (%s,%s,%s,%s)
           ON CONFLICT (aux_id, business_date) DO UPDATE SET initial_cash = daily_cash.initial_cash + EXCLUDED.initial_cash""",
        (dl["aux_id"], dl["delivery_date"], cash_counted, did))
    run("UPDATE deliveries SET status='accepted', accepted_by=%s, accepted_at=now(), cash_counted=%s, has_mismatch=%s WHERE delivery_id=%s",
        (g.user["account_id"], cash_counted, mismatch, did))
    audit("delivery_accepted", f"{did} mismatch={mismatch}")
    conn().commit()
    return jsonify({"ok": True, "has_mismatch": mismatch})


# remittances + cash
def cash_summary(ids, day):
    t = q("""SELECT COALESCE(SUM(total_amount) FILTER (WHERE payment_method='Cash'),0) AS cash,
                    COALESCE(SUM(total_amount) FILTER (WHERE payment_method='E-Wallet'),0) AS ewallet
             FROM transactions WHERE aux_id=ANY(%s) AND business_date=%s AND status='completed'""", (ids, day), one=True)
    rem = q("SELECT COALESCE(SUM(amount),0) AS n FROM remittances WHERE aux_id=ANY(%s) AND business_date=%s", (ids, day), one=True)["n"]
    ini = q("SELECT COALESCE(SUM(initial_cash),0) AS n FROM daily_cash WHERE aux_id=ANY(%s) AND business_date=%s", (ids, day), one=True)["n"]
    return {"initial": ini, "cash_sales": t["cash"], "ewallet_sales": t["ewallet"], "remitted": rem, "total": ini + t["cash"] + t["ewallet"] - rem}


@app.get("/api/remittances/expected")
@auth("staff")
def remit_expected():
    batch = next_unremitted_batch(g.user["aux_id"])
    if batch:
        batch["first_order_at"] = batch["first_order_at"].astimezone(TZ).isoformat()
        batch["last_order_at"] = batch["last_order_at"].astimezone(TZ).isoformat()
    return jsonify({"date": batch["business_date"] if batch else today(), "expected": batch["total_cash"] if batch else 0,
                    "batch_id": batch["batch_id"] if batch else None,
                    "first_order_at": batch["first_order_at"] if batch else None,
                    "last_order_at": batch["last_order_at"] if batch else None})


def next_unremitted_batch(aux_id):
    ensure_sales_batch_schema()
    return q("""SELECT b.batch_id, b.batch_number, b.business_date, b.total_cash,
                       MIN(t.created_at) AS first_order_at, MAX(t.created_at) AS last_order_at
                FROM sales_batches b JOIN transactions t ON t.batch_id=b.batch_id AND t.status='completed'
                WHERE b.aux_id=%s AND b.total_cash > 0 AND NOT EXISTS (
                    SELECT 1 FROM remittances r WHERE r.batch_id=b.batch_id
                )
                GROUP BY b.batch_id
                ORDER BY b.business_date, b.batch_number
                LIMIT 1""", (aux_id,), one=True)


@app.post("/api/remittances")
@auth("staff")
def add_remittance():
    batch = next_unremitted_batch(g.user["aux_id"])
    if not batch:
        return err("Seal a sales period before recording its remittance")
    d = request.get_json(silent=True) or {}
    try:
        amount = D(d.get("amount"))
        assert amount.is_finite() and amount > 0
    except Exception:
        return err("Enter the amount handed over")
    if amount > D(batch["total_cash"]) + MAX_CHANGE:
        return err(f"Amount is too high — it cannot exceed the cash sales by more than ₱{MAX_CHANGE:,}")
    aux_id = g.user["aux_id"]
    run("SELECT pg_advisory_xact_lock(%s)", (aux_id,))
    current = q("""SELECT b.batch_id, b.batch_number, b.business_date, b.total_cash
                   FROM sales_batches b
                   WHERE b.aux_id=%s AND b.total_cash > 0 AND NOT EXISTS (
                       SELECT 1 FROM remittances r WHERE r.batch_id=b.batch_id
                   )
                   ORDER BY b.business_date, b.batch_number
                   LIMIT 1""", (aux_id,), one=True)
    if not current or str(current["batch_id"]) != str(batch["batch_id"]) or str(d.get("batch_id") or "") != str(batch["batch_id"]):
        conn().rollback()
        return err("The next unremitted sales period changed. Refresh and try again.")
    run("""INSERT INTO remittances
           (aux_id, business_date, amount, expected_amount, recorded_by, batch_id)
           VALUES (%s,%s,%s,%s,%s,%s)""",
        (aux_id, batch["business_date"], amount, batch["total_cash"], g.user["account_id"], batch["batch_id"]))
    audit("remittance", f"batch={batch['batch_number']} amount={amount}")
    conn().commit()
    return jsonify({"ok": True}), 201


# dashboard
@app.get("/api/prediction")
@auth()
def prediction_api():
    ids = scope(request.args.get("aux"))
    day = parse_day(request.args.get("date"), today())
    cur = conn().cursor()
    result = pred.get_prediction(cur, ids, day)
    return jsonify({"aux": request.args.get("aux", "all"), **result})


# Prediction for a chosen date (staff pick the date and the items)
def _prediction_target():
    """The canteen being predicted: staff = their own, admin = ?aux=<id>. Returns (aux_id, aux_code) or an error response."""
    ids = scope(request.args.get("aux") if request.method == "GET" else (request.get_json(silent=True) or {}).get("aux"))
    if len(ids) != 1:
        return None, err("Choose one canteen", 400)
    row = q("SELECT aux_id, code FROM auxiliaries WHERE aux_id=%s", (ids[0],), one=True)
    return ((row["aux_id"], row["code"]), None) if row else (None, err("Canteen not found", 404))


def _next_school_day_from(d):
    while d.weekday() >= 5 or q("SELECT 1 FROM events WHERE event_date=%s AND event_type='no_classes'", (d,), one=True):
        d += timedelta(days=1)
    return d


@app.get("/api/prediction/items")
@auth()
def prediction_items():
    """Items the staff can choose from, with how much history each has, plus the model status."""
    kind = request.args.get("kind", "snacks")
    if kind not in pe.KINDS:
        return err("kind must be snacks or meals")
    t, bad = _prediction_target()
    if bad:
        return bad
    aux_id, code = t
    try:
        items = pe.catalog(conn().cursor(), aux_id, code, kind)
    except Exception as e:
        return err(f"Could not read the item list: {e}", 500)
    return jsonify({"aux": code, "kind": kind, "items": items, "model": pe.model_info(code, kind),
                    "default_date": _next_school_day_from(today() + timedelta(days=1)).isoformat(),
                    "has_history": bool(items)})


@app.post("/api/prediction/run")
@auth()
def prediction_run():
    """Section-7 output: one row per chosen item for the chosen date."""
    d = request.get_json(silent=True) or {}
    kind = d.get("kind", "snacks")
    day = parse_day(d.get("date"))
    items = d.get("items")
    if kind not in pe.KINDS:
        return err("kind must be snacks or meals")
    if not day:
        return err("Choose a date")
    if day.weekday() >= 5:
        return err("The canteen is open Monday to Friday. Choose a weekday.")
    if day > today() + timedelta(days=60):
        return err("Choose a date within the next 60 days")
    if not isinstance(items, list) or not items:
        return err("Choose at least one dish or snack")
    if len(items) > 200:
        return err("Too many items selected")
    t, bad = _prediction_target()
    if bad:
        return bad
    aux_id, code = t
    cur = conn().cursor()
    try:
        rows, info = pe.predict(cur, aux_id, code, kind, day, [str(i) for i in items])
        actual = pe.actuals_for(cur, aux_id, kind, day) if day <= today() else {}
        conn().commit()
    except pe.PredictionError as e:
        conn().rollback()
        return err(str(e))
    except Exception as e:
        conn().rollback()
        app.logger.exception("prediction failed")
        return err(f"The prediction could not be made: {e}", 500)
    if actual:
        for r in rows:
            r["actual_qty"] = actual.get(r["item"])
    if info["days_since_history"] > 10:
        info["warnings"].append(f"The latest recorded sales are from {info['history_through']}. "
                                f"The further the date is from the last record, the less reliable the prediction.")
    audit("prediction_run", f"{code} {kind} {day.isoformat()} items={len(rows)}")
    conn().commit()
    return jsonify({"aux": code, "rows": rows, "info": info, "total_predicted": round(sum(r["predicted_qty"] for r in rows), 1),
                    "has_actual": bool(actual)})


@app.get("/api/dashboard")
@auth()
def dashboard():
    ids = scope(request.args.get("aux"))
    day = parse_day(request.args.get("date"), today())
    cur = conn().cursor()
    prediction_data = pred.get_prediction(cur, ids, day)
    lo = q("""SELECT COUNT(*) FILTER (WHERE i.qty_on_hand <= 0) AS out,
                     COUNT(*) FILTER (WHERE i.qty_on_hand > 0 AND i.qty_on_hand < p.low_stock_level) AS low
              FROM inventory i JOIN products p USING (product_id)
              WHERE i.aux_id = ANY(%s) AND i.is_active AND p.is_active AND p.category <> 'Meals'""", (ids,), one=True)
    snacks = q("""SELECT p.name, COALESCE(-SUM(m.qty) FILTER (WHERE m.movement_type='sale' AND m.business_date=%s),0) AS qty
                  FROM products p JOIN inventory i ON i.product_id=p.product_id AND i.aux_id = ANY(%s) AND i.is_active
                  LEFT JOIN stock_movements m ON m.product_id=p.product_id AND m.aux_id=i.aux_id
                  WHERE p.category='Snacks' AND p.is_active GROUP BY p.product_id ORDER BY qty DESC, p.name""", (day, ids))
    meals = q("""SELECT l.kind AS name, SUM(l.qty) AS qty FROM transaction_lines l JOIN transactions t USING (transaction_id)
                 WHERE t.aux_id=ANY(%s) AND t.business_date=%s AND t.status='completed' AND l.section='Meals' AND l.kind <> 'Add-on'
                 GROUP BY l.kind ORDER BY qty DESC, l.kind""", (ids, day))
    weekly = q("""SELECT d::date AS date, COALESCE(SUM(t.total_amount),0) AS total
                  FROM generate_series(%s::date - 6, %s::date, '1 day') d
                  LEFT JOIN transactions t ON t.business_date = d::date AND t.aux_id = ANY(%s) AND t.status='completed'
                  GROUP BY d ORDER BY d""", (day, day, ids))
    out = {"date": day, "prediction": prediction_data, "event_tomorrow": prediction_data["event"],
           "lowout": {"low": lo["low"], "out": lo["out"], "total": lo["low"] + lo["out"]},
           "sellers": {"top_snacks": [r for r in snacks if r["qty"] > 0][:10], "low_snacks": sorted(snacks, key=lambda r: (r["qty"], r["name"]))[:10],
                       "top_meals": meals[:10], "low_meals": sorted(meals, key=lambda r: (r["qty"], r["name"]))[:10]},
           "cash": cash_summary(ids, day), "weekly": weekly}
    if g.user["role"] == "admin":
        out["sales_by_aux"] = q("""SELECT a.aux_id, a.name, COALESCE(SUM(t.total_amount),0) AS total FROM auxiliaries a
                                   LEFT JOIN transactions t ON t.aux_id=a.aux_id AND t.business_date=%s AND t.status='completed'
                                   WHERE a.aux_id = ANY(%s) GROUP BY a.aux_id ORDER BY a.aux_id""", (day, ids))
    else:
        out["pending_deliveries"] = q("SELECT COUNT(*) AS n FROM deliveries WHERE aux_id=%s AND status='pending'", (g.user["aux_id"],), one=True)["n"]
    return jsonify(out)


# transactions page + report slips
@app.get("/api/transactions")
@auth()
def transactions():
    ensure_sales_batch_schema()
    ids = scope(request.args.get("aux"))
    frm = parse_day(request.args.get("from"), today())
    to = parse_day(request.args.get("to"), frm)
    pay = {"cash": "Cash", "ewallet": "E-Wallet"}.get(request.args.get("pay"))
    rows = q("""
        SELECT t.transaction_id, t.aux_id, t.batch_id, t.receipt_no, t.created_at, t.business_date,
               t.payment_method, t.ewallet_ref_last4, t.dine_type, t.total_amount, b.batch_number,
               a.name AS aux_name, (t.created_at AT TIME ZONE %(tz)s)::date AS created_date,
               COALESCE(SUM(l.unit_price*l.qty) FILTER (WHERE l.section='Meals'),0) AS meals_amt,
               COALESCE(SUM(l.unit_price*l.qty) FILTER (WHERE l.section='Snacks'),0) AS snacks_amt,
               STRING_AGG(l.qty || '× ' || l.item_name, ', ' ORDER BY l.line_id) FILTER (WHERE l.section='Meals') AS meals_order,
               STRING_AGG(l.qty || '× ' || l.item_name, ', ' ORDER BY l.line_id) FILTER (WHERE l.section='Snacks') AS snacks_items,
               COALESCE(BOOL_OR(l.is_budget),FALSE) AS has_budget
        FROM transactions t JOIN auxiliaries a ON a.aux_id=t.aux_id
        LEFT JOIN sales_batches b ON b.batch_id=t.batch_id
        JOIN transaction_lines l ON l.transaction_id=t.transaction_id
        WHERE t.status='completed' AND t.aux_id = ANY(%(ids)s) AND t.business_date BETWEEN %(f)s AND %(t)s AND (%(pay)s::text IS NULL OR t.payment_method=%(pay)s)
        GROUP BY t.transaction_id, a.name, b.batch_id, b.batch_number ORDER BY t.created_at""", {"tz": TIMEZONE, "ids": ids, "f": frm, "t": to, "pay": pay})
    parts = {}
    if rows:
        for r in q("""SELECT l.transaction_id, p.meal_key, SUM(lp.servings * l.qty) AS s FROM line_parts lp
                      JOIN transaction_lines l ON l.line_id=lp.line_id JOIN products p ON p.product_id=lp.product_id
                      WHERE l.transaction_id = ANY(%s::uuid[]) GROUP BY 1,2""", ([str(x["transaction_id"]) for x in rows],)):
            parts.setdefault(str(r["transaction_id"]), {})[r["meal_key"]] = r["s"]

    meals_reg, meals_car, snack_reg, snack_car = [], [], [], []
    for r in rows:
        carried = r["created_date"] < r["business_date"]
        base = {"transaction_id": str(r["transaction_id"]), "aux_id": r["aux_id"], "batch_id": r["batch_id"],
                "created_at": r["created_at"].astimezone(TZ).isoformat(), "business_date": r["business_date"],
                "ref": r["receipt_no"], "aux_name": r["aux_name"], "pay": r["payment_method"], "ref4": r["ewallet_ref_last4"],
                "batch_number": r["batch_number"]}
        if r["meals_amt"] > 0:
            p = parts.get(str(r["transaction_id"]), {})
            row = {**base, "order": r["meals_order"], "total": r["meals_amt"], "is_budget": r["has_budget"], "is_takeout": r["dine_type"] == "Take-out",
                   **{k: p.get(k, 0) for k in MEAL_ORDER}}
            (meals_car if carried else meals_reg).append(row)
        if r["snacks_amt"] > 0:
            row = {**base, "items": r["snacks_items"], "total": r["snacks_amt"]}
            (snack_car if carried else snack_reg).append(row)

    kpi = q("""SELECT COALESCE(SUM(total_amount),0) AS sales, COALESCE(SUM(total_amount) FILTER (WHERE payment_method='Cash'),0) AS cash,
                      COALESCE(SUM(total_amount) FILTER (WHERE payment_method='E-Wallet'),0) AS ewallet
               FROM transactions WHERE status='completed' AND aux_id=ANY(%s) AND business_date BETWEEN %s AND %s
               AND (%s::text IS NULL OR payment_method=%s)""", (ids, frm, to, pay, pay), one=True)
    kpi["remitted"] = q("SELECT COALESCE(SUM(amount),0) AS n FROM remittances WHERE aux_id=ANY(%s) AND business_date BETWEEN %s AND %s", (ids, frm, to), one=True)["n"]
    remittances = q("""SELECT r.remittance_id, r.aux_id, r.batch_id, r.business_date, r.amount, r.expected_amount, r.recorded_at,
                              a.name AS aux_name, b.batch_number
                       FROM remittances r JOIN auxiliaries a USING (aux_id)
                       LEFT JOIN sales_batches b ON b.batch_id=r.batch_id
                       WHERE r.aux_id=ANY(%s) AND r.business_date BETWEEN %s AND %s
                       ORDER BY r.recorded_at DESC""", (ids, frm, to))
    for r in remittances:
        r["recorded_at"] = r["recorded_at"].astimezone(TZ).isoformat()
    order_ranges = q("""SELECT t.aux_id, t.business_date, t.batch_id, b.batch_number,
                               MIN(t.created_at) AS first_order_at, MAX(t.created_at) AS last_order_at
                        FROM transactions t LEFT JOIN sales_batches b ON b.batch_id=t.batch_id
                        WHERE t.aux_id=ANY(%s) AND t.business_date BETWEEN %s AND %s AND t.status='completed'
                        GROUP BY t.aux_id, t.business_date, t.batch_id, b.batch_number
                        ORDER BY t.business_date DESC, t.aux_id, b.batch_number""", (ids, frm, to))
    for order_range in order_ranges:
        order_range["first_order_at"] = order_range["first_order_at"].astimezone(TZ).isoformat()
        order_range["last_order_at"] = order_range["last_order_at"].astimezone(TZ).isoformat()
    batches = q("""SELECT b.batch_id, b.aux_id, b.batch_number, b.business_date, b.total_cash, b.total_ewallet,
                          b.total_sales, b.transaction_count, b.sealed_at, a.name AS aux_name
                   FROM sales_batches b JOIN auxiliaries a USING (aux_id)
                   WHERE b.aux_id=ANY(%s) AND b.business_date BETWEEN %s AND %s
                   ORDER BY b.business_date DESC, b.aux_id, b.batch_number DESC""", (ids, frm, to))
    for batch in batches:
        batch["sealed_at"] = batch["sealed_at"].astimezone(TZ).isoformat()

    # stock summary of the period (this is the paper slip: beginning / received / sold / left)
    stock = q("""SELECT p.product_id, p.name, p.category, p.meal_key, p.price,
            COALESCE(SUM(m.qty) FILTER (WHERE m.business_date < %(f)s),0) AS beg,
            COALESCE(SUM(m.qty) FILTER (WHERE m.movement_type='delivery' AND m.business_date BETWEEN %(f)s AND %(t)s),0) AS rcvd,
            COALESCE(-SUM(m.qty) FILTER (WHERE m.movement_type='sale' AND m.business_date BETWEEN %(f)s AND %(t)s),0) AS sold,
            COALESCE(SUM(m.qty) FILTER (WHERE m.business_date <= %(t)s),0) AS left
        FROM products p JOIN inventory i ON i.product_id=p.product_id AND i.aux_id = ANY(%(ids)s)
        LEFT JOIN stock_movements m ON m.product_id=p.product_id AND m.aux_id=i.aux_id
        GROUP BY p.product_id ORDER BY p.name""", {"f": frm, "t": to, "ids": ids})
    sales_by_product = {r["product_id"]: r["n"] for r in q("""SELECT l.product_id, SUM(l.unit_price*l.qty) AS n FROM transaction_lines l JOIN transactions t USING (transaction_id)
        WHERE l.product_id IS NOT NULL AND t.status='completed' AND t.aux_id=ANY(%s) AND t.business_date BETWEEN %s AND %s GROUP BY 1""", (ids, frm, to))}
    zero = {k: 0 for k in MEAL_ORDER}
    ms = {"received": dict(zero), "sold": dict(zero), "left": dict(zero)}
    summary = []
    for s in stock:
        if s["category"] == "Meals":
            ms["received"][s["meal_key"]], ms["sold"][s["meal_key"]], ms["left"][s["meal_key"]] = s["rcvd"], s["sold"], s["left"]
        elif s["sold"]:
            sales = sales_by_product.get(s["product_id"], 0)
            summary.append({"name": s["name"], "beg": s["beg"], "rcvd": s["rcvd"], "total": s["beg"] + s["rcvd"], "sold": s["sold"], "left": s["left"],
                            "avg_price": sales / s["sold"], "sales": sales})
    carried_sold = dict(zero)
    for r in meals_car:
        for k in MEAL_ORDER:
            carried_sold[k] += r[k]
    return jsonify({"from": frm, "to": to, "kpi": kpi, "remittances": remittances, "batches": batches,
                    "order_ranges": order_ranges,
                    "meals": {"regular": meals_reg, "carried": meals_car, **ms, "carried_sold": carried_sold,
                              "regular_total": sum(r["total"] for r in meals_reg), "carried_total": sum(r["total"] for r in meals_car)},
                    "snacks": {"summary": summary, "regular": snack_reg, "carried": snack_car,
                               "regular_total": sum(r["total"] for r in snack_reg), "carried_total": sum(r["total"] for r in snack_car)}})


# events
@app.get("/api/events")
@auth()
def list_events():
    return jsonify(q("SELECT event_id, name, event_type, event_date, notes FROM events WHERE event_date >= %s - 30 ORDER BY event_date", (today(),)))


@app.post("/api/events")
@auth("admin")
def add_event():
    d = request.get_json(silent=True) or {}
    day, name = parse_day(d.get("date")), (d.get("name") or "").strip()
    if not day or not name or d.get("type") not in ("no_classes", "exam", "event", "other"):
        return err("Date, type and name are required")
    run("INSERT INTO events (name, event_type, event_date, notes, created_by) VALUES (%s,%s,%s,%s,%s)", (name, d["type"], day, (d.get("notes") or "").strip(), g.user["account_id"]))
    audit("event_added", name)
    conn().commit()
    return jsonify({"ok": True}), 201


@app.delete("/api/events/<int:eid>")
@auth("admin")
def delete_event(eid):
    run("DELETE FROM events WHERE event_id=%s", (eid,))
    audit("event_deleted", str(eid))
    conn().commit()
    return jsonify({"ok": True})


# accounts (admin password is required for every change)
def _admin_ok(d):
    return check_password_hash(g.user["password_hash"], d.get("admin_password") or "")


@app.get("/api/accounts")
@auth("admin")
def list_accounts():
    return jsonify(q("""SELECT a.account_id, a.username, a.role, a.is_active, x.name AS aux_name FROM accounts a
                        LEFT JOIN auxiliaries x ON x.aux_id=a.aux_id ORDER BY a.role, a.account_id"""))


@app.patch("/api/accounts/<int:aid>")
@auth("admin")
def edit_account(aid):
    d = request.get_json(silent=True) or {}
    if not _admin_ok(d):
        return err("Admin password is incorrect", 403)
    new_user, new_pw = (d.get("new_username") or "").strip().lower(), d.get("new_password") or ""
    if new_pw and new_pw != d.get("confirm_password"):
        return err("New passwords do not match")
    if new_pw and len(new_pw) < 6:
        return err("Password must be at least 6 characters")
    if new_user:
        if not re.fullmatch(r"[a-z0-9._-]{3,30}", new_user):
            return err("Username: 3-30 letters, numbers, . _ -")
        if q("SELECT 1 FROM accounts WHERE lower(username)=%s AND account_id<>%s", (new_user, aid), one=True):
            return err("That username is already used")
        run("UPDATE accounts SET username=%s WHERE account_id=%s", (new_user, aid))
    if new_pw:
        run("UPDATE accounts SET password_hash=%s, must_change_password=FALSE, failed_attempts=0, locked_until=NULL WHERE account_id=%s", (generate_password_hash(new_pw), aid))
    if not new_user and not new_pw:
        return err("Nothing to change")
    audit("account_changed", str(aid))
    conn().commit()
    return jsonify({"ok": True})


@app.post("/api/accounts/<int:aid>/reset")
@auth("admin")
def reset_account(aid):
    d = request.get_json(silent=True) or {}
    if not _admin_ok(d):
        return err("Admin password is incorrect", 403)
    temp = "Temp-" + secrets.token_hex(3)
    run("UPDATE accounts SET password_hash=%s, must_change_password=TRUE, failed_attempts=0, locked_until=NULL WHERE account_id=%s", (generate_password_hash(temp), aid))
    audit("password_reset", str(aid))
    conn().commit()
    return jsonify({"temp_password": temp})


# frontend files
@app.get("/uploads/<path:p>")
def uploads(p):
    if p.startswith("logos/") and "/" not in p[6:]:
        ensure_logo_store()
        name = p[6:]
        row = q("SELECT mime, data FROM logo_files WHERE name=%s", (name,), one=True)
        found = (row["mime"], bytes(row["data"])) if row else _import_logo_from_disk(name)
        if not found:
            return err("Logo not found", 404)
        conn().commit()
        res = Response(found[1], mimetype=found[0])
        res.headers["Cache-Control"] = "public, max-age=31536000, immutable"   # every new logo gets a new random name
        return res
    return send_from_directory(UPLOADS, p)


@app.get("/")
def home():
    return redirect("/login.html")


@app.get("/<path:p>")
def static_files(p):
    return send_from_directory(FRONTEND, p)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=os.getenv("FLASK_DEBUG", "0") == "1")   # debug only on your own computer: set FLASK_DEBUG=1

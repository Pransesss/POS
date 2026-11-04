"""Automatic retraining: continuous learning from the sales punched in the POS.

Every AUTO_TRAIN_DAYS (default 14) days, each canteen's snacks and meals model is retrained on
all history so far: the imported CSVs (sales_history) + every POS sale of products ticked
"use for prediction" (prediction_engine.load_series reads both). Nothing has to be run by hand.

  * Runs in a background thread of the web app; it checks once an hour whether a model is due.
    A sleeping host (free tier) simply catches up the next time it wakes.
  * Skips a model when no new sales arrived since it was last trained.
  * Only one server trains at a time (PostgreSQL advisory lock).
  * The trained files are ALSO saved in the database (model_files), because a redeploy / system
    update wipes the app folder. On start the newest model in the database is put back.
  * Turn off with AUTO_TRAIN=0. Each attempt is recorded in model_auto_train (last_attempt, last_status),
    each finished training in model_runs (same as train_model.py).
"""
import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta

import psycopg2

import prediction_engine as pe
from db import connect

INTERVAL_DAYS = int(os.getenv("AUTO_TRAIN_DAYS", "14"))
CHECK_EVERY_S = 3600
START_DELAY_S = 120                  # let the app finish starting before any training
SEEDS, EPOCHS = 3, 150               # same as train_model.py
LOCK_KEY = 7420111                   # advisory lock id: one trainer at a time across servers

log = logging.getLogger("auto_train")
_started = False
_start_lock = threading.Lock()


def ensure_tables(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS model_files (
                     aux_code TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
                     data BYTEA NOT NULL, saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                     PRIMARY KEY (aux_code, kind, name))""")
    cur.execute("""CREATE TABLE IF NOT EXISTS model_auto_train (
                     aux_id INTEGER NOT NULL REFERENCES auxiliaries(aux_id), kind TEXT NOT NULL,
                     last_attempt TIMESTAMPTZ, last_status TEXT,
                     PRIMARY KEY (aux_id, kind))""")


# keeping the model in the database
def _model_files(code, kind):
    d = pe.model_path(code, kind)
    if not d.exists():
        return []
    return [p for p in d.iterdir() if p.is_file() and (p.name in ("meta.json", "scaler.npz") or p.name.startswith("seed"))]


def save_model_to_db(cur, code, kind):
    files = _model_files(code, kind)
    if not any(p.name == "meta.json" for p in files):
        return
    cur.execute("DELETE FROM model_files WHERE aux_code=%s AND kind=%s", (code, kind))
    for p in files:
        cur.execute("INSERT INTO model_files (aux_code, kind, name, data) VALUES (%s,%s,%s,%s)",
                    (code, kind, p.name, psycopg2.Binary(p.read_bytes())))


def restore_models_from_db(cur):
    """Put back any model in the database that is newer than the one in the app folder."""
    cur.execute("SELECT aux_code, kind, data FROM model_files WHERE name='meta.json'")
    for r in cur.fetchall():
        code, kind = r["aux_code"], r["kind"]
        db_meta = json.loads(bytes(r["data"]))
        disk = pe.model_info(code, kind)
        if disk and str(disk.get("trained_at") or "") >= str(db_meta.get("trained_at") or ""):
            continue
        cur.execute("SELECT name, data FROM model_files WHERE aux_code=%s AND kind=%s", (code, kind))
        files = {f["name"]: bytes(f["data"]) for f in cur.fetchall()}
        d = pe.model_path(code, kind)
        d.mkdir(parents=True, exist_ok=True)
        for old in d.glob("seed*.keras"):
            old.unlink()
        for name, data in files.items():
            if name != "meta.json":
                (d / name).write_bytes(data)
        (d / "meta.json").write_bytes(files["meta.json"])        # last: the model counts as present only when complete
        pe._cache.pop((code.upper(), kind), None)
        log.info("restored %s/%s model %s from the database", code, kind, db_meta.get("version"))


# deciding and training
def _status(cur, aux_id, kind, text):
    cur.execute("""INSERT INTO model_auto_train (aux_id, kind, last_attempt, last_status) VALUES (%s,%s,now(),%s)
                   ON CONFLICT (aux_id, kind) DO UPDATE SET last_attempt=now(), last_status=EXCLUDED.last_status""",
                (aux_id, kind, text[:500]))


def _due(cur, aux_id, code, kind):
    cur.execute("""SELECT 1 FROM model_auto_train WHERE aux_id=%s AND kind=%s
                   AND last_attempt > now() - make_interval(days => %s)""", (aux_id, kind, INTERVAL_DAYS))
    if cur.fetchone():
        return False                                   # tried (trained or skipped) less than INTERVAL_DAYS ago
    info = pe.model_info(code, kind)
    if not info or not info.get("trained_at"):
        return True
    try:
        trained_at = datetime.fromisoformat(info["trained_at"])
    except ValueError:
        return True
    return datetime.now() - trained_at >= timedelta(days=INTERVAL_DAYS)


def train_one(db, aux_id, code, kind):
    cur = db.cursor()
    info = pe.model_info(code, kind)
    series = pe.load_series(cur, aux_id, kind)
    if info and len(series) and str(series["date"].max().date()) <= str(info.get("trained_through")):
        _status(cur, aux_id, kind, f"skipped: no new sales since {info.get('trained_through')}")
        db.commit()
        return
    try:
        log.info("auto-training %s/%s ...", code, kind)
        m = pe.train(cur, aux_id, code, kind, seeds=SEEDS, epochs=EPOCHS, fetch_weather=True, log=log.info)
    except pe.PredictionError as e:                    # not enough data yet: try again next interval
        db.rollback()
        _status(cur, aux_id, kind, f"not trained: {e}")
        db.commit()
        return
    except Exception as e:
        db.rollback()
        log.exception("auto-training %s/%s failed", code, kind)
        _status(cur, aux_id, kind, f"failed: {type(e).__name__}: {e}")
        db.commit()
        return
    cur.execute("""INSERT INTO model_runs (aux_id, algorithm, version, train_to, epochs, window_days, mape, is_active, notes)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,FALSE,%s)""",
                (aux_id, f"LSTM ({kind})", m["version"], m["trained_through"], EPOCHS, m["window"], m["wape_lstm"],
                 f"auto ({INTERVAL_DAYS}-day) {kind}: validation WAPE {m['wape_lstm']}% (item average {m['wape_item_average']}%); weather: {m['weather_source']}"))
    save_model_to_db(cur, code, kind)
    _status(cur, aux_id, kind, f"trained {m['version']} through {m['trained_through']} (WAPE {m['wape_lstm']}%)")
    db.commit()
    log.info("auto-trained %s/%s -> %s", code, kind, m["version"])


def run_once():
    db = connect()
    try:
        cur = db.cursor()
        pe.ensure_tables(cur)
        ensure_tables(cur)
        db.commit()
        restore_models_from_db(cur)
        cur.execute("SELECT pg_try_advisory_lock(%s) AS ok", (LOCK_KEY,))
        if not cur.fetchone()["ok"]:
            return                                     # another server is training right now
        try:
            cur.execute("SELECT aux_id, code FROM auxiliaries WHERE is_active ORDER BY aux_id")
            for aux in cur.fetchall():
                for kind in pe.KINDS:
                    if _due(cur, aux["aux_id"], aux["code"].upper(), kind):
                        train_one(db, aux["aux_id"], aux["code"].upper(), kind)
        finally:
            cur.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))
            db.commit()
    finally:
        db.close()


def _loop():
    try:                                               # put back the newest saved model straight away
        db = connect()
        try:
            cur = db.cursor()
            ensure_tables(cur)
            db.commit()
            restore_models_from_db(cur)
        finally:
            db.close()
    except Exception:
        log.exception("could not restore models from the database")
    time.sleep(START_DELAY_S)
    while True:
        try:
            run_once()
        except Exception:
            log.exception("automatic retraining check failed")
        time.sleep(CHECK_EVERY_S)


def start():
    """Start the background retraining once per process (no-op afterwards, or when AUTO_TRAIN=0)."""
    global _started
    if _started or os.getenv("AUTO_TRAIN", "1") == "0":
        return
    with _start_lock:
        if _started:
            return
        _started = True
        if not log.handlers:                           # show progress in the server log (gunicorn / python app.py)
            h = logging.StreamHandler()
            h.setFormatter(logging.Formatter("%(asctime)s [auto-train] %(message)s"))
            log.addHandler(h)
            log.setLevel(logging.INFO)
        threading.Thread(target=_loop, name="auto-train", daemon=True).start()

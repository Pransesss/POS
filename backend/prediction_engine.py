"""LSTM prediction for one canteen, one date, the dishes/snacks the staff pick.

This is the notebook's "rotating menu" model moved into the system. Output = the notebook's Section 7 table:
    item, prediction_for, predicted_qty, last_3school_day_avg, exam_day, event_day, method

How it works (same as the notebook):
  * Every item's series uses only the days it was OFFERED (the menu rotates, a missing day is not zero sales).
  * The LSTM predicts a ratio (sales / the item's long-run average) from the item's last 3 offered days,
    the weekday, exam/event flags and Open-Meteo weather. 3 networks with different seeds are averaged.
  * The model does not guess the menu. Staff choose which items they want a prediction for.
  * Items with too little history get a plain average (pulled toward a typical item) and the `method` column says so.

History comes from `sales_history` (imported CSVs, see import_history.py) plus the live POS data
(stock_movements) for products ticked "use for prediction". Live data wins when both have the same day.
"""
import json
import os
import threading
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

import weather as wx

MODEL_DIR = Path(os.getenv("MODEL_DIR", Path(__file__).parent / "models"))
WINDOW = 3                    # past OFFERED days the LSTM sees
LEVEL_K = 2                   # an item's long-run level counts as k extra "typical item" days
STOCKOUT_WEIGHT = 0.3         # sold-out days understate demand, so they count less when training
TRAIN_FRAC = 0.80
MIN_ACTIVE_FLOOR = 10
KINDS = ("snacks", "meals")

# Meal servings in the POS (products.meal_key) -> component names used in the CSV history
MEAL_ALIASES = {"rice": "Rice", "pork": "Pork", "beef": "Beef", "chicken": "Chicken @99", "fish": "Fish", "veg": "Veggies"}

CTX_COLS = ["dow_sin", "dow_cos", "is_exam", "is_event"] + wx.WEATHER_VARS
SEQ_COLS = ["y", "roll", "left", "rcvd", "stockout", "offered"] + CTX_COLS
QTY_SEQ = ["y", "roll", "left", "rcvd"]
MODEL_CTX = CTX_COLS + ["offered"]

_lock = threading.Lock()
_cache = {}                   # (aux_code, kind) -> (mtime, loaded model dict)


class PredictionError(Exception):
    pass


# small helpers
def shrunk_level(total, n, pool):
    return (total + LEVEL_K * pool) / (n + LEVEL_K)


def next_school_day(d):
    d = d + timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def model_path(aux_code, kind):
    return MODEL_DIR / aux_code.upper() / kind


def model_info(aux_code, kind):
    """What is saved for this canteen/kind (None when the model has not been trained yet)."""
    f = model_path(aux_code, kind) / "meta.json"
    if not f.exists():
        return None
    m = json.loads(f.read_text())
    return {k: m.get(k) for k in ("version", "trained_at", "trained_through", "n_items", "items", "window",
                                    "wape_lstm", "wape_item_average", "weather_source")}


# data
def ensure_tables(cur):
    """Create prediction tables on a database that was set up before they existed (schema.sql has them too)."""
    cur.execute("""CREATE TABLE IF NOT EXISTS sales_history (
        history_id SERIAL PRIMARY KEY,
        aux_id INTEGER NOT NULL REFERENCES auxiliaries(aux_id),
        category TEXT NOT NULL CHECK (category IN ('snacks','meals')),
        item_name TEXT NOT NULL, business_date DATE NOT NULL,
        prepared_qty NUMERIC(10,2), sold_qty NUMERIC(10,2) NOT NULL, left_qty NUMERIC(10,2), unit_price NUMERIC(10,2),
        UNIQUE (aux_id, category, item_name, business_date))""")
    cur.execute("CREATE INDEX IF NOT EXISTS sales_history_idx ON sales_history (aux_id, category, business_date)")
    wx.ensure_table(cur)


def load_series(cur, aux_id, kind, before=None):
    """One row per item per day it was offered: date, item, y (sold), left, rcvd, stockout.
    `before` keeps only dates strictly earlier than that day (so a prediction never sees its own day)."""
    cur.execute("""SELECT business_date AS date, item_name AS item, sold_qty AS y, left_qty AS "left", prepared_qty AS rcvd
                   FROM sales_history WHERE aux_id=%s AND category=%s AND EXTRACT(ISODOW FROM business_date) < 6""",
                (aux_id, kind))
    hist = pd.DataFrame(cur.fetchall(), columns=["date", "item", "y", "left", "rcvd"])

    # live POS data (only completed days, never today) for products ticked "use for prediction"
    cat = "Snacks" if kind == "snacks" else "Meals"
    cur.execute("""
        SELECT m.business_date AS date, p.name, p.meal_key,
               COALESCE(SUM(-m.qty) FILTER (WHERE m.movement_type='sale'), 0) AS y,
               COALESCE(SUM(m.qty)  FILTER (WHERE m.movement_type='delivery'), 0) AS rcvd
        FROM stock_movements m JOIN products p ON p.product_id = m.product_id
        WHERE m.aux_id=%s AND p.category=%s AND p.use_for_prediction AND m.business_date < CURRENT_DATE
              AND EXTRACT(ISODOW FROM m.business_date) < 6
        GROUP BY m.business_date, p.name, p.meal_key""", (aux_id, cat))
    live = pd.DataFrame(cur.fetchall(), columns=["date", "name", "meal_key", "y", "rcvd"])
    if len(live):
        live["item"] = [MEAL_ALIASES.get(k, n) if kind == "meals" else n for n, k in zip(live["name"], live["meal_key"])]
        live = live[(live["y"] > 0) | (live["rcvd"] > 0)].copy()                 # on the menu that day
        live["left"] = (live["rcvd"] - live["y"]).clip(lower=0)                 # estimate: delivered - sold
        live = live[["date", "item", "y", "left", "rcvd"]]
        hist = hist[~hist.set_index(["date", "item"]).index.isin(live.set_index(["date", "item"]).index)]
        hist = pd.concat([hist, live], ignore_index=True)
    if hist.empty:
        return pd.DataFrame(columns=["date", "item", "y", "left", "rcvd", "stockout"])
    for c in ("y", "left", "rcvd"):
        hist[c] = pd.to_numeric(hist[c], errors="coerce").astype(float)
    hist["date"] = pd.to_datetime(hist["date"])
    hist["item"] = hist["item"].astype(str).str.strip()
    hist["left"] = hist["left"].fillna(0.0)
    hist["rcvd"] = hist["rcvd"].fillna(0.0)
    hist = hist.dropna(subset=["y"]).groupby(["date", "item"], as_index=False).agg(y=("y", "sum"), left=("left", "sum"), rcvd=("rcvd", "sum"))
    hist["stockout"] = ((hist["left"] <= 0) & (hist["y"] > 0)).astype(float)
    if before is not None:
        hist = hist[hist["date"] < pd.Timestamp(before)]
    return hist.sort_values(["item", "date"]).reset_index(drop=True)


def open_days(cur, aux_id, before=None):
    """Mon-Fri days the canteen recorded sales (snacks or meals)."""
    d = set()
    for kind in KINDS:
        s = load_series(cur, aux_id, kind, before)
        d |= set(s["date"].unique())
    return pd.DatetimeIndex(sorted(d))


def calendar_flags(cur, dates):
    """Return exam and campus-event flags; no_classes events do not set either flag."""
    dates = pd.to_datetime(pd.Series(list(dates))).dt.normalize()
    cur.execute("SELECT event_date, event_type FROM events")
    ev = cur.fetchall()
    exam = {pd.Timestamp(r["event_date"]) for r in ev if r["event_type"] == "exam"}
    evt = {pd.Timestamp(r["event_date"]) for r in ev if r["event_type"] in ("event", "other")}
    return dates.isin(exam).astype(int).to_numpy(), dates.isin(evt).astype(int).to_numpy()


def context_table(cur, dates, fill, fetch_weather=True, log=print):
    """Calendar + weather features for the given dates. `fill` = weather values used when a day has none."""
    dates = pd.DatetimeIndex(sorted(set(pd.to_datetime(list(dates)))))
    out = pd.DataFrame({"date": dates})
    dow = out["date"].dt.day_of_week
    out["dow_sin"], out["dow_cos"] = np.sin(2 * np.pi * dow / 5), np.cos(2 * np.pi * dow / 5)
    out["is_exam"], out["is_event"] = calendar_flags(cur, dates)
    w = wx.get_weather(cur, dates.min().date(), dates.max().date(), fetch=fetch_weather, log=log) if len(dates) else {}
    for v in wx.WEATHER_VARS:
        out[v] = [w.get(d.date(), {}).get(v, np.nan) for d in dates]
    n_missing = int(out[wx.WEATHER_VARS[0]].isna().sum())
    for v in wx.WEATHER_VARS:
        alt = fill.get(v) if fill else None
        if alt is None:
            alt = out[v].mean()
        out[v] = out[v].fillna(0.0 if pd.isna(alt) else float(alt))
    return out, n_missing


def add_features(series, ctx, pool):
    """Per item (offered days only): roll = mean of the previous 3 offered days, roll_off = long-run level."""
    s = series.sort_values(["item", "date"]).copy()
    g = s.groupby("item")
    s["roll"] = g["y"].transform(lambda x: x.shift(1).rolling(WINDOW, min_periods=1).mean())
    n_prev = g.cumcount()
    prev_sum = g["y"].cumsum() - s["y"]
    s["roll_off"] = shrunk_level(prev_sum, n_prev, pool)
    s["roll"] = s["roll"].fillna(s["roll_off"])
    s["offered"] = 1.0
    return s.merge(ctx, on="date", how="left").reset_index(drop=True)


def apply_scaler(sc, S, C):
    return (S - sc["s_mu"]) / sc["s_sd"], (C - sc["c_mu"]) / sc["c_sd"]


# the network
def _keras():
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    import keras
    from keras import layers, models
    return keras, layers, models


def build_lstm(n_seq, n_ctx, n_items, units=8, l2=3e-3, dropout=0.3):
    keras, layers, models = _keras()
    reg = keras.regularizers.l2(l2)
    seq_in = layers.Input((WINDOW, n_seq)); ctx_in = layers.Input((n_ctx,)); item_in = layers.Input((1,), dtype="int32")
    x = layers.Dropout(dropout)(layers.LSTM(units, kernel_regularizer=reg, recurrent_regularizer=reg)(seq_in))
    e = layers.Flatten()(layers.Embedding(n_items, 4, embeddings_regularizer=reg)(item_in))
    h = layers.Dense(8, activation="relu", kernel_regularizer=reg)(layers.Concatenate()([x, ctx_in, e]))
    out = layers.Dense(1, dtype="float32", kernel_regularizer=reg, kernel_initializer="zeros",
                       bias_initializer=keras.initializers.Constant(1.0))(layers.Dropout(dropout / 2)(h))
    m = models.Model([seq_in, ctx_in, item_in], out)
    m.compile(optimizer=keras.optimizers.Adam(1e-3), loss="mae")
    return m


def wape(y, p):
    y, p = np.asarray(y, float), np.asarray(p, float)
    return float(100 * np.abs(y - p).sum() / max(np.abs(y).sum(), 1e-9)) if len(y) else float("nan")


# training
def train(cur, aux_id, aux_code, kind, seeds=3, epochs=150, fetch_weather=True, log=print):
    """Train the LSTM for one canteen and one kind (snacks | meals) and save it under models/<AUX>/<kind>/."""
    keras, _, _ = _keras()
    callbacks = keras.callbacks
    base_all = load_series(cur, aux_id, kind)
    if base_all.empty:
        raise PredictionError(f"No {kind} history for {aux_code}. Run import_history.py first.")
    days = open_days(cur, aux_id)
    n_sd = len(days)
    if n_sd < WINDOW + 20:
        raise PredictionError(f"Only {n_sd} school days of data; need at least {WINDOW + 20}.")
    val_start = pd.Timestamp(days[min(max(int(round(n_sd * TRAIN_FRAC)), 1), n_sd - 1)])
    min_active = max(MIN_ACTIVE_FLOOR, int(round(0.15 * n_sd)))

    stats = base_all.groupby("item")["y"].agg(n="size", mean="mean")
    active = base_all[base_all.y > 0].groupby("item").size()
    keep = active[active >= min_active].index
    skipped = sorted(set(active.index) - set(keep))
    if len(keep) < 2:
        raise PredictionError(f"Only {len(keep)} {kind} item(s) have {min_active}+ active days; not enough to train.")
    base = base_all[base_all["item"].isin(keep)]
    pool = float(base[base["date"] < val_start].groupby("item")["y"].mean().median())
    pool = pool if np.isfinite(pool) and pool > 0 else 1.0

    # weather for every school day (cached in the DB; fetched from Open-Meteo once)
    w = wx.get_weather(cur, days.min().date(), days.max().date(), fetch=fetch_weather, log=log)
    have = {v: float(np.mean([r[v] for r in w.values()])) for v in wx.WEATHER_VARS} if w else {}
    ctx, n_missing = context_table(cur, days, have, fetch_weather=False)
    weather_source = "Open-Meteo" if not n_missing else (
        f"Open-Meteo for {n_sd - n_missing} of {n_sd} days" if n_missing < n_sd else "NONE (average used: weather was not reachable)")
    if n_missing:
        log(f"!! weather missing for {n_missing} of {n_sd} school days; the average of the others is used")
        if not have:
            log("!! no weather at all: the model will train without usable weather information")
    fill = {v: float(ctx[v].mean()) for v in wx.WEATHER_VARS}
    feat = add_features(base, ctx, pool)

    classes = sorted(feat["item"].unique())
    idx = {c: i for i, c in enumerate(classes)}
    S, C, I, Y, D, OF, SO, RO = [], [], [], [], [], [], [], []
    for item, g in feat.groupby("item"):
        g = g.sort_values("date").reset_index(drop=True)
        sv, cv = g[SEQ_COLS].to_numpy("float32"), g[MODEL_CTX].to_numpy("float32")
        for i in range(WINDOW, len(g)):
            S.append(sv[i - WINDOW:i]); C.append(cv[i]); I.append(idx[item]); Y.append(g["y"].iloc[i])
            D.append(g["date"].iloc[i]); SO.append(g["stockout"].iloc[i]); RO.append(g["roll_off"].iloc[i])
    S, C, I = np.array(S), np.array(C), np.array(I, dtype="int32")
    Y, D, SO, RO = (np.array(Y, "float32"), np.array(D, "datetime64[ns]"), np.array(SO, "float32"), np.array(RO, "float32"))
    tr, va = D < np.datetime64(val_start), D >= np.datetime64(val_start)
    if not tr.any() or not va.any():
        raise PredictionError("Train or validation split is empty; add more history.")
    so = SO > 0

    item_scale = feat[feat["date"] < val_start].groupby("item")["y"].mean().reindex(classes).fillna(1.0).clip(lower=1.0).to_dict()
    level = np.where(RO > 0, RO, np.array([item_scale[classes[i]] for i in I], "float32")).clip(min=1.0).astype("float32")
    S_raw = S.copy()
    S_raw[:, :, [SEQ_COLS.index(q) for q in QTY_SEQ]] /= level[:, None, None]
    flat = S_raw[tr].reshape(-1, S_raw.shape[-1])
    sc = {"s_mu": flat.mean(0), "s_sd": flat.std(0) + 1e-6, "c_mu": C[tr].mean(0), "c_sd": C[tr].std(0) + 1e-6}
    Sx, Cx = apply_scaler(sc, S_raw, C)
    y_rel = (Y / level).astype("float32")
    base_w = np.clip(level / level[tr].mean(), 0.2, 5.0)
    w_tr = (base_w * np.where(so, STOCKOUT_WEIGHT, 1.0)).astype("float32")
    w_va = base_w.astype("float32")
    log(f"[{aux_code}/{kind}] items={len(classes)} school days={n_sd} train/val rows={tr.sum()}/{va.sum()} val starts {val_start.date()}")
    if skipped:
        log(f"[{aux_code}/{kind}] too rare to model (average used instead): {skipped}")

    out_dir = model_path(aux_code, kind)
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("seed*.keras"):
        old.unlink()
    rel = []
    for k in range(seeds):
        keras.utils.set_random_seed(42 + k)
        net = build_lstm(Sx.shape[-1], Cx.shape[-1], len(classes))
        h = net.fit([Sx[tr], Cx[tr], I[tr]], y_rel[tr], sample_weight=w_tr[tr],
                    validation_data=([Sx[va], Cx[va], I[va]], y_rel[va], w_va[va]),
                    epochs=epochs, batch_size=32, shuffle=True, verbose=0,
                    callbacks=[callbacks.EarlyStopping(patience=25, restore_best_weights=True),
                               callbacks.ReduceLROnPlateau(factor=0.5, patience=8, min_lr=1e-5)])
        log(f"[{aux_code}/{kind}] seed {k}: {len(h.history['loss'])} epochs")
        net.save(out_dir / f"seed{k}.keras")
        rel.append(net.predict([Sx[va], Cx[va], I[va]], verbose=0).ravel())
    p_lstm = np.clip(np.mean(rel, axis=0) * level[va], 0, None)
    w_l, w_a = wape(Y[va], p_lstm), wape(Y[va], RO[va])
    log(f"[{aux_code}/{kind}] validation WAPE: LSTM {w_l:.1f}%  |  item average {w_a:.1f}%")

    np.savez(out_dir / "scaler.npz", **sc)
    version = f"lstm-rot-{pd.Timestamp.now().strftime('%Y%m%d-%H%M')}"
    meta = {"version": version, "trained_at": pd.Timestamp.now().isoformat(timespec="seconds"),
            "trained_through": str(base_all["date"].max().date()), "val_start": str(val_start.date()),
            "items": classes, "n_items": len(classes), "skipped": skipped, "pool": pool, "item_scale": item_scale,
            "window": WINDOW, "seeds": seeds, "min_active_days": min_active, "n_school_days": n_sd,
            "wape_lstm": round(w_l, 2), "wape_item_average": round(w_a, 2), "weather_fill": fill,
            "weather_source": weather_source}
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    _cache.pop((aux_code.upper(), kind), None)
    return meta


# loading + predicting
def _load(aux_code, kind):
    f = model_path(aux_code, kind) / "meta.json"
    if not f.exists():
        return None
    key, mtime = (aux_code.upper(), kind), f.stat().st_mtime
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
        keras, _, _ = _keras()
        meta = json.loads(f.read_text())
        d = model_path(aux_code, kind)
        nets = [keras.models.load_model(p, compile=False) for p in sorted(d.glob("seed*.keras"))]
        if not nets:
            return None
        sc = dict(np.load(d / "scaler.npz"))
        loaded = {"meta": meta, "nets": nets, "scaler": sc}
        _cache[key] = (mtime, loaded)
        return loaded


def _predict_ratio(nets, S, C, I):
    """Average of the seed networks. Called directly: model.predict() on a batch of 1 fails on some TF builds."""
    keras, _, _ = _keras()
    outs = []
    for m in nets:
        raw = m([S.astype("float32"), C.astype("float32"), I.astype("int32")], training=False)
        outs.append(np.asarray(keras.ops.convert_to_numpy(raw), dtype="float64").reshape(-1))
    return np.clip(np.mean(outs, axis=0), 0, None)


def catalog(cur, aux_id, aux_code, kind, as_of=None):
    """Every item staff can pick: how much history it has, when it was last on the menu, and its usual quantity."""
    s = load_series(cur, aux_id, kind, before=as_of)
    model = _load(aux_code, kind) if model_info(aux_code, kind) else None
    modeled = set(model["meta"]["items"]) if model else set()
    days = open_days(cur, aux_id, before=as_of)
    recent = set(s[s["date"].isin(days[-5:])]["item"]) if len(days) else set()
    rows = []
    for item, g in s.groupby("item"):
        rows.append({"item": item, "days_recorded": int(len(g)), "last_date": str(g["date"].max().date()),
                     "last_qty": float(g["y"].iloc[-1]), "avg_qty": round(float(g["y"].mean()), 1),
                     "recent": item in recent, "modeled": item in modeled})
    rows.sort(key=lambda r: (-r["days_recorded"], r["item"]))
    return rows


def predict(cur, aux_id, aux_code, kind, target, items=None, log=print):
    """Section-7 prediction for one date. `items` = names to predict (None = every item with history)."""
    if kind not in KINDS:
        raise PredictionError("kind must be snacks or meals")
    if target.weekday() >= 5:
        raise PredictionError(f"{target.isoformat()} is a weekend; the canteen prediction covers Monday to Friday only.")
    cur.execute("SELECT name, event_type FROM events WHERE event_date=%s ORDER BY event_id", (target,))
    ev = cur.fetchall()

    series = load_series(cur, aux_id, kind, before=target)
    if series.empty:
        raise PredictionError(f"No {kind} history before {target.isoformat()} for {aux_code}.")
    known = set(series["item"])
    wanted = list(dict.fromkeys(str(i).strip() for i in items)) if items else sorted(known)

    is_exam = int(any(e["event_type"] == "exam" for e in ev))
    is_event = int(any(e["event_type"] in ("event", "other") for e in ev))
    W = WINDOW
    key_avg = f"last_{W}school_day_avg"
    last_data = series["date"].max().date()
    info = {"target": target.isoformat(), "kind": kind, "history_through": last_data.isoformat(),
            "days_since_history": (target - last_data).days, "event": [dict(e) for e in ev],
            "no_classes": any(e["event_type"] == "no_classes" for e in ev),
            "model": None, "weather_source": None, "warnings": []}

    def avg_last(item):
        g = series[series["item"] == item].tail(W)
        return round(float(g["y"].mean()), 1) if len(g) else None

    model = None
    try:
        model = _load(aux_code, kind)
    except Exception as e:                       # TensorFlow missing or a broken file: still answer, with averages
        info["warnings"].append(f"The LSTM could not be loaded ({type(e).__name__}); averages are shown instead.")
        log(f"model load failed: {e!r}")
    if model is None and not info["warnings"]:
        info["warnings"].append(f"No trained model for {aux_code} {kind} yet; averages are shown instead. Run: python train_model.py --aux {aux_code}")

    stats = series.groupby("item")["y"].agg(n="size", mean="mean")
    pool = float(model["meta"]["pool"]) if model else float(series.groupby("item")["y"].mean().median() or 1.0)
    k = float(LEVEL_K)

    rows_by_item = {}
    if model:
        meta, sc = model["meta"], model["scaler"]
        info["model"] = {"version": meta["version"], "trained_through": meta["trained_through"],
                         "wape_lstm": meta["wape_lstm"], "wape_item_average": meta["wape_item_average"]}
        classes = meta["items"]; idx = {c: i for i, c in enumerate(classes)}
        sub = series[series["item"].isin([i for i in wanted if i in idx])]
        if len(sub):
            # features for the whole history of the wanted items (weather only needed for their last W days)
            full_ctx, _ = context_table(cur, sub["date"].unique(), meta["weather_fill"], fetch_weather=False)
            feat = add_features(sub, full_ctx, pool)
            w, w_src = wx.weather_for_date(cur, target, log=log)
            info["weather_source"] = w_src
            if w is None:
                w = meta["weather_fill"]
                info["warnings"].append("Weather could not be loaded, so an average day was assumed.")
            elif w_src.startswith("recent average"):
                info["warnings"].append("Open-Meteo could not be reached; the recent average weather was used.")
            dow = target.weekday()
            c_row = {"dow_sin": np.sin(2 * np.pi * dow / 5), "dow_cos": np.cos(2 * np.pi * dow / 5),
                     "is_exam": is_exam, "is_event": is_event, **{v: float(w[v]) for v in wx.WEATHER_VARS}, "offered": 1.0}
            c_vec = np.array([[c_row[c] for c in MODEL_CTX]], dtype="float32")
            seqs, ctxs, iids, order = [], [], [], []
            for item, g in feat.groupby("item"):
                g = g.sort_values("date")
                if len(g) < W:
                    continue
                ys = g["y"]
                lvl = shrunk_level(float(ys.sum()), len(ys), pool)
                lvl = max(lvl if lvl > 0 else float(meta["item_scale"].get(item, 1.0)), 1.0)
                gt = g.tail(W).copy()
                for q in QTY_SEQ:
                    gt[q] = gt[q] / lvl
                Sx, Cx = apply_scaler(sc, gt[SEQ_COLS].to_numpy("float32")[None], c_vec)
                seqs.append(Sx); ctxs.append(Cx); iids.append(idx[item]); order.append((item, lvl))
            if seqs:
                p = _predict_ratio(model["nets"], np.concatenate(seqs), np.concatenate(ctxs),
                                   np.asarray(iids, "int32").reshape(-1, 1)) * np.array([o[1] for o in order])
                for (item, _l), v in zip(order, p):
                    rows_by_item[item] = {"item": item, "prediction_for": target.isoformat(), "predicted_qty": max(0.0, round(float(v), 1)),
                                          key_avg: avg_last(item), "exam_day": is_exam, "event_day": is_event, "method": "LSTM"}

    for item in wanted:                          # everything the LSTM did not cover: plain average, and say so
        if item in rows_by_item:
            continue
        if item in stats.index:
            n_, mu = float(stats.loc[item, "n"]), float(stats.loc[item, "mean"])
            v = (n_ * mu + k * pool) / (n_ + k)
            why = (f"fallback: average of {int(n_)} past days" if model else f"average of {int(n_)} past days (model not trained)")
        else:
            v, why = pool, "fallback: new item, typical item average"
        rows_by_item[item] = {"item": item, "prediction_for": target.isoformat(), "predicted_qty": max(0.0, round(float(v), 1)),
                              key_avg: avg_last(item), "exam_day": is_exam, "event_day": is_event, "method": why}
    return [rows_by_item[i] for i in wanted], info


def actuals_for(cur, aux_id, kind, target):
    """What was really sold on `target` (when it is already recorded), for a side-by-side check."""
    s = load_series(cur, aux_id, kind)
    s = s[s["date"] == pd.Timestamp(target)]
    return {r.item: float(r.y) for r in s.itertuples()}

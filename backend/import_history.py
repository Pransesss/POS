"""Load the typed canteen CSVs (and the school calendar) into the database for the forecast model.

    python import_history.py --aux CAS --snacks Snacks_SY2025-26.csv --meals Meals_SY2025-26.csv --calendar calendar.csv

Columns: Date,Day,School_Year,Semester,Item,Prepared_Qty,Sold_Qty,Left_Qty,Unit_Price,Total_Sale   (Date = M/D/YYYY or YYYY-MM-DD)
Calendar: date,event_type,description   (event_type: exam | event)

Safe to run again: a day/item that is already there is updated, not duplicated.
Each canteen (CAS, COE ...) has its own history, so run it once per canteen with that canteen's files.
"""
import argparse
import sys

import pandas as pd

from db import connect
import forecast_engine as fe


def parse_dates(s):
    s = pd.Series(s)
    out = pd.to_datetime(s, format="%m/%d/%Y", errors="coerce")
    miss = out.isna() & s.notna()
    if miss.any():
        out[miss] = pd.to_datetime(s[miss], errors="coerce")
    return out


def load_csv(path, category):
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    need = {"date", "item", "sold_qty"}
    if not need <= set(df.columns):
        sys.exit(f"{path}: needs the columns Date, Item, Sold_Qty (found {list(df.columns)})")
    out = pd.DataFrame({"business_date": parse_dates(df["date"]), "item_name": df["item"].astype(str).str.strip(),
                        "prepared_qty": pd.to_numeric(df.get("prepared_qty"), errors="coerce"),
                        "sold_qty": pd.to_numeric(df["sold_qty"], errors="coerce"),
                        "left_qty": pd.to_numeric(df.get("left_qty"), errors="coerce"),
                        "unit_price": pd.to_numeric(df.get("unit_price"), errors="coerce")})
    bad = out["business_date"].isna() | out["sold_qty"].isna() | (out["item_name"] == "")
    if bad.any():
        print(f"  skipped {int(bad.sum())} unreadable rows in {path}")
    out = out[~bad]
    wk = out["business_date"].dt.day_of_week >= 5
    if wk.any():
        print(f"  skipped {int(wk.sum())} Saturday/Sunday rows (the canteen forecast is Mon-Fri)")
    out = out[~wk].copy()
    out["category"] = category
    # the same item twice on one day (e.g. two slips) -> add the quantities
    return out.groupby(["category", "item_name", "business_date"], as_index=False).agg(
        prepared_qty=("prepared_qty", "sum"), sold_qty=("sold_qty", "sum"), left_qty=("left_qty", "sum"), unit_price=("unit_price", "last"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aux", required=True, help="canteen code, e.g. CAS")
    ap.add_argument("--snacks"); ap.add_argument("--meals"); ap.add_argument("--calendar")
    a = ap.parse_args()
    if not (a.snacks or a.meals or a.calendar):
        sys.exit("Give at least one of --snacks / --meals / --calendar")
    with connect() as db:
        cur = db.cursor()
        fe.ensure_tables(cur)
        cur.execute("SELECT aux_id FROM auxiliaries WHERE code=%s", (a.aux.upper(),))
        aux = cur.fetchone()
        if not aux:
            cur.execute("SELECT code FROM auxiliaries ORDER BY code")
            sys.exit(f"No canteen with code {a.aux}. Existing: " + ", ".join(r["code"] for r in cur.fetchall()))
        aid = aux["aux_id"]
        for path, cat in ((a.snacks, "snacks"), (a.meals, "meals")):
            if not path:
                continue
            df = load_csv(path, cat)
            rows = [(aid, r.category, r.item_name, r.business_date.date(), None if pd.isna(r.prepared_qty) else r.prepared_qty,
                     r.sold_qty, None if pd.isna(r.left_qty) else r.left_qty, None if pd.isna(r.unit_price) else r.unit_price)
                    for r in df.itertuples()]
            cur.executemany("""INSERT INTO sales_history (aux_id, category, item_name, business_date, prepared_qty, sold_qty, left_qty, unit_price)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                               ON CONFLICT (aux_id, category, item_name, business_date) DO UPDATE SET
                               prepared_qty=EXCLUDED.prepared_qty, sold_qty=EXCLUDED.sold_qty, left_qty=EXCLUDED.left_qty, unit_price=EXCLUDED.unit_price""", rows)
            print(f"{cat}: {len(rows)} rows, {df['item_name'].nunique()} items, {df['business_date'].min().date()} -> {df['business_date'].max().date()}")
        if a.calendar:
            cal = pd.read_csv(a.calendar)
            cal.columns = [c.strip().lower() for c in cal.columns]
            cal["date"] = pd.to_datetime(cal["date"], errors="coerce")
            cal = cal.dropna(subset=["date"])
            n = 0
            for r in cal.itertuples():
                t = str(r.event_type).strip().lower()
                t = t if t in ("exam", "event", "no_classes") else "event"
                name = (str(getattr(r, "description", "") or "").strip() or t.title())
                cur.execute("SELECT 1 FROM events WHERE event_date=%s AND event_type=%s AND name=%s", (r.date.date(), t, name))
                if not cur.fetchone():
                    cur.execute("INSERT INTO events (name, event_type, event_date, notes) VALUES (%s,%s,%s,%s)",
                                (name, t, r.date.date(), "imported from calendar.csv"))
                    n += 1
            print(f"calendar: {n} new exam/event days added ({len(cal) - n} already there)")
        db.commit()


if __name__ == "__main__":
    main()

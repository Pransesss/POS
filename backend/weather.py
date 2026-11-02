"""Open-Meteo weather for the forecast model (same rules as the notebook).

Past days come from the archive API, today/future days from the forecast API.
Every day that was fetched is cached in the `weather_daily` table, so training and predicting never ask twice.
If the service cannot be reached the caller gets a clear 'source' text instead of a crash.
"""
import os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import requests

LAT = float(os.getenv("CAMPUS_LAT", "18.0575"))      # MMSU Batac campus (same as the notebook)
LON = float(os.getenv("CAMPUS_LON", "120.5645"))
TZ = os.getenv("TIMEZONE", "Asia/Manila")
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
DAILY_VARS = ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "weather_code"]
RAIN_CODES = set(range(51, 68)) | set(range(71, 78)) | set(range(80, 83)) | set(range(85, 87)) | set(range(95, 100))
HOT_C, RAIN_MM, ARCHIVE_LAG_DAYS = 32.0, 1.0, 5
WEATHER_VARS = ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "is_rainy", "is_hot"]


def ensure_table(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS weather_daily (
        weather_date DATE PRIMARY KEY,
        temperature_2m_max NUMERIC(5,2), temperature_2m_min NUMERIC(5,2), precipitation_sum NUMERIC(6,2),
        weather_code INTEGER, is_rainy SMALLINT, is_hot SMALLINT,
        source TEXT NOT NULL DEFAULT 'archive',
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())""")


def _classify(tmax, precip, code):
    code = int(code) if code is not None else 0
    precip = float(precip) if precip is not None else 0.0
    is_rainy = int(precip >= RAIN_MM or code in RAIN_CODES)
    is_hot = int(tmax is not None and float(tmax) >= HOT_C)
    return is_rainy, is_hot


def _fetch_range(url, start, end, timeout=8):
    r = requests.get(url, timeout=timeout, params={
        "latitude": LAT, "longitude": LON, "start_date": start.isoformat(), "end_date": end.isoformat(),
        "daily": ",".join(DAILY_VARS), "timezone": TZ})
    r.raise_for_status()
    d = r.json().get("daily")
    if not d:
        raise RuntimeError("Open-Meteo returned no daily data")
    out = []
    for i, day in enumerate(d["time"]):
        tmax, tmin, pr, code = (d[k][i] for k in DAILY_VARS)
        if tmax is None:
            continue
        rainy, hot = _classify(tmax, pr, code)
        out.append({"weather_date": date.fromisoformat(day), "temperature_2m_max": tmax, "temperature_2m_min": tmin,
                    "precipitation_sum": pr or 0.0, "weather_code": code, "is_rainy": rainy, "is_hot": hot})
    return out


def fetch_online(start, end):
    """Archive for old days, forecast API for the last few days and the future. Returns (rows, source_by_date)."""
    today = datetime.now(ZoneInfo(TZ)).date()
    archive_latest = today - timedelta(days=ARCHIVE_LAG_DAYS)
    rows = []
    if start <= min(end, archive_latest):
        rows += [dict(r, source="archive") for r in _fetch_range(ARCHIVE_URL, start, min(end, archive_latest))]
    fc_start = max(start, archive_latest + timedelta(days=1))
    if fc_start <= end:
        rows += [dict(r, source="forecast") for r in _fetch_range(FORECAST_URL, fc_start, end)]
    return rows


def _store(cur, rows):
    for r in rows:
        cur.execute("""INSERT INTO weather_daily (weather_date, temperature_2m_max, temperature_2m_min, precipitation_sum,
                         weather_code, is_rainy, is_hot, source)
                       VALUES (%(weather_date)s,%(temperature_2m_max)s,%(temperature_2m_min)s,%(precipitation_sum)s,
                         %(weather_code)s,%(is_rainy)s,%(is_hot)s,%(source)s)
                       ON CONFLICT (weather_date) DO UPDATE SET temperature_2m_max=EXCLUDED.temperature_2m_max,
                         temperature_2m_min=EXCLUDED.temperature_2m_min, precipitation_sum=EXCLUDED.precipitation_sum,
                         weather_code=EXCLUDED.weather_code, is_rainy=EXCLUDED.is_rainy, is_hot=EXCLUDED.is_hot,
                         source=EXCLUDED.source, fetched_at=now()""", r)


def _cached(cur, start, end):
    cur.execute("""SELECT weather_date, temperature_2m_max, temperature_2m_min, precipitation_sum, is_rainy, is_hot, source
                   FROM weather_daily WHERE weather_date BETWEEN %s AND %s""", (start, end))
    return {r["weather_date"]: {**{k: float(r[k]) for k in WEATHER_VARS}, "source": r["source"]} for r in cur.fetchall()}


def get_weather(cur, start, end, fetch=True, log=print):
    """{date: {weather vars, source}} for start..end from the cache; missing days are fetched once if `fetch`.
    A day cached from the *forecast* API is fetched again after it has become an archive day."""
    ensure_table(cur)
    have = _cached(cur, start, end)
    today = date.today()
    stale = lambda d: have[d]["source"] == "forecast" and d <= today - timedelta(days=ARCHIVE_LAG_DAYS)
    missing = [d for d in (start + timedelta(n) for n in range((end - start).days + 1))
               if d not in have or stale(d)]
    if missing and fetch:
        try:
            rows = fetch_online(min(missing), max(missing))
            _store(cur, rows)
            have.update(_cached(cur, start, end))
        except Exception as e:                     # offline, blocked, timeout ...
            log(f"weather: Open-Meteo not reachable ({type(e).__name__}); using cached/average values")
    return have


def weather_for_date(cur, target, log=print):
    """Weather for one date -> (vars dict, source text). Falls back to the recent cached school-week average."""
    got = get_weather(cur, target, target, log=log).get(target)
    if got:
        return {k: got[k] for k in WEATHER_VARS}, ("Open-Meteo " + ("forecast" if got["source"] == "forecast" else "archive"))
    cur.execute("""SELECT AVG(temperature_2m_max) tmax, AVG(temperature_2m_min) tmin, AVG(precipitation_sum) pr,
                          AVG(is_rainy) rainy, AVG(is_hot) hot FROM (
                     SELECT * FROM weather_daily WHERE weather_date < %s ORDER BY weather_date DESC LIMIT 5) t""", (target,))
    r = cur.fetchone()
    if r and r["tmax"] is not None:
        return ({"temperature_2m_max": float(r["tmax"]), "temperature_2m_min": float(r["tmin"]),
                 "precipitation_sum": float(r["pr"]), "is_rainy": float(r["rainy"]), "is_hot": float(r["hot"])},
                "recent average (weather service unreachable)")
    return None, "no weather available (training average used)"

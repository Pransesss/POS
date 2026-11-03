"""Train the prediction model for one canteen.

    python train_model.py --aux CAS              # snacks and meals
    python train_model.py --aux CAS --kind snacks
    python train_model.py --aux CAS --no-weather  # no internet: weather = average (testing only)

Needs history first (python import_history.py ...). Takes a few minutes on a normal laptop.
Saves the network under backend/models/<CANTEEN>/<kind>/ and writes one line per run into `model_runs`
(is_active stays FALSE: the Prediction page uses the saved model directly, the dashboard keeps its own switch).
Retrain whenever a few weeks of new sales have been added.
"""
import argparse

from db import connect
import prediction_engine as pe


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aux", required=True)
    ap.add_argument("--kind", default="both", choices=["snacks", "meals", "both"])
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--epochs", type=int, default=150)
    ap.add_argument("--no-weather", action="store_true", help="do not call Open-Meteo (testing only)")
    a = ap.parse_args()
    with connect() as db:
        cur = db.cursor()
        pe.ensure_tables(cur)
        cur.execute("SELECT aux_id FROM auxiliaries WHERE code=%s", (a.aux.upper(),))
        aux = cur.fetchone()
        if not aux:
            raise SystemExit(f"No canteen with code {a.aux}")
        db.commit()
        for kind in (pe.KINDS if a.kind == "both" else [a.kind]):
            m = pe.train(cur, aux["aux_id"], a.aux.upper(), kind, seeds=a.seeds, epochs=a.epochs, fetch_weather=not a.no_weather)
            cur.execute("""INSERT INTO model_runs (aux_id, algorithm, version, train_to, epochs, window_days, mape, is_active, notes)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,FALSE,%s)""",
                        (aux["aux_id"], f"LSTM ({kind})", m["version"], m["trained_through"], a.epochs, m["window"], m["wape_lstm"],
                         f"{kind}: validation WAPE {m['wape_lstm']}% (item average {m['wape_item_average']}%); weather: {m['weather_source']}"))
            db.commit()
            print(f"  -> saved {kind}: WAPE LSTM {m['wape_lstm']}% vs item average {m['wape_item_average']}%\n")


if __name__ == "__main__":
    main()

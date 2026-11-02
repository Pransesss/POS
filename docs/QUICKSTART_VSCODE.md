# Quick start + VS Code port forwarding (testing)

1. Install Python 3.12, PostgreSQL, VS Code.
2. Database (psql): `CREATE USER mmsu WITH PASSWORD 'mmsu123'; CREATE DATABASE mmsu OWNER mmsu;`
3. Terminal in `backend/`:
   ```
   python -m venv venv
   venv\Scripts\activate            (Mac/Linux: source venv/bin/activate)
   pip install -r requirements.txt
   python init_db.py
   python import_history.py --aux CAS --snacks Snacks_SY2025-26.csv --meals Meals_SY2025-26.csv --calendar calendar.csv
   python train_model.py --aux CAS
   python app.py
   ```
   (put the 3 CSV files in `backend/` first). Open http://localhost:5000
4. VS Code > Ports tab > Forward a Port > 5000 > right-click > Port Visibility: Public.
   Share the forwarded address (https://...devtunnels.ms) with testers.
5. Change the default passwords (admin123 / cas123 / coe123) before sharing the link.
   Debug mode is off by default (set FLASK_DEBUG=1 only on your own computer).

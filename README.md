# MMSU Auxiliary POS

A Flask and PostgreSQL point-of-sale app for the CAS and COE canteens. Flask serves both the API and the web pages.

## Run locally

You need Python 3.12 and PostgreSQL installed and running.

1. Create a PostgreSQL user and an empty database:

   ```sql
   CREATE USER mmsu WITH PASSWORD 'choose-a-password';
   CREATE DATABASE mmsu OWNER mmsu;
   ```

2. In `backend/.env`, set your database connection and a private secret:

   ```env
   DATABASE_URL=postgresql://mmsu:choose-a-password@localhost:5432/mmsu
   SECRET_KEY=replace-with-a-long-random-value
   ```

   Keep this file private; do not commit it or share its values.

3. In PowerShell, install dependencies, initialize the empty database, and start the app:

   ```powershell
   cd backend
   python -m venv venv
   .\venv\Scripts\python.exe -m pip install -r requirements.txt
   .\venv\Scripts\python.exe init_db.py
   .\venv\Scripts\python.exe app.py
   ```

   Run `init_db.py` only once on a new database: it rebuilds the app tables and clears their data. Add `--demo` to create a sample delivery as well.

4. Open [http://localhost:5000](http://localhost:5000) and sign in:

   | Username | Password | Role |
   | --- | --- | --- |
   | `admin` | `admin123` | Admin |
   | `coe` | `coe123` | COE staff |
   | `cas` | `cas123` | CAS staff |

   Change these starter passwords in **Admin → Settings** before real use.

The trained prediction models are already in `backend/models`, so running the app does not require the training CSVs or retraining. The app can also show a moving-average prediction when it has sales history but no active model predictions.

For deployment or model retraining, see [docs/DEPLOY.md](docs/DEPLOY.md) and [docs/SETUP.md](docs/SETUP.md).

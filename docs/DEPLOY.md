# Deploy: Supabase (database) + Hugging Face Space (API) + Vercel (pages)

Never put the database password in a file that is committed. Use secrets/environment variables.

## 1. Supabase (once)
1. Project > Connect: copy the **Session pooler** string (the "direct" one is IPv6 only and may not be reachable from Hugging Face).
   Special characters in the password must be URL-encoded (`^` = `%5E`, `@` = `%40`, `[` = `%5B`). Do not keep the `[ ]` of the template.
2. From your computer, in `backend/`:
   ```
   export DATABASE_URL='postgresql://postgres.<ref>:<PASSWORD-ENCODED>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require'   # Windows PowerShell: $env:DATABASE_URL='...'
   python init_db.py                       # WIPES and creates all tables (run once on the new database)
   python import_history.py --aux CAS --snacks Snacks_SY2025-26.csv --meals Meals_SY2025-26.csv --calendar calendar.csv
   python train_model.py --aux CAS         # needs internet (Open-Meteo)
   ```
3. Change the seeded passwords (admin123 / cas123 / coe123) after the first login.

## 2. Hugging Face Space (API + pages)
1. Create a Space: SDK **Docker**, public.
2. Space repo = this repo's files. Copy `deploy/HF_SPACE_README.md` to the Space as `README.md`. Include `backend/models/` (the trained files from step 1.2): remove nothing from `.gitignore`, then `git add backend/models`.
3. Create a private [Storage Bucket](https://huggingface.co/new-bucket) for uploaded logos, then attach it to the Space as a **read-write volume** mounted at `/data`. See the [Spaces storage guide](https://huggingface.co/docs/hub/spaces-storage).
4. Space > Settings > Secrets: `DATABASE_URL` (the pooler string) and `SECRET_KEY` (any long random text). The Docker image sets `UPLOADS_DIR=/data/uploads`; keep that value so logo files are written to the mounted volume.
5. Wait for the build. API + pages: `https://<user>-<space>.hf.space`.

## 3. Vercel (pages only, optional)
1. In `mmsu-frontend/js/api.js` set `REMOTE_API = "https://<user>-<space>.hf.space"`.
2. Vercel > New Project > import the repo > Root Directory `mmsu-frontend`, no build command. Deploy.

The Space's local disk is ephemeral, so uploaded logos are stored in the mounted bucket instead. For local deployments, `UPLOADS_DIR` can point to another persistent directory; if unset, uploads remain in `backend/uploads`. When a legacy `backend/uploads` directory is available on first startup with a different `UPLOADS_DIR`, its files are copied once to the new location. Existing files on an already-deployed Space's ephemeral disk cannot be recovered after that disk resets; restore them from a backup or upload the logos again.

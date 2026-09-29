# Media List Builder

The existing StreetCred-inspired Media List Builder application. It includes Build Media List, Coverage Report, Admin / Data Management, Google Workspace OAuth, the canonical reporter directory, coverage linking, reporter diagnostics, and Google Sheet export.

## Run locally

1. Use Node.js 22 and run `npm install`.
2. Copy `.env.example` to `.env`; set the Google OAuth values and keep `PORT=3001` for the existing local URL.
3. In Google Cloud, enable Drive API and Sheets API and add `http://localhost:3001/oauth2callback` as an authorized redirect URI.
4. Run `npm start` (or `npm run dev` while developing) and open <http://localhost:3001>.
5. Enter the Media List Builder Drive folder ID and authorize Google Workspace.

The local application continues to use `data/store.json` and the other `data/*.json` files. `.env` is not overwritten by deployment changes. `npm run reset:local` remains a local-only reset operation.

## Environment variables

Copy the placeholders from `.env.example`. Never commit `.env`, `.env.local`, OAuth client secrets, or Blob credentials.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | Local only | Local Express port; use `3001`. Vercel supplies its own request runtime. |
| `GOOGLE_CLIENT_ID` | For Google | Google OAuth web client ID. |
| `GOOGLE_CLIENT_SECRET` | For Google | Google OAuth web client secret; server-side only. |
| `GOOGLE_REDIRECT_URI` | For Google | Exact OAuth callback URL. Local: `http://localhost:3001/oauth2callback`; production: `https://<your-domain>/oauth2callback`. |
| `APP_ACCESS_PASSWORD` | Vercel required | Password protecting the app and API. Use a long unique value. Optional locally. |
| `AI_API_KEY` | Optional | Existing AI reporter-enrichment provider key. |
| `AI_MODEL` | Optional | Existing AI model name. |
| `AI_BASE_URL` | Optional | Existing AI-compatible endpoint. |
| `SEARCH_API_KEY` | Optional | Existing search provider key for enrichment and URL resolution. |
| `SEARCH_PROVIDER` | Optional | `tavily` or `serper` when a search key is set. |
| `ENRICHMENT_CONCURRENCY` | Optional | Existing enrichment concurrency setting. |
| `DATA_FILE` | Local override only | Alternate local path to the JSON store. Leave unset on Vercel. |
| `APP_CONFIG_FILE` | Local override only | Alternate local app configuration path. Leave unset on Vercel. |
| `GOOGLE_AUTH_FILE` | Local override only | Alternate local server-side Google credential path. Leave unset on Vercel. |
| `REPORTER_PREFLIGHT_READ_ONLY` | Optional diagnostics | Set to `1` only for read-only reporter preflight operation. |
| `MEDIA_LIST_BUILDER_URL` | Optional migration CLI | Base URL for the explicit canonical-beat migration command; defaults to `http://localhost:3001`. |

### Local OAuth callback

In `.env`, set:

```dotenv
PORT=3001
GOOGLE_REDIRECT_URI=http://localhost:3001/oauth2callback
```

Register that exact URL in the Google Cloud OAuth client. The callback path is taken from this configured URI.

### Vercel OAuth callback

Add the production domain in Vercel first, then set `GOOGLE_REDIRECT_URI` in the Vercel project to the exact URL, for example `https://<your-production-domain>/oauth2callback`. Register the same URL in the Google Cloud OAuth client. Do not use the temporary preview domain for the production variable. To switch environments, change `.env` locally and the Vercel environment variable independently; both URIs can be registered with the same Google OAuth client.

## Vercel architecture and persistent storage

Vercel runs the existing Express application exported by `src/server.ts` as a Node.js Function. The same file starts Express only when executed directly, so local `npm start` remains a regular long-running server. Vercel serves files under `public/` as static assets and sends application/API requests to the Express function. `vercel.json` includes the existing `data/` and `public/` files in the function bundle for fallback reads and the Express fallback page.

Vercel's function filesystem is not durable. The application therefore uses a **private Vercel Blob store** for mutable JSON state in production. The existing `data/store.json` and enrichment files are the seed source; they are not committed by this project because `data/*.json` is ignored and may contain reporter/contact information.

The explicit `npm run seed:vercel-state` command uploads the current local store and enrichment state to the private Blob paths under `media-list-builder/data/`. Existing blobs are skipped; the command never overwrites them. Run this once after connecting the Blob store and before the first production deploy. It does not upload Google OAuth credentials. Keep the Blob store private.

On Vercel, connect the private Blob store to this project. Vercel supplies `BLOB_STORE_ID` and short-lived OIDC credentials to the function automatically. No database is used. Local execution continues to read and write normal files. If the production store blob is absent, startup fails with a message to seed it instead of silently creating an empty production store.

Vercel Blob stores JSON snapshots; this matches the application's existing single-store design and is intended for this internal, low-concurrency workflow. Avoid simultaneous bulk imports or concurrent admin edits from multiple operators.

Google authorization state uses a short-lived HTTP-only, SameSite=Lax cookie. Authorized Google credentials are persisted only in the private Blob store (or the ignored local `data/google-auth.json` file); they are never returned to browser JavaScript or logged. On warm/cold Vercel instances the server reloads the persisted credentials and configured Drive folder. `APP_ACCESS_PASSWORD` gates API access with a short-lived signed, HTTP-only session cookie. The browser prompts for this password when its first API request is challenged; it does not retain the password or receive Google credentials. Anonymous visitors cannot use the server-side Google connection or read directory/coverage data.

## Deploy to Vercel

1. Push this repository to the Git provider connected to Vercel, or link it using the Vercel CLI.
2. In the Vercel project, create a **private** Blob store and connect it to the project for Production (and Preview if you will use Preview deployments).
3. Locally, link the project and pull its environment into the ignored `.env.local` file:

   ```sh
   vercel link
   vercel env pull .env.local
   ```

4. Before the first deploy, seed the private Blob store from the existing local `data/*.json` state:

   ```sh
   npm run seed:vercel-state
   ```

   This is an explicit one-time state copy. Review its output and confirm the store and enrichment state were seeded. It skips any existing Blob object to avoid overwriting production data.

5. Add these Vercel **Production** environment variables:

   ```text
   GOOGLE_CLIENT_ID
   GOOGLE_CLIENT_SECRET
   GOOGLE_REDIRECT_URI=https://<your-production-domain>/oauth2callback
   APP_ACCESS_PASSWORD
   ```

   Add the AI/search variables only if those existing features are needed. Do not set `DATA_FILE`, `APP_CONFIG_FILE`, or `GOOGLE_AUTH_FILE` on Vercel. The connected Blob store supplies `BLOB_STORE_ID` and OIDC access automatically.

6. Add the production callback URL to the Google Cloud OAuth web client’s authorized redirect URIs. After Vercel assigns the domain and environment variables are set, deploy with `vercel --prod` or deploy from the connected Git repository.
7. Open the production domain. On the first API request, the app prompts for `APP_ACCESS_PASSWORD`; then configure the Drive folder and connect Google Workspace from the application. Google OAuth redirects back to the configured production callback, and the connection survives function restarts.
8. For local work, keep `.env` pointed at localhost. Local and production callbacks can both be registered with the Google OAuth client; switching does not require changing application code.

The deployed application continues to use `Master Directory (Cleaned)` as the authoritative reporter universe when Google is connected. It does not merge local reporters with Google reporters, and Coverage does not create reporter candidates. If Google is disconnected, the explicit local store fallback remains available from the seeded persistent store. Filtering, canonical beat taxonomy, reporter identities, Coverage behavior, and the existing nine Google export columns are unchanged.

## Google Workspace requirements

Enable Google Drive API and Google Sheets API. The authorized account needs access to the configured root Drive folder, its `clients` folder, `Master Reporter List`, and the optional `Master Outlet Sheet`. The app uses `Sheet1` for raw reporter staging and `Master Directory (Cleaned)` for the authoritative reporter directory. Export creates a separate media-list spreadsheet with the existing columns:

1. Owner/Date Pitched
2. Outlet
3. Reporter First Name
4. Reporter Last Name
5. Email
6. Reporter Type
7. Clients Covered
8. Profile
9. Notes

## Validation

```sh
npm test
npm run build
```

# Media List Builder

The first working slice of the PRCC ingestion system. It accepts labeled text, CSV, and JSON coverage exports, normalizes them into `CoverageRecord` objects, matches clients and reporters, assigns stable `REP-000001`-style reporter IDs, skips duplicates, and can sync resulting records to Google Drive and Google Sheets.

## Run locally

1. Copy `.env.example` to `.env` and set the Google OAuth web-client credentials below.
2. In Google Cloud, enable Drive API and Sheets API. Add the exact value of `GOOGLE_REDIRECT_URI` as an authorized redirect URI. For the local default, register `http://localhost:3000/oauth2callback`.
3. Run `npm install`, then `npm run dev`.
4. Open `http://localhost:3000`, enter the Media List Builder folder ID, and authorize Google.

To safely rebuild only the local ingestion state after a bad test run, stop the server and run `npm run reset:local`. The command creates `data/store.backup.json` and refuses to overwrite an existing backup. It then clears local clients, reporters, and coverage records. It does not call Google APIs or modify Drive. After restarting and authorizing, the existing Master Reporter List is loaded into the local reporter store.

The OAuth scopes are `drive.metadata.readonly`, `drive.file`, and `spreadsheets`. The configured root folder is the only Drive location used by the adapter. The root must contain `clients` and the existing `Master Reporter List`; the reporter sheet's eight columns are preserved.

## Google Cloud and environment configuration

In Google Cloud Console:

1. Select or create a Google Cloud project.
2. Enable **Google Drive API** and **Google Sheets API**.
3. Configure the OAuth consent screen. Add the Google account that will use the local app as a test user if the app is in testing mode.
4. Create an OAuth client with application type **Web application**.
5. Under **Authorized redirect URIs**, add exactly:

	`http://localhost:3000/oauth2callback`

	If you change `GOOGLE_REDIRECT_URI`, register that exact replacement instead. The scheme, host, port, path, and trailing slash must match.

Set these values in `.env`:

```dotenv
PORT=3000
GOOGLE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-web-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
```

The app sends `GOOGLE_REDIRECT_URI` explicitly in the authorization request and uses its URL path for the Express callback route. Do not put a Google password in `.env`; only use the OAuth client ID and client secret issued by Google Cloud.

## Input shape

CSV and JSON fields may be named `client`, `reporter`, `outlet`, `date`, `articleTitle`/`title`, `articleUrl`/`url`, and `topics`. Plain text uses labeled blocks separated by blank lines:

```text
Client: Falcon Wealth
Reporter: Jane Smith
Outlet: InvestmentNews
Date: 2026-08-07
Article Title: RIA Consolidation Accelerates
Article URL: https://example.com/article
```

The parser is deliberately source-agnostic. A PDF extractor or model-backed extractor can produce the same `ExtractedCoverage[]` contract without changing matching, deduplication, persistence, or outputs.

## AI Reporter Enrichment

Reporter enrichment is separate from ingestion. `POST /api/enrich/reporters` researches unique reporter/outlet pairs and writes proposals, cache, and audit data under `data/`; it does not write Google. Placeholder reporters become `placeholder` proposals, while uncertain identities remain `needs_review`.

Configure providers in `.env` with `AI_API_KEY`, `AI_MODEL`, optional `AI_BASE_URL`, `SEARCH_API_KEY`, `SEARCH_PROVIDER` (`tavily` or `serper` currently), and `ENRICHMENT_CONCURRENCY`. Search results are cached by normalized reporter and outlet. Use `npm run enrich:dry-run` to generate a local-only report against the current store with external providers disabled.

The browser's **AI Reporter Enrichment** section supports proposal review, edit, approval, and **Apply Approved Changes**. Only approved, verified proposals can write to the existing Master Reporter List, and the existing eight-column schema is preserved.
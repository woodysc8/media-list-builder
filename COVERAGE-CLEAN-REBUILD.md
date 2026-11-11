# Lossless PRCC coverage imports

Open `/coverage.html` and select or drop CSV/XLSX files. Uploads start processing automatically on the local Node server. Keep the browser open until transfers finish; the persisted queue then continues without the browser. A failed file does not block later files. Client identities and aliases resolve automatically; ambiguous clients remain unassigned with source rows retained.

## Source history and normalized coverage

Every nonempty data row is ingested, including missing or malformed titles, URLs, dates, reporters, publications and other metadata. Recognized headers and empty rows are not coverage occurrences. Unknown columns, preambles and rows without recognizable headers are retained. No research or invented replacements are used.

`data/coverage-v2.json` contains separate datasets:

- `sourceOccurrences`: every source occurrence, including duplicates, with job ID, filename, worksheet, one-based source row, ordered original columns/values, value types, source SHA-256, incomplete fields and linked record ID. Arrays preserve duplicate/blank headers and extra columns. XLSX cells also retain addresses, stored values, formulas, types and decoded text, including error cells and formulas without cached results.
- `records`: the normalized client-facing Coverage Library. Missing or malformed values can be blank; original source values remain unchanged. Canonical-client/article-URL identities deduplicate the view. Distinct URLs never merge merely because reporter, publication or title matches. Without a reliable URL, only identical original file bytes, filename, worksheet and row can link repeated uploads; otherwise occurrences receive separate records.

Original upload bytes remain at `data/coverage-uploads/<job ID>` and are authoritative for exact file contents, CSV quoting and Excel formulas/styles/numeric precision. Source-history JSON export and per-record source details expose original values separately from normalized CSV export.

Upgrade recovery reads only original uploads explicitly referenced by this installation's jobs. It links existing coverage, restores omitted rows, records recovered counts per file, and retains all job IDs, original import counters and historical validation messages. Repeated startup does not ingest occurrences again. Missing/unreadable sources produce visible recovery errors. No backups, legacy JSON, historical databases or Google coverage rows are loaded. Existing records are never reset or deleted.

The UI distinguishes source rows ingested, unique coverage, duplicate occurrences, incomplete records, actual import failures and Google delivery errors. An incomplete row is locally successful. Unparseable files retain their original bytes and specific errors. Unidentified clients remain local and are never guessed.

## Google synchronization

All clients synchronize automatically, including Conquest. Local ingestion commits before remote work. Persistent client deliveries cover both new uploads and recovered rows. Google success requires actual write/read-back verification.

Existing destination IDs and approved `coverageDestinations` mappings in `app-config.json` are reused. A stored spreadsheet that is deleted, inaccessible or invalid produces an error rather than being recreated. A genuinely new client can resolve/create its dedicated destination. Creation is not blindly retried after an ambiguous response: the next attempt discovers existing folders/files first. IDs persist before coverage writes.

Hierarchy: `Media List Builder / Clients / [Canonical Client] / [Canonical Client]`. Existing client files move/rename in place. Invalid/inaccessible configured folders fail clearly. Unrelated Drive files and the Master Reporter List are never changed or deleted.

Five standard tabs retain these exact headers:

- Coverage: Date | Title | Client | Media Outlet | Reporter | Spokespersons ID | Coverage Type | Sentiment | Status | Reach | URL
- Reporters: Name | Outlet | Email
- Outlets: Outlet | Outlet Type | Monthly Reach / UVM
- Client Contact: Name | Title | Email | Phone
- Team Contact: Name | Title | Email | Phone

Calibri applies across all five grids and the workbook theme. Headers remain bold/frozen, widths readable, dates yyyy-mm-dd, valid URLs clickable and coverage newest-first. Incomplete fields write as blanks. Reporter emails/outlet metadata use verified directory data where available. Contact writes append reliable unseen contacts without replacing manual values. Populated extra tabs or incompatible headers fail safely.

Grids expand **before** writing, fixing the logged Orion/Osaic errors where writes beyond row 1,001 exceeded grid limits. Deterministic writes use at most 500 rows per range and two ranges per request, with rate limiting, exponential retries for temporary failures, and read-back after each batch. Restart compares remote values and skips committed batches. Final read-back checks all values, tabs, fonts, frozen headers, widths and Drive placement before marking verified. Several failed uploads can share one client delivery error; retries never append duplicate coverage.

## Operations and tests

Keep the local server/data/uploads on durable disk and run one worker per directory. Atomic state saves preserve restart recovery. Reporters, clients, settings, credentials and media-list generation remain separate. OAuth reconnection never imports historical Google coverage. The queue requires local Node; serverless coverage requests return 503. Uploads are limited to 10 MB per file and parsed in memory. Transfers are sequential. Pause/cancel apply between files/deliveries; failed deliveries can retry without uploading again.

Install by restarting the server. **Do not reset the database.** The unrelated optional `coverage:fresh-start` operator command requires `--confirm`, backs up local state and refuses to run while the server is active. It is tested only on disposable fixtures. `coverage:verify` remains a zero-dataset check for that explicit reset workflow and should fail when coverage exists. This update deletes no remote Blob or Drive data.

Run `npm run build`, `npm test`, and `npm run test:coverage`. Coverage tests use disposable sources and fake Google transport. They cover missing/malformed fields, CSV/XLSX raw preservation, error/formula cells, duplicate history, omitted-row recovery, repeated startup, automatic imports, destination reuse, >1,000-row grids, interrupted batches, exact tabs/formatting, manual contacts and HTTP server restarts. Live Google verification is reported separately.

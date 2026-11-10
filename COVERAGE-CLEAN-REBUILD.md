# Corrected PRCC coverage rebuild

Open `/coverage.html` from the **Coverage** link. The workspace has an Upload Queue and Coverage Library. Upload corrected CSV/XLSX files, review clients and row errors, then Start. Jobs run sequentially on the local Node server without an open browser tab. Leave the server and computer running; prevent the computer from sleeping overnight.

## Fresh start: operator action required

The live reset was **not executed** during development. Stop the application before resetting. From this repository in Command Prompt:

```bat
set "PATH=C:\Users\Sam\node-portable\node-v22.23.1-win-x64;%PATH%"
npm run coverage:fresh-start -- --confirm
npm run coverage:verify
npm start
```

Run `npm run coverage:verify` again after startup. It exits nonzero unless coverage, upload jobs, pending coverage synchronization jobs and coverage research entries are all zero, with legacy migrations disabled. Existing uploads will naturally make the check fail after you start importing.

The reset refuses to run without `--confirm`, inside Vercel, while the standalone server PID is active, against the project/root directory, or against linked data directories. It backs up the entire local data directory into a timestamped sibling `coverage-backup-*` directory before changing anything. Explicit external configuration/auth paths are also backed up. It then clears coverage and coverage-owned queue/cache/history files and keys, resets dedicated spreadsheet mappings, and creates a new empty generation. Reporter records, archived reporters, clients, contacts, reporter enrichment, settings and OAuth credentials are retained. Backups contain private data and must stay outside version control. No Google/Blob SDK is used by the reset.

## Storage audit and historical entry points

`npm run coverage:audit` reports local storage metadata without printing record contents or credential values. Inspection of this clone found no live `data/` directory, `.env`, local OAuth credentials or Blob credentials. The tracked `data-backup-before-google-fix/` directory contains two old stores (103 and 490 coverage records) plus reporter enrichment files. They were not imported, changed or staged in this work.

| Source                                                               | Protection                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/store.json`, or `DATA_FILE`                                    | Existing coverage retained only for explicit backup/reset; excluded from the application snapshot, normalization, reporter recency and coverage API. Reporter/client data continue using this store.                                                                                                                                      |
| `data/coverage-v2.json` beside `DATA_FILE`                           | Sole active coverage and queue state. Initially empty. Atomic, serialized saves; interrupted jobs become pending. A missing file starts empty; malformed data fails closed.                                                                                                                                                               |
| `data/coverage-uploads/`                                             | Durable UUID-named originals. Only explicit upload creates jobs. No directory scanning, source recovery or automatic reingestion.                                                                                                                                                                                                         |
| Legacy JSON, backups, source-file paths, import/reconciliation files | Startup migration module removed. No new workflow reads these sources. Reset clears coverage-owned local files and coverage-specific state keys.                                                                                                                                                                                          |
| URL/title research                                                   | Legacy ingest, manual coverage, URL resolver and old full coverage sync routes retired. New importer accepts only original HTTP/HTTPS URLs; no search/AI calls. Reporter enrichment remains separate. Existing URL proposals/evidence lived on legacy coverage records; reporter search cache is unrelated and retained.                  |
| Google credentials/config                                            | Existing `app-config.json`/`google-auth.json` or configured overrides retained. Hydration/reconnection never reads coverage into the new dataset.                                                                                                                                                                                         |
| Existing Google Sheets                                               | No inbound coverage import. Dedicated new spreadsheets carry a generation/client app property; spreadsheet IDs persist locally. Reset creates a new generation rather than reusing an old destination. No Drive deletion or Master Reporter List modification by the coverage workflow.                                                   |
| Vercel Blob                                                          | Existing `persistent-files.ts` can load old remote store/config with local seed fallback. Coverage is excluded from the store snapshot and the new queue is disabled on Vercel. No remote state was inspected or modified: this clone has no Blob access configured. The explicit legacy seed command is not invoked by startup or reset. |

## Import and sync behavior

- PRCC mapping: Press Type → Coverage Type; Date → Date; Publication → Media Outlet; UVM → Reach; Reporter → Reporter; Spokesperson → Spokespersons ID; Status → Title; Raw URL → URL. Explicit Title takes precedence. XLSX tabs and original row numbers are retained; blank rows do not shift error locations.
- Client names/aliases saved in the client store match filename prefixes. An optional upload client override handles ambiguous filenames. Otherwise the prefix before PRCC, PR Campaign or year is used. Preview before starting.
- Missing or invalid HTTP/HTTPS URLs reject the row. Accepted original URLs are stored unchanged. Same canonical client and normalized URL deduplicate across files/restarts (hostname case, fragments and query parameter ordering normalize for identity only); different clients remain separate. Distinct article URLs are never merged by reporter/publication. Reach never supplies a title.
- Local imports commit before remote work. Retry uses deterministic range updates over the full client dataset, not append; it cannot duplicate rows. Five automatic attempts use exponential backoff. Retry failed resets the attempt budget without reimporting locally. Pause/cancel take effect between files. Completed jobs stay completed.
- Google uses the existing OAuth connection, a dedicated clean spreadsheet per canonical client and reset generation, batches of 500 rows, rate limiting and read-back verification. A lost create response is recovered by the generation/client app property. Newly created spreadsheets live in the configured Drive root. Existing files are never deleted. Conquest is local-only.
- Local success and Google success have separate counts/statuses. Missing Google authorization leaves local data saved and eventually marks synchronization failed; reconnect and use Retry failed. The Library filters by client, publication, reporter and date; displays newest first and exports the filtered data.

## Validation and operating limits

`npm run build`, `npm test`, and `npm run test:coverage` cover existing reporter/media-list/OAuth behavior plus disposable reset fixtures, CSV/XLSX parsing, multiple-file HTTP uploads, exact URLs/row errors, deduplication, destination reuse, write verification failure, retries, pause/cancel, actual server process restarts and zero coverage following restored Google credentials. Tests use fake Google transport and fixture tokens; no real Google write was performed.

The persistent local Node server is required for overnight processing. The Vercel serverless deployment intentionally returns 503 for queue operations; no remote coverage backend or migration was introduced. Uploads are limited to 10 MB per file. Run one standalone server per data directory. Keep local state and uploaded files together on durable disk. Large spreadsheets are parsed in memory. Upload requests report partial acceptance per file; accepted jobs remain durable if another file is invalid. There are no production credentials in this clone, so live reporter-sheet reads, media-list sheet creation and coverage Google writes require operator verification after authorization.

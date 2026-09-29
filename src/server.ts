import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { ingest } from "./ingestion.js";
import { migrateCoverageFromSources } from "./coverage-migration.js";
import { configuredGoogleRedirectUri, GoogleWorkspace } from "./google.ts";
import { parseInput } from "./parser.js";
import { StructuredStore } from "./store.js";
import { ReporterEnrichmentService } from "./enrichment.js";
import { normalizeReporterType, type ContactRecord, type ExtractedCoverage, type ReporterRecord, type ReporterStatus } from "./domain.js";
import { CANONICAL_BEATS } from "../public/canonical-beats.js";
import { normalizeName } from "./normalize.js";
import { resolveReporter } from "./coverage-resolvers.js";
import { selectCoverageUrlResolutionRecords } from "./url-enrichment.js";
import { expectedOutletDomainsFor } from "./outlet-domain-matching.js";
import { diagnoseOptoUnresolvedOutletDomains } from "./outlet-domain-diagnostic.js";
import { runReadOnlyReporterPreflight } from "./reporter-preflight.js";
import { loadReporterDirectorySnapshot } from "./reporter-directory-source.js";
import { readPersistentFile, writePersistentFile } from "./persistent-files.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
  override: false
});

const app = express();
const appAccessPassword = process.env.APP_ACCESS_PASSWORD?.trim();
if (process.env.VERCEL === "1" && !appAccessPassword) {
  throw new Error("APP_ACCESS_PASSWORD must be configured before deploying this public application");
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

const storePath = path.resolve(
  process.env.DATA_FILE ?? "data/store.json"
);
const reporterPreflightReadOnly = process.env.REPORTER_PREFLIGHT_READ_ONLY === "1";

console.log("[STORE] DATA_FILE:", process.env.DATA_FILE ?? "(default data/store.json)");
console.log("[STORE] RESOLVED STORE PATH:", storePath);
console.log("[STORE] CURRENT WORKING DIRECTORY:", process.cwd());

const store = new StructuredStore(storePath);
await store.load({ readOnly: reporterPreflightReadOnly });
if (reporterPreflightReadOnly) {
  console.log("[STORE] Read-only reporter preflight mode: startup cleanup and Coverage migration skipped");
} else {
  const duplicateCleanup = await store.deduplicateCoverage();
  console.log("[STORE] Coverage duplicate cleanup:", duplicateCleanup);
  const migration = await migrateCoverageFromSources(store, storePath);
  console.log("[MIGRATION] Coverage sources:", migration);
}

const enrichment = new ReporterEnrichmentService(
  path.resolve(
    process.env.DATA_FILE
      ? path.dirname(process.env.DATA_FILE)
      : "data"
  )
);

let workspace: GoogleWorkspace | undefined;
let reportersHydrated = false;
const appConfigPath = path.resolve(process.env.APP_CONFIG_FILE ?? "data/app-config.json");
const googleAuthPath = path.resolve(process.env.GOOGLE_AUTH_FILE ?? "data/google-auth.json");
const GOOGLE_STATE_COOKIE = "mlb_oauth_state";
const APP_SESSION_COOKIE = "mlb_app_session";

function secureCookie(request: express.Request): boolean {
  return process.env.VERCEL === "1" || request.secure || request.get("x-forwarded-proto") === "https";
}

function setOAuthStateCookie(request: express.Request, response: express.Response, state: string): void {
  const secure = secureCookie(request) ? "; Secure" : "";
  response.append("Set-Cookie", `${GOOGLE_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
}

function clearOAuthStateCookie(request: express.Request, response: express.Response): void {
  const secure = secureCookie(request) ? "; Secure" : "";
  response.append("Set-Cookie", `${GOOGLE_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function requestCookie(request: express.Request, name: string): string {
  const prefix = `${name}=`;
  return String(request.headers.cookie ?? "").split(";").map((value) => value.trim()).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function appSessionValue(expiration: string): string {
  return createHmac("sha256", appAccessPassword ?? "")
    .update(expiration)
    .digest("base64url");
}

function hasValidAppSession(request: express.Request): boolean {
  if (!appAccessPassword) return true;
  const [expiration, signature] = requestCookie(request, APP_SESSION_COOKIE).split(".");
  if (!expiration || !signature || Number(expiration) <= Date.now()) return false;
  return constantTimeEqual(signature, appSessionValue(expiration));
}

function setAppSessionCookie(request: express.Request, response: express.Response): void {
  const expiration = String(Date.now() + 8 * 60 * 60 * 1000);
  const value = `${expiration}.${appSessionValue(expiration)}`;
  const secure = secureCookie(request) ? "; Secure" : "";
  response.append("Set-Cookie", `${APP_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure}`);
}

function addOAuthState(url: string, request: express.Request, response: express.Response): string {
  const state = randomUUID();
  setOAuthStateCookie(request, response, state);
  const authorization = new URL(url);
  authorization.searchParams.set("state", state);
  return authorization.toString();
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try { return JSON.parse(await readPersistentFile(filePath)) as T; } catch { return undefined; }
}

async function persistGoogleWorkspace(): Promise<void> {
  if (!workspace) return;
  await writePersistentFile(appConfigPath, JSON.stringify({ rootFolderId: workspace.rootFolderId }));
  await writePersistentFile(googleAuthPath, JSON.stringify(workspace.connected ? workspace.credentials : {}));
}

async function hydrateGoogleWorkspace(): Promise<void> {
  const persistedGoogleConfig = await readOptionalJson<{ rootFolderId?: string }>(appConfigPath);
  const persistedGoogleCredentials = await readOptionalJson<import("google-auth-library").Credentials>(googleAuthPath);
  if (!persistedGoogleConfig?.rootFolderId) {
    workspace = undefined;
    return;
  }
  const hasGoogleToken = Boolean(persistedGoogleCredentials?.refresh_token || persistedGoogleCredentials?.access_token);
  workspace = new GoogleWorkspace(persistedGoogleConfig.rootFolderId, hasGoogleToken ? persistedGoogleCredentials : undefined);
}
await hydrateGoogleWorkspace();

app.use(express.json());
if (appAccessPassword) {
  app.use((request, response, next) => {
    if (request.path === "/api/auth/login" && request.method === "POST") return next();
    if (hasValidAppSession(request)) return next();
    return response.status(401).set("X-App-Auth-Required", "1").json({ error: "Application access is required" });
  });
}
let vercelRequestQueue = Promise.resolve();
app.use(async (_request, response, next) => {
  if (process.env.VERCEL !== "1") return next();
  const previous = vercelRequestQueue;
  let release!: () => void;
  vercelRequestQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  response.once("finish", releaseOnce);
  response.once("close", releaseOnce);
  try {
    await store.load({ readOnly: reporterPreflightReadOnly });
    await hydrateGoogleWorkspace();
    next();
  } catch (error) {
    releaseOnce();
    response.status(503).json({ error: error instanceof Error ? error.message : "Persistent application state could not be loaded" });
  }
});
app.use(express.static(path.resolve(__dirname, "../public")));

// Diagnostic mode keeps existing mutations blocked, with a narrow exception for
// creating an explicitly requested, new media-list spreadsheet.
if (reporterPreflightReadOnly) {
  const callbackPath = new URL(configuredGoogleRedirectUri()).pathname;
  app.use((request, response, next) => {
    const allowed =
      (request.method === "GET" && ["/api/diagnostics/reporter-preflight", "/api/status", "/api/reference-data", "/api/coverage-data", "/auth/google", callbackPath, "/api/media-list/google/status"].includes(request.path)) ||
      (request.method === "POST" && ["/api/auth/login", "/api/config", "/api/media-list/google/connect", "/api/media-list/google/authorize", "/api/media-list/google/sheets"].includes(request.path));
    if (allowed || !request.path.startsWith("/api/")) return next();
    return response.status(403).json({ readOnly: true, error: "Only reporter preflight and OAuth setup are enabled in read-only mode" });
  });
}

/* ============================================================
   HELPERS
============================================================ */

function extractFolderId(value: string): string {
  const input = value.trim();

  if (!input) return "";

  try {
    const parsed = new URL(input);
    const match = parsed.pathname.match(/\/folders\/([^/]+)/);

    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }

    return "";
  } catch {
    return input;
  }
}

function getAllLocalRecords() {
  return store.snapshot.coverage;
}

function getAllLocalReporters() {
  return store.snapshot.reporters;
}

async function persistReporterSync(result: Awaited<ReturnType<GoogleWorkspace["syncMasterReporterList"]>>) {
  for (const reporter of result.mergedReporters) store.updateReporter(reporter);
  for (const reporter of result.mergedArchivedReporters) store.updateArchivedReporter(reporter);
  await store.save();
  const { mergedReporters: _merged, mergedArchivedReporters: _mergedArchived, ...summary } = result;
  return summary;
}

/** Select a deterministic local client only when an endpoint caller omits one. */
function defaultLocalClientName(): string {
  const snapshot = store.snapshot;
  return snapshot.clients.find((client) =>
    snapshot.coverage.some((record) => normalizedClientName(record.clientName) === normalizedClientName(client.name))
  )?.name ?? "";
}

function contactCollection(kind: string): "clientContacts" | "teamContacts" {
  if (kind === "client") return "clientContacts";
  if (kind === "team") return "teamContacts";
  throw new Error("Contact kind must be client or team");
}

async function getMasterOutlets() {
  if (!workspace?.connected) return [];
  const root = await workspace.inspectRoot();
  if (!root.outletSheet) {
    return [];
  }
  return workspace.loadOutlets(root.outletSheet);
}

async function loadGoogleMasterReporters(): Promise<ReporterRecord[]> {
  const connectedWorkspace = workspace;
  if (!connectedWorkspace?.connected) throw new Error("Google disconnected while loading Master Directory (Cleaned)");
  const root = await connectedWorkspace.inspectRoot();
  if (!root.reporterSheet) throw new Error("The connected Google reporter spreadsheet has no Master Directory (Cleaned) tab");
  return connectedWorkspace.loadReporters(root.reporterSheet);
}

async function getMasterReporterDirectory() {
  return loadReporterDirectorySnapshot(
    Boolean(workspace?.connected),
    store.snapshot.reporters,
    loadGoogleMasterReporters
  );
}

async function getMasterReporters() {
  return (await getMasterReporterDirectory()).reporters;
}

function contactIdentity(contact: Pick<ContactRecord, "clientName" | "name" | "title" | "email" | "phone">): string {
  return [contact.clientName ?? "", contact.name, contact.title, contact.email, contact.phone]
    .map(normalizeName)
    .join("|");
}

async function resolveAndPersistCoverageUrls(records: ReturnType<typeof getAllLocalRecords>) {
  if (!enrichment.canResolveCoverageUrls || !records.length) return [];
  const outletDomainsByName = new Map<string, string[]>();
  const masterOutlets = await getMasterOutlets();
  for (const record of records) {
    const domains = expectedOutletDomainsFor(record.outlet, masterOutlets);
    if (domains.length) {
      outletDomainsByName.set(normalizeName(record.outlet), domains);
    }
  }
  const resolutions = await enrichment.resolveCoverageUrls(records, outletDomainsByName);
  const byId = new Map(store.snapshot.coverage.map((record) => [record.id, record]));
  let changed = false;
  for (const resolution of resolutions) {
    const record = byId.get(resolution.coverageId);
    if (!record || resolution.outcome === "manual" || resolution.outcome === "prcc") continue;
    const now = new Date().toISOString();
    const next = resolution.outcome === "verified" || resolution.outcome === "candidate"
      ? { ...record, articleUrl: resolution.articleUrl, urlSource: "resolved" as const, urlConfidence: resolution.confidence, urlResolvedAt: now, urlResolutionEvidence: resolution.evidence, updatedAt: now }
      : { ...record, articleUrl: "", urlSource: null, urlConfidence: "unresolved" as const, urlResolvedAt: null, urlResolutionEvidence: resolution.evidence, updatedAt: now };
    if (JSON.stringify(next) !== JSON.stringify(record)) {
      store.updateCoverage(next);
      changed = true;
    }
  }
  if (changed) await store.save();
  return resolutions;
}

function normalizedOutletName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizedClientName(value: string): string {
  return normalizeName(value);
}

async function buildCoverageReport(clientName: string) {
  const snapshot = store.snapshot;
  const clientCoverage = snapshot.coverage.filter((record) =>
    normalizedClientName(record.clientName) === normalizedClientName(clientName)
  );
  const outlets = await getMasterOutlets();
  const reporters = await getMasterReporters();
  const outletMap = new Map(outlets.map((outlet) => [normalizedOutletName(outlet.name), outlet]));
  const reporterMap = new Map(reporters.map((reporter) => [reporter.id, reporter]));

  const representedOutletKeys = new Set(
    clientCoverage.map((record) => normalizedOutletName(record.outlet)).filter(Boolean)
  );
  const clientReporters = new Map<string, ReporterRecord>();
  for (const record of clientCoverage) {
    const reporter = (record.reporterId ? reporterMap.get(record.reporterId) : undefined) ??
      resolveReporter(record.reporterName, record.outlet, reporters);
    const key = normalizeName(record.reporterName);
    if (!key) continue;
    clientReporters.set(key, reporter ?? {
      id: `unmatched-${key}`,
      firstName: record.reporterName,
      lastName: "",
      outlet: record.outlet,
      email: "",
      clientsCovered: clientName,
      beats: "",
      reporterType: "reporter",
      notes: "",
      mostRecentArticle: "",
      status: "Needs Review"
    });
  }

  const coverage = clientCoverage.map((record) => {
    const outlet = outletMap.get(normalizedOutletName(record.outlet));
    const reporter = (record.reporterId ? reporterMap.get(record.reporterId) : undefined) ??
      resolveReporter(record.reporterName, record.outlet, reporters);
    return {
      date: record.publicationDate,
      title: record.articleTitle,
      client: record.clientName,
      mediaOutlet: outlet?.name ?? record.outlet,
      reporter: reporter ? `${reporter.firstName} ${reporter.lastName}`.trim() : record.reporterName,
      spokesperson: record.spokesperson,
      coverageType: record.coverageType,
      sentiment: record.sentiment,
      status: record.status,
      reach:
        record.reachSource === "prcc" && record.reach !== null && String(record.reach).trim() !== ""
          ? record.reach
          : outlet?.uvm ?? null,
      url: record.articleUrl || record.proposedUrl || "",
      outletMatched: Boolean(outlet),
      reporterMatched: Boolean(reporter || !record.reporterName)
    };
  });

  return {
    client: clientName,
    tabs: ["Coverage", "Reporters", "Outlets", "Client Contact", "Team Contact"],
    coverage,
    reporters: [...clientReporters.values()].map((reporter) => ({
      ...reporter,
      matched: !reporter.id.startsWith("unmatched-")
    })),
    outlets: [...representedOutletKeys].map((key) => {
      const master = outletMap.get(key);
      const raw = clientCoverage.find((record) => normalizedOutletName(record.outlet) === key)?.outlet ?? key;
      return {
        name: master?.name ?? raw,
        uvm: master?.uvm ?? null,
        link: master?.link ?? "",
        matched: Boolean(master),
        masterDataAvailable: Boolean(workspace?.connected)
      };
    }),
    clientContacts: snapshot.clientContacts.filter((contact) =>
      normalizedClientName(contact.clientName ?? "") === normalizedClientName(clientName)
    ),
    teamContacts: snapshot.teamContacts.filter((contact) =>
      normalizedClientName(contact.clientName ?? "") === normalizedClientName(clientName)
    )
  };
}

function mergeClientsCovered(
  current: string,
  incoming: string
): string {
  const values = [
    ...current
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ...incoming
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  ];

  const merged: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const key = normalizeName(value);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(value);
  }

  return merged.join(", ");
}

/* ============================================================
   STATUS
============================================================ */

app.post("/api/auth/login", (request, response) => {
  const supplied = String(request.body?.password ?? "");
  if (!appAccessPassword || !constantTimeEqual(supplied, appAccessPassword)) {
    return response.status(401).json({ error: "The application password is incorrect" });
  }
  setAppSessionCookie(request, response);
  return response.json({ authenticated: true });
});

app.get("/api/status", (_request, response) => {
  response.json({
    configured: Boolean(workspace),
    connected: workspace?.connected ?? false,
    reportersHydrated,
    ...store.snapshot
  });
});

app.get("/api/reference-data", async (_request, response) => {
  let reporterDirectory: Awaited<ReturnType<typeof getMasterReporterDirectory>>;
  try {
    reporterDirectory = await getMasterReporterDirectory();
  } catch (error) {
    const googleConnected = Boolean(workspace?.connected);
    return response.status(502).json({
      error: error instanceof Error ? error.message : "Unable to load Master Directory",
      ...(googleConnected ? { reporterSource: {
        kind: "google",
        label: "Master Directory (Cleaned)",
        authoritative: true,
        error: "Google Master Directory could not be loaded; local fallback was not used"
      } } : {})
    });
  }
  try {
    return response.json({
      reporters: reporterDirectory.reporters,
      reporterSource: reporterDirectory.reporterSource,
      canonicalBeats: CANONICAL_BEATS,
      clients: [...new Set(reporterDirectory.reporters.flatMap((reporter) => String(reporter.clientsCovered ?? "").split(/[,;|]/).map((name) => name.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b)),
      outlets: await getMasterOutlets()
    });
  } catch (error) {
    return response.status(502).json({
      error: error instanceof Error ? error.message : "Unable to load master sources",
      reporterSource: reporterDirectory.reporterSource
    });
  }
});

// Explicit migration endpoint used only by `npm run migrate:canonical-beats`.
// It is intentionally not called during startup or ordinary reference reads.
app.post("/api/migrations/canonical-beats", async (request, response) => {
  if (!workspace?.connected) return response.status(503).json({ error: "Google authorization is required for the canonical-beat migration" });
  try {
    const dryRun = request.body?.dryRun !== false;
    return response.json(await workspace.migrateCanonicalBeats({
      dryRun,
      expectedSnapshotFingerprint: String(request.body?.expectedSnapshotFingerprint ?? "") || undefined
    }));
  } catch (error) {
    return response.status(502).json({ error: error instanceof Error ? error.message : "Canonical-beat migration failed" });
  }
});

app.get("/api/coverage-data", (_request, response) => {
  try {
    return response.json({ coverage: store.snapshot.coverage });
  } catch (error) {
    return response.status(500).json({
      error: error instanceof Error ? error.message : "Unable to load coverage data"
    });
  }
});

app.get("/api/report", async (_request, response) => {
  try {
    const clientName = String(_request.query.client ?? defaultLocalClientName()).trim();
    if (!clientName) return response.status(400).json({ error: "A report client is required" });
    return response.json(await buildCoverageReport(clientName));
  } catch (error) {
    return response.status(502).json({
      error: error instanceof Error ? error.message : "Unable to build coverage report"
    });
  }
});

app.post("/api/contacts/:kind", async (request, response) => {
  try {
    const collection = contactCollection(request.params.kind);
    const clientName = String(request.query.client ?? request.body?.client ?? defaultLocalClientName()).trim();
    const body = request.body ?? {};
    const contact: ContactRecord = {
      id: String(body.id ?? `CON-${Date.now()}`),
      clientName,
      name: String(body.name ?? "").trim(),
      title: String(body.title ?? body.role ?? "").trim(),
      email: String(body.email ?? "").trim(),
      phone: String(body.phone ?? "").trim(),
      notes: String(body.notes ?? "").trim()
    };
    if (!contact.name) return response.status(400).json({ error: "Contact name is required" });
    if (contact.email && !/^\S+@\S+\.\S+$/.test(contact.email)) {
      return response.status(400).json({ error: "Contact email is invalid" });
    }
    const data = store.snapshot;
    const contacts = data[collection];
    const matchingIdIndex = contacts.findIndex((item) => item.id === contact.id);
    const existingIndex = matchingIdIndex >= 0
      ? matchingIdIndex
      : contacts.findIndex((item) => contactIdentity(item) === contactIdentity(contact));
    if (existingIndex >= 0) contacts[existingIndex] = contact;
    else contacts.push(contact);
    await store.replaceContacts(collection, contacts);
    return response.json(contact);
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "Unable to save contact" });
  }
});

app.delete("/api/contacts/:kind/:id", async (request, response) => {
  try {
    const collection = contactCollection(request.params.kind);
    const clientName = String(request.query.client ?? defaultLocalClientName()).trim();
    const contacts = store.snapshot[collection].filter((item) =>
      item.id !== request.params.id || normalizedClientName(item.clientName ?? "") !== normalizedClientName(clientName)
    );
    await store.replaceContacts(collection, contacts);
    return response.status(204).end();
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "Unable to delete contact" });
  }
});

app.post("/api/coverage", async (request, response) => {
  try {
    const body = request.body ?? {};
    const reporter = store.snapshot.reporters.find((item) => item.id === String(body.reporterId ?? ""));
    const outlets = await getMasterOutlets();
    const outlet = outlets.find((item) => normalizedOutletName(item.name) === normalizedOutletName(String(body.outlet ?? "")));
    const outletName = outlet?.name ?? String(body.outlet ?? "").trim();
    if (!outletName) throw new Error("Media Outlet is required");
    if (body.reporterId && !reporter) throw new Error("Selected reporter was not found in the Reporter Master List");

    const item: ExtractedCoverage = {
      clientName: String(body.client ?? "").trim(),
      reporterName: reporter ? `${reporter.firstName} ${reporter.lastName}`.trim() : "",
      outlet: outletName,
      publicationDate: String(body.date ?? "").trim(),
      articleTitle: String(body.title ?? "").trim(),
      articleUrl: String(body.url ?? "").trim(),
      spokesperson: String(body.spokesperson ?? "").trim(),
      originalPressType: String(body.pressType ?? "").trim(),
      coverageType: String(body.coverageType ?? "").trim(),
      sentiment: String(body.sentiment ?? "").trim(),
      status: String(body.status ?? "").trim(),
      reach: typeof body.reach === "number" ? body.reach : null,
      rawFields: Object.fromEntries(
        Object.entries(body).map(([key, value]) => [key, String(value ?? "")])
      )
    };
    if (!item.clientName || !item.articleTitle) throw new Error("Client and title are required");
    const result = await ingest(
      [item],
      "PRCC",
      "manual PRCC entry",
      store,
      { outlets: await getMasterOutlets(), urlSource: "manual" }
    );
    return response.json({
      ...result,
      coverageAdded: result.records.length - result.coverageUpdated,
      coverageUpdated: result.coverageUpdated
    });
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "Coverage entry failed" });
  }
});

/* ============================================================
   GOOGLE CONFIG
============================================================ */

app.post("/api/config", async (request, response) => {
  const rootFolderId = extractFolderId(
    String(request.body.rootFolderId ?? "")
  );

  if (!rootFolderId) {
    return response.status(400).json({
      error: "A Media List Builder folder ID is required"
    });
  }

  try {
    workspace = new GoogleWorkspace(rootFolderId);
    await persistGoogleWorkspace();

    console.log("[GOOGLE] Workspace configured");

    return response.json({
      authorizationUrl: addOAuthState(workspace.authorizationUrl, request, response)
    });
  } catch (error) {
    return response.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to configure Google OAuth"
    });
  }
});

app.get("/auth/google", (_request, response) => {
  if (!workspace) {
    return response.redirect(
      "/?error=Configure+the+Drive+folder+first"
    );
  }

  return response.redirect(addOAuthState(workspace.authorizationUrl, _request, response));
});

/* ============================================================
   GOOGLE OAUTH CALLBACK
============================================================ */

const googleCallbackPath = new URL(
  configuredGoogleRedirectUri()
).pathname;

app.get(
  googleCallbackPath,
  async (request, response) => {
    try {
      if (!workspace) {
        throw new Error(
          "Configure the Drive folder first"
        );
      }

      const code = String(
        request.query.code ?? ""
      ).trim();

      const returnedState = String(request.query.state ?? "");
      const savedState = requestCookie(request, GOOGLE_STATE_COOKIE);
      if (!savedState || !returnedState || !constantTimeEqual(savedState, returnedState)) {
        throw new Error("Google authorization state is missing or expired");
      }

      if (!code) {
        throw new Error(
          "Google authorization code was missing"
        );
      }

      await workspace.authorize(code);
      await persistGoogleWorkspace();
      clearOAuthStateCookie(request, response);

      console.log(
        "[GOOGLE] Authorization successful"
      );

      if (reporterPreflightReadOnly) {
        return response.redirect("/?connected=1&readOnly=1");
      }

      return response.redirect(
        "/?connected=1"
      );
    } catch (error) {
      console.error(
        "[GOOGLE] Authorization failed:",
        error
      );

      return response.redirect(
        `/?error=${encodeURIComponent(
          error instanceof Error
            ? error.message
            : "Google authorization failed"
        )}`
      );
    }
  }
);

/* ============================================================
   GOOGLE DIAGNOSTICS
============================================================ */

// This endpoint performs Google metadata/value reads only. It uses a cloned
// store snapshot and never invokes migration, store mutation, or sync methods.
app.get("/api/diagnostics/reporter-preflight", async (_request, response) => {
  if (!workspace?.connected) {
    return response.status(503).json({ error: "Google authorization is required for the read-only reporter preflight" });
  }
  try {
    return response.json({ readOnly: true, ...(await runReadOnlyReporterPreflight(workspace, store)) });
  } catch (error) {
    return response.status(502).json({
      readOnly: true,
      error: error instanceof Error ? error.message : "Reporter preflight failed"
    });
  }
});

app.get("/api/media-list/google/status", (_request, response) => {
  return response.json({ connected: Boolean(workspace?.connected), configured: Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim()) });
});

app.post("/api/media-list/google/connect", async (_request, response) => {
  try {
    if (!workspace) {
      workspace = new GoogleWorkspace("root");
      await persistGoogleWorkspace();
    }
    return response.json({ authorizationUrl: addOAuthState(workspace.authorizationUrl, _request, response) });
  } catch (error) {
    return response.status(503).json({ error: error instanceof Error ? error.message : "Google OAuth is not configured" });
  }
});

app.post("/api/media-list/google/authorize", async (request, response) => {
  const code = String(request.body.code ?? "").trim();
  const state = String(request.body.state ?? "").trim();
  const savedState = requestCookie(request, GOOGLE_STATE_COOKIE);
  if (!workspace || !savedState || !state || !constantTimeEqual(savedState, state)) {
    return response.status(400).json({ error: "Google authorization state is missing or expired" });
  }
  if (!code) return response.status(400).json({ error: "Google authorization code is missing" });
  try {
    await workspace.authorize(code);
    await persistGoogleWorkspace();
    clearOAuthStateCookie(request, response);
    return response.json({ connected: true });
  } catch (error) {
    return response.status(502).json({ error: error instanceof Error ? error.message : "Google authorization failed" });
  }
});

app.post("/api/media-list/google/sheets", async (request, response) => {
  if (!workspace?.connected) return response.status(401).json({ error: "Google connection is required. Connect Google, then create the sheet again." });
  const title = String(request.body.title ?? "").trim();
  const headers = request.body.headers;
  const rows = request.body.rows;
  const expectedHeaders = ["Owner/Date Pitched", "Outlet", "Reporter First Name", "Reporter Last Name", "Email", "Reporter Type", "Clients Covered", "Profile", "Notes"];
  if (!title || !Array.isArray(headers) || headers.length !== expectedHeaders.length || headers.some((value: unknown, index: number) => value !== expectedHeaders[index]) || !Array.isArray(rows) || rows.some((row: unknown) => !Array.isArray(row) || row.length !== expectedHeaders.length || row.some((value: unknown) => typeof value !== "string"))) {
    return response.status(400).json({ error: "The media-list spreadsheet payload is invalid" });
  }
  try {
    const result = await workspace.createMediaListSpreadsheet(title, headers, rows);
    return response.json({ ...result, title });
  } catch (error) {
    return response.status(502).json({ error: error instanceof Error ? error.message : "Unable to create the Google Sheet" });
  }
});

app.get("/api/diagnostics/opto-outlet-domains", async (_request, response) => {
  try {
    if (!workspace?.connected) {
      return response.status(503).json({ error: "Google authorization is required to read the Master Outlet Sheet" });
    }
    // getMasterOutlets uses GoogleWorkspace.loadOutlets and performs reads only.
    return response.json(diagnoseOptoUnresolvedOutletDomains(getAllLocalRecords(), await getMasterOutlets()));
  } catch (error) {
    return response.status(502).json({
      error: error instanceof Error ? error.message : "Master outlet diagnostic failed"
    });
  }
});

app.get(
  "/api/diagnostics/google",
  async (_request, response) => {
    const localRecords =
      getAllLocalRecords();

    const localClients = [
      ...new Set(
        localRecords
          .map((record) =>
            record.clientName?.trim()
          )
          .filter(Boolean)
      )
    ];

    if (!workspace?.connected) {
      return response.json({
        connected: false,
        root: null,
        clientsFolder: null,
        clientFolders: [],
        clientSheets: [],
        masterReporterList: null,
        masterReporterHeader: null,
        masterReporterRawRows: null,
        masterReporterDataRows: null,
        localRecords: localRecords.length,
        localClients,
        localReporters:
          getAllLocalReporters().length,
        reportersHydrated
      });
    }

    try {
      const diagnostics =
        await workspace.diagnostics();

      return response.json({
        ...diagnostics,
        connected: true,
        localRecords:
          localRecords.length,
        localClients,
        localReporters:
          getAllLocalReporters().length,
        reportersHydrated
      });
    } catch (error) {
      return response.status(502).json({
        connected: true,
        error:
          error instanceof Error
            ? error.message
            : "Google diagnostics failed",
        localRecords:
          localRecords.length,
        localClients,
        localReporters:
          getAllLocalReporters().length,
        reportersHydrated
      });
    }
  }
);

/* ============================================================
   SYNC ALL LOCAL RECORDS TO GOOGLE
============================================================ */

app.post(
  "/api/sync/local",
  async (request, response) => {
    if (!workspace?.connected) {
      return response.status(400).json({
        error:
          "Google workspace is not connected"
      });
    }

    try {
      const requestedClients: string[] = Array.isArray(
        request.body?.clients
      )
        ? request.body.clients
            .map((value: unknown) =>
              String(value ?? "").trim()
            )
            .filter(Boolean)
        : [];

      const records =
        requestedClients.length > 0
          ? getAllLocalRecords().filter(
              (record) =>
                requestedClients.some(
                  (client) =>
                    normalizeName(client) ===
                    normalizeName(
                      record.clientName
                    )
                )
            )
          : getAllLocalRecords();

      const reporters = await store.prepareCurrentReporters();

      console.log(
        `[SYNC] Starting full local sync: ${records.length} coverage records, ${reporters.length} reporters`
      );

      const coverage =
        await workspace.syncLocalRecords(records, {
          clientContacts: store.snapshot.clientContacts,
          teamContacts: store.snapshot.teamContacts
        });

      const rawReporterSync = await workspace.syncRawReporterStaging(reporters);

      const reportersSync =
        await workspace.syncMasterReporterList(
          reporters,
          { archivedReporters: store.snapshot.archivedReporters }
        );
      const reporterSyncSummary = await persistReporterSync(reportersSync);

      console.log("[SYNC] Complete", {
        clients: coverage.clients.length,
        coverageAdded:
          coverage.totalAddedCoverageRows,
        coverageSkipped:
          coverage.totalSkippedCoverageRows,
        reportersAdded:
          reporterSyncSummary.addedReporterRows,
        reportersUpdated:
          reporterSyncSummary.updatedReporterRows,
        reportersSkipped:
          reporterSyncSummary.skippedReporterRows
      });

      return response.json({
        localRecordsConsidered:
          records.length,
        clientsSynced: coverage.clients,
        addedCoverageRows:
          coverage.totalAddedCoverageRows,
        skippedCoverageRows:
          coverage.totalSkippedCoverageRows,
        reporterSync: reporterSyncSummary,
        rawReporterSync,
        debug: coverage.debug
      });
    } catch (error) {
      console.error(
        "[SYNC] Full sync failed:",
        error
      );

      return response.status(502).json({
        error:
          error instanceof Error
            ? error.message
            : "Local record sync failed"
      });
    }
  }
);

/* ============================================================
   POPULATE ALL REPORTERS
============================================================ */

app.post(
  "/api/sync/reporters",
  async (request, response) => {
    if (!workspace?.connected) {
      console.error(
        "[REPORTERS] Workspace not connected"
      );

      return response.status(400).json({
        error:
          "Google workspace is not connected"
      });
    }

    try {
      const records =
        getAllLocalRecords();

      const reporters = await store.prepareCurrentReporters();

      const requestedClients: string[] = Array.isArray(
        request.body?.clients
      )
        ? request.body.clients
            .map((value: unknown) =>
              String(value ?? "").trim()
            )
            .filter(Boolean)
        : [];

      const writeOnlyKeys = requestedClients.length
        ? reporters.filter((reporter) => {
            const covered = reporter.clientsCovered.split(",").map((value) => normalizeName(value));
            return requestedClients.some((client) => covered.includes(normalizeName(client)));
          }).map((reporter) => [reporter.outlet, reporter.firstName, reporter.lastName].map(normalizeName).join("|"))
        : undefined;

      const root =
        await workspace.inspectRoot();

      if (!root.reporterSheet) {
        throw new Error(
          "Master Reporter List was not found under the configured root"
        );
      }

      const uniqueReporters = new Map<
        string,
        ReporterRecord
      >();

      for (const reporter of reporters) {
        const key = [
          reporter.outlet,
          reporter.firstName,
          reporter.lastName
        ]
          .map((value) =>
            String(value ?? "")
              .trim()
              .toLowerCase()
          )
          .join("|");

        if (!uniqueReporters.has(key)) {
          uniqueReporters.set(
            key,
            reporter
          );
          continue;
        }

        const existing =
          uniqueReporters.get(key)!;

        existing.clientsCovered =
          mergeClientsCovered(
            existing.clientsCovered,
            reporter.clientsCovered
          );
      }

      const reportersToStage = [...uniqueReporters.values()].filter((reporter) => {
        if (!writeOnlyKeys) return true;
        const key = [reporter.outlet, reporter.firstName, reporter.lastName].map(normalizeName).join("|");
        return writeOnlyKeys.includes(key);
      });
      const reporterSyncSummary = await workspace.syncRawReporterStaging(reportersToStage);

      console.log(
        `[REPORTERS] Staged ${reportersToStage.length} local reporters in Sheet1`
      );

      return response.json({
        ...reporterSyncSummary,
        localRecordsConsidered:
          records.length,
        localReporters:
          reporters.length,
        selectedClients:
          requestedClients,
        uniqueReporters:
          uniqueReporters.size
      });
    } catch (error) {
      console.error(
        "[REPORTERS] Population failed:",
        error
      );

      return response.status(502).json({
        error:
          error instanceof Error
            ? error.message
            : "Reporter population failed"
      });
    }
  }
);

/* ============================================================
   ENRICHMENT
============================================================ */

app.post(
  "/api/enrich/reporters",
  async (request, response) => {
    try {
      const snapshot =
        store.snapshot;

      const selectedClients: string[] = Array.isArray(
        request.body?.clients
      )
        ? request.body.clients
            .map((value: unknown) =>
              String(value ?? "").trim()
            )
            .filter(Boolean)
        : [];

      const records =
        selectedClients.length > 0
          ? snapshot.coverage.filter(
              (record) =>
                selectedClients.some(
                  (client) =>
                    normalizeName(client) ===
                    normalizeName(
                      record.clientName
                    )
                )
            )
          : snapshot.coverage;

      const result =
        await enrichment.run(
          records,
          snapshot.reporters
        );

      return response.json(result);
    } catch (error) {
      return response.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Reporter enrichment failed"
      });
    }
  }
);

app.get(
  "/api/enrich/reporters",
  async (_request, response) => {
    response.json({
      proposals:
        await enrichment.loadProposals()
    });
  }
);

app.post(
  "/api/enrich/reporters/approval",
  async (request, response) => {
    try {
      const updates =
        Array.isArray(
          request.body?.updates
        )
          ? request.body.updates
          : [];

      return response.json({
        proposals:
          await enrichment.updateApprovals(
            updates
          )
      });
    } catch (error) {
      return response.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Approval update failed"
      });
    }
  }
);

app.post(
  "/api/enrich/reporters/apply",
  async (_request, response) => {
    if (!workspace?.connected) {
      return response.status(400).json({
        error:
          "Google workspace is not connected"
      });
    }

    try {
      const proposals =
        await enrichment.loadProposals();

      const approved =
        proposals.filter(
          (proposal) =>
            proposal.approvalStatus ===
              "approved"
        );

      const localReporters = new Map(
        store.snapshot.reporters.map(
          (reporter) => [reporter.id, reporter]
        )
      );

      for (const proposal of approved) {
        const parts =
          proposal.reporterName
            .trim()
            .split(/\s+/);

        const reporterStatus: ReporterStatus =
          proposal.status === "verified"
            ? "Active"
            : "Needs Review";

        const reporterInput = {
          outlet: proposal.outlet,
          firstName: parts.shift() ?? "",
          lastName: parts.join(" "),
          email: proposal.email ?? "",
          clientsCovered: (() => {
            const clients = [
              ...new Set(
                store.snapshot.coverage
                  .filter(
                    (record) =>
                      normalizeName(record.outlet) === normalizeName(proposal.outlet) &&
                      normalizeName(record.reporterName) === normalizeName(proposal.currentName)
                  )
                  .map((record) => record.clientName.trim())
                  .filter(Boolean)
              )
            ];

            return clients.join(", ");
          })(),
          beats: proposal.beats.join(", "),
          notes: "",
          mostRecentArticle: "",
          status: reporterStatus,
          reporterType: normalizeReporterType(proposal.reporterType)
        };

        const existing = proposal.reporterId
          ? localReporters.get(proposal.reporterId)
          : undefined;

        const reporter = existing ??
          store.addReporter(reporterInput);

        proposal.reporterId = reporter.id;

        const updatedReporter = {
          ...reporter,
          outlet: reporterInput.outlet,
          firstName: reporterInput.firstName,
          lastName: reporterInput.lastName,
          email: reporterInput.email,
          beats: reporterInput.beats,
          reporterType: reporterInput.reporterType,
          status: reporterInput.status,
          // Human-managed fields remain untouched by enrichment.
          clientsCovered: reporter.clientsCovered,
          notes: reporter.notes
        };

        store.updateReporter(updatedReporter);
        localReporters.set(updatedReporter.id, updatedReporter);
      }

      if (approved.length) {
        await store.save();
        await enrichment.saveProposals(
          proposals
        );
      }

      const reportersForApprovedFlow = await store.prepareCurrentReporters();
      const result =
        await workspace.applyEnrichmentProposals(
          approved,
          reportersForApprovedFlow
        );
      const currentReporters = await store.prepareCurrentReporters();
      const reporterSync = await workspace.syncMasterReporterList(currentReporters, {
        writeOnlyKeys: [],
        archivedReporters: store.snapshot.archivedReporters
      });
      await persistReporterSync(reporterSync);

      return response.json({
        ...result,
        googleRowsWritten:
          result.updated + result.added,
        proposalsApplied:
          approved.length
      });
    } catch (error) {
      return response.status(502).json({
        error:
          error instanceof Error
            ? error.message
            : "Approved enrichment apply failed"
      });
    }
  }
);

app.post("/api/coverage/resolve-urls", async (request, response) => {
  try {
    if (!enrichment.canResolveCoverageUrls) {
      return response.status(503).json({ error: "URL resolution requires the existing SEARCH_API_KEY configuration" });
    }
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.map((id: unknown) => String(id)) : [];
    const clients = Array.isArray(request.body?.clients) ? request.body.clients.map((client: unknown) => normalizeName(String(client))) : [];
    if (!ids.length && !clients.length) {
      return response.status(400).json({ error: "Provide one or more coverage ids or clients; URL repair is intentionally bounded" });
    }
    const limit = Math.min(Math.max(Number(request.body?.limit ?? 10), 1), 25);
    const records = selectCoverageUrlResolutionRecords(store.snapshot.coverage, ids, clients, limit);
    const resolutions = await resolveAndPersistCoverageUrls(records);
    return response.json({ considered: records.length, resolutions });
  } catch (error) {
    return response.status(502).json({
      error: error instanceof Error ? error.message : "Coverage URL resolution failed"
    });
  }
});

/* ============================================================
   INGEST
============================================================ */

app.post(
  "/api/ingest",
  upload.single("file"),
  async (request, response) => {
    try {
      if (!request.file) {
        return response.status(400).json({
          error: "Choose a PRCC file"
        });
      }

      console.log(
        `[PARSER] Receiving ${request.file.originalname}`
      );

      const parsed = parseInput(
        request.file.buffer.toString(
          "utf8"
        ),
        request.file.originalname
      );

      console.log(
        `[PARSER] Parsed ${parsed.items.length} items`
      );

      const result = await ingest(
        parsed.items,
        parsed.source,
        request.file.originalname,
        store,
        { outlets: await getMasterOutlets() }
      );

      // URL lookup is a bounded post-ingestion operation on only the records
      // just imported. It never runs from Google synchronization.
      let urlResolutions: Awaited<ReturnType<typeof resolveAndPersistCoverageUrls>> = [];
      try {
        urlResolutions = await resolveAndPersistCoverageUrls(
          result.records.filter((record) => !record.articleUrl && record.urlSource !== "manual")
        );
      } catch (error) {
        console.error("[URL RESOLUTION] Newly imported records remain unresolved:", error);
      }

      /*
       * IMPORTANT:
       *
       * If an item is already in the local store, ingest() correctly
       * returns it as a duplicate. We DO NOT treat that as an error.
       *
       * Existing records can still be synchronized to Google separately
       * through /api/sync/local.
       */

      let coverageSync = null;
      let reporterSync = null;

      if (workspace?.connected) {
        if (result.records.length) {
          coverageSync =
            await workspace.syncLocalRecords(
              store.snapshot.coverage,
              {
                clientContacts: store.snapshot.clientContacts,
                teamContacts: store.snapshot.teamContacts
              }
            );
        }

        const reporterIdsToStage = new Set([
          ...result.discoveredReporterIds,
          ...result.records.map((record) => record.reporterId ?? "").filter(Boolean)
        ]);
        if (reporterIdsToStage.size) {
          const currentReporters = await store.prepareCurrentReporters();
          const snapshot = store.snapshot;
          const reportersToStage = [...snapshot.reporters, ...snapshot.archivedReporters]
            .filter((reporter) => reporterIdsToStage.has(reporter.id));
          const rawSync = await workspace.syncRawReporterStaging(reportersToStage);
          const canonicalSync = await workspace.syncMasterReporterList(currentReporters, {
            archivedReporters: snapshot.archivedReporters,
            addUnlisted: false
          });
          const canonicalSummary = await persistReporterSync(canonicalSync);
          reporterSync = { ...canonicalSummary, rawReporterSync: rawSync };
        }
      }

      console.log(
        `[INGEST] Parsed=${parsed.items.length} Added=${result.records.length} Duplicates=${result.duplicates.length} Review=${result.reviewRequired.length}`
      );

      return response.json({
        ...result,
        parsed:
          parsed.items.length,
        coverageAdded:
          result.records.length - result.coverageUpdated,
        coverageUpdated:
          result.coverageUpdated,
        coverageDuplicates:
          result.duplicates.length,
        urlResolutions,
        googleCoverageSync:
          coverageSync,
        googleReporterSync:
          reporterSync,
        syncedToGoogle:
          Boolean(workspace?.connected)
      });
    } catch (error) {
      console.error(
        "[INGEST] Failed:",
        error
      );

      return response.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Ingestion failed"
      });
    }
  }
);

/* ============================================================
   FRONTEND FALLBACK
============================================================ */

app.get("*", (_request, response) => {
  response.sendFile(
    path.resolve(
      __dirname,
      "../public/index.html"
    )
  );
});

/* ============================================================
   START
============================================================ */

export default app;

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => {
    console.log(`Media List Builder running at http://localhost:${port}`);
  });
}

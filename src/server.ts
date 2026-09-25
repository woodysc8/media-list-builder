import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ingest } from "./ingestion.js";
import { migrateCoverageFromSources } from "./coverage-migration.js";
import { GoogleWorkspace } from "./google.ts";
import { parseInput } from "./parser.js";
import { StructuredStore } from "./store.js";
import { ReporterEnrichmentService } from "./enrichment.js";
import { normalizeReporterType, type ContactRecord, type ExtractedCoverage, type ReporterRecord, type ReporterStatus } from "./domain.js";
import { normalizeName } from "./normalize.js";
import { resolveReporter } from "./coverage-resolvers.js";
import { selectCoverageUrlResolutionRecords } from "./url-enrichment.js";
import { expectedOutletDomainsFor } from "./outlet-domain-matching.js";
import { diagnoseOptoUnresolvedOutletDomains } from "./outlet-domain-diagnostic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
  override: true
});

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

const storePath = path.resolve(
  process.env.DATA_FILE ?? "data/store.json"
);

console.log("[STORE] DATA_FILE:", process.env.DATA_FILE ?? "(default data/store.json)");
console.log("[STORE] RESOLVED STORE PATH:", storePath);
console.log("[STORE] CURRENT WORKING DIRECTORY:", process.cwd());

const store = new StructuredStore(storePath);
await store.load();
const duplicateCleanup = await store.deduplicateCoverage();
console.log("[STORE] Coverage duplicate cleanup:", duplicateCleanup);
const migration = await migrateCoverageFromSources(store, storePath);
console.log("[MIGRATION] Coverage sources:", migration);

const enrichment = new ReporterEnrichmentService(
  path.resolve(
    process.env.DATA_FILE
      ? path.dirname(process.env.DATA_FILE)
      : "data"
  )
);

let workspace: GoogleWorkspace | undefined;
let reportersHydrated = false;

app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../public")));

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

async function getMasterReporters() {
  if (!workspace?.connected) return store.snapshot.reporters;
  const root = await workspace.inspectRoot();
  if (!root.reporterSheet) return store.snapshot.reporters;
  return workspace.loadReporters(root.reporterSheet);
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

app.get("/api/status", (_request, response) => {
  response.json({
    configured: Boolean(workspace),
    connected: workspace?.connected ?? false,
    reportersHydrated,
    ...store.snapshot
  });
});

app.get("/api/reference-data", async (_request, response) => {
  try {
    return response.json({
      reporters: await getMasterReporters(),
      outlets: await getMasterOutlets()
    });
  } catch (error) {
    return response.status(502).json({
      error: error instanceof Error ? error.message : "Unable to load master sources"
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

app.post("/api/config", (request, response) => {
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

    console.log(
      "[GOOGLE] Workspace configured:",
      rootFolderId
    );

    return response.json({
      authorizationUrl: workspace.authorizationUrl
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

  return response.redirect(workspace.authorizationUrl);
});

/* ============================================================
   GOOGLE OAUTH CALLBACK
============================================================ */

const googleCallbackPath = new URL(
  process.env.GOOGLE_REDIRECT_URI?.trim() ??
    "http://localhost:3000/oauth2callback"
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

      if (!code) {
        throw new Error(
          "Google authorization code was missing"
        );
      }

      await workspace.authorize(code);

      console.log(
        "[GOOGLE] Authorization successful"
      );

      const root = await workspace.inspectRoot();

      if (root.reporterSheet) {
        const reporters =
          await workspace.loadReporters(
            root.reporterSheet
          );

        for (const reporter of reporters) {
          store.upsertReporter(reporter);
        }

        await store.save();

        reportersHydrated = true;

        console.log(
          `[GOOGLE] Hydrated ${reporters.length} reporters`
        );
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

      const reporterIds = new Set(
        records
          .map((record) =>
            record.reporterId?.trim()
          )
          .filter(
            (value): value is string =>
              Boolean(value)
          )
      );

      const reporters =
        getAllLocalReporters().filter(
          (reporter) =>
            reporterIds.has(reporter.id)
        );

      console.log(
        `[SYNC] Starting full local sync: ${records.length} coverage records, ${reporters.length} reporters`
      );

      const coverage =
        await workspace.syncLocalRecords(records, {
          clientContacts: store.snapshot.clientContacts,
          teamContacts: store.snapshot.teamContacts
        });

      const reportersSync =
        await workspace.syncMasterReporterList(
          reporters
        );

      console.log("[SYNC] Complete", {
        clients: coverage.clients.length,
        coverageAdded:
          coverage.totalAddedCoverageRows,
        coverageSkipped:
          coverage.totalSkippedCoverageRows,
        reportersAdded:
          reportersSync.addedReporterRows,
        reportersUpdated:
          reportersSync.updatedReporterRows,
        reportersSkipped:
          reportersSync.skippedReporterRows
      });

      return response.json({
        localRecordsConsidered:
          records.length,
        clientsSynced: coverage.clients,
        addedCoverageRows:
          coverage.totalAddedCoverageRows,
        skippedCoverageRows:
          coverage.totalSkippedCoverageRows,
        reporterSync: reportersSync,
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

      const reporters =
        getAllLocalReporters();

      const requestedClients: string[] = Array.isArray(
        request.body?.clients
      )
        ? request.body.clients
            .map((value: unknown) =>
              String(value ?? "").trim()
            )
            .filter(Boolean)
        : [];

      const filteredReporters =
        requestedClients.length > 0
          ? reporters.filter((reporter) => {
              const covered =
                reporter.clientsCovered
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean);

              return requestedClients.some(
                (client) =>
                  covered.some(
                    (coveredClient) =>
                      normalizeName(
                        coveredClient
                      ) ===
                      normalizeName(client)
                  )
              );
            })
          : reporters;

      const root =
        await workspace.inspectRoot();

      if (!root.reporterSheet) {
        throw new Error(
          "Master Reporter List was not found under the configured root"
        );
      }

      const uniqueReporters = new Map<
        string,
        typeof filteredReporters[number]
      >();

      for (const reporter of filteredReporters) {
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

      const result =
        await workspace.syncMasterReporterList(
          [...uniqueReporters.values()]
        );

      console.log(
        `[REPORTERS] Synced ${uniqueReporters.size} local reporters`
      );

      return response.json({
        ...result,
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

      const result =
        await workspace.applyEnrichmentProposals(
          approved,
          store.snapshot.reporters
        );

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

        if (
          result.discoveredReporterIds.length
        ) {
          const discovered =
            store.snapshot.reporters.filter(
              (reporter) =>
                result.discoveredReporterIds.includes(
                  reporter.id
                )
            );

          reporterSync =
            await workspace.syncMasterReporterList(
              discovered
            );
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

const port = Number(
  process.env.PORT ?? 3000
);

app.listen(port, () => {
  console.log(
    `Media List Builder running at http://localhost:${port}`
  );
});

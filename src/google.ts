import { google, drive_v3, sheets_v4 } from "googleapis";
import type {
  CoverageRecord,
  EnrichmentProposal,
  OutletRecord,
  ReporterRecord
} from "./domain.js";
import type { ContactRecord } from "./domain.js";
import { normalizeBeats, normalizeReporterType } from "./domain.js";
import { normalizeName } from "./normalize.js";
import {
  CONTACT_REPORT_HEADERS,
  COVERAGE_REPORT_HEADERS,
  OUTLET_REPORT_HEADERS,
  REPORTER_REPORT_HEADERS,
  coverageReportRow,
  canonicalCoverageRowsFromLegacy,
  outletReportRow,
  reporterReportKey,
  reporterReportRow,
  uniqueContactReportRows
} from "./report-projections.js";

const REPORTER_HEADERS = [
  "ID",
  "Outlet",
  "Reporter First Name",
  "Reporter Last Name",
  "Email",
  "Reporter Type",
  "Clients Covered",
  "Beats",
  "Notes",
  "Status"
];

const COVERAGE_HEADERS = COVERAGE_REPORT_HEADERS;

const OUTLET_HEADERS = ["Name", "UVM", "Link"];
const REPORT_SHEET_NAMES = ["Coverage", "Reporters", "Outlets", "Client Contact", "Team Contact"] as const;
const CONTACT_HEADERS = CONTACT_REPORT_HEADERS;
const URL_REVIEW_NOTE_PREFIX = "URL needs review.";

export function urlReviewNote(record: CoverageRecord): string | null {
  if (record.urlConfidence === "verified") return null;
  if (record.urlConfidence === "unresolved") return `${URL_REVIEW_NOTE_PREFIX} No plausible URL was found.`;
  const evidence = record.urlResolutionEvidence;
  if (!evidence) return `${URL_REVIEW_NOTE_PREFIX} Candidate URL was not verified.`;
  const date = evidence.publicationDateDistanceDays === null ? "not available" : `${evidence.publicationDateDistanceDays} days`;
  return `${URL_REVIEW_NOTE_PREFIX} Candidate was not verified. Query: ${evidence.query}\n` +
    `Outlet/domain match: ${evidence.outletDomainMatch ? "yes" : "no"}; title similarity: ${evidence.titleSimilarity.toFixed(2)}; ` +
    `reporter match: ${evidence.reporterMatch === null ? "not available" : evidence.reporterMatch ? "yes" : "no"}; publication-date distance: ${date}; score: ${evidence.score.toFixed(2)}.`;
}

export function coverageUrlReviewNeedsUpdate(
  record: CoverageRecord,
  state: { note: string; bold: boolean; backgroundColor?: { red?: number | null; green?: number | null; blue?: number | null } }
): boolean {
  const note = urlReviewNote(record);
  const needsReview = note !== null;
  const managedReviewState = state.note.startsWith(URL_REVIEW_NOTE_PREFIX);
  const reviewFormatMatches = state.bold && state.backgroundColor?.red === 1 &&
    state.backgroundColor?.green === 0.95 && state.backgroundColor?.blue === 0.6;
  if (needsReview) return state.note !== note || !reviewFormatMatches;
  return managedReviewState;
}

export interface GoogleDiagnostics {
  connected: boolean;
  root: { id: string; name: string };
  clientsFolder: { id: string; name: string } | null;
  clientFolders: Array<{ id: string; name: string }>;
  clientSheets: Array<{
    clientFolder: { id: string; name: string };
    sheets: Array<{ id: string; name: string; worksheetNames: string[] }>;
    coverageSheet: { id: string; name: string } | null;
  }>;
  masterReporterList: { id: string; name: string } | null;
  masterReporterHeader: string[] | null;
  masterReporterRawRows: number | null;
  masterReporterDataRows: number | null;
  masterOutletList: { id: string; name: string } | null;
  masterOutletHeader: string[] | null;
  masterOutletDataRows: number | null;
}

export interface ClientCoverageSyncResult {
  clientName: string;
  clientFolder: { id: string; name: string };
  coverageSheet: { id: string; name: string };
  addedCoverageRows: number;
  skippedCoverageRows: number;
  reportSheets: string[];
  createdReportSheets: string[];
  migratedFromOneTab: boolean;
  alreadyCompliant: boolean;
  coveragePreserved: boolean;
  coverageSkipDiagnostic: CoverageSkipDiagnostic | null;
}

export interface CoverageSkipDiagnostic {
  clientName: string;
  localRecordId: string;
  publicationDate: string;
  articleTitle: string;
  outlet: string;
  reporterName: string;
  localComparisonKey: string;
  skipReason: string;
  matchedGoogleRowNumber: number | null;
  matchedGoogleRow: string[] | null;
  matchedGoogleKey: string | null;
}

export interface CoverageSyncSummary {
  clients: ClientCoverageSyncResult[];
  totalAddedCoverageRows: number;
  totalSkippedCoverageRows: number;
  debug: {
    coverageSkips: CoverageSkipDiagnostic[];
  };
}

export interface ReporterSyncSummary {
  addedReporterRows: number;
  updatedReporterRows: number;
  skippedReporterRows: number;
  consideredReporters: number;
}

export class GoogleWorkspace {
  private readonly oauth: InstanceType<typeof google.auth.OAuth2>;
  readonly redirectUri: string;

  private drive!: drive_v3.Drive;
  private sheets!: sheets_v4.Sheets;

  constructor(private readonly rootFolderId: string) {
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

    this.redirectUri =
      process.env.GOOGLE_REDIRECT_URI?.trim() ||
      "http://localhost:3000/oauth2callback";

    if (!clientId || !clientSecret) {
      throw new Error(
        "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured"
      );
    }

    try {
      new URL(this.redirectUri);
    } catch {
      throw new Error(
        "GOOGLE_REDIRECT_URI must be a valid absolute URL"
      );
    }

    this.oauth = new google.auth.OAuth2(
      clientId,
      clientSecret,
      this.redirectUri
    );
  }

  get authorizationUrl(): string {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: this.redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/drive.metadata.readonly",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/spreadsheets"
      ].join(" ")
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async authorize(code: string): Promise<void> {
    const { tokens } = await this.oauth.getToken(code);

    this.oauth.setCredentials(tokens);

    this.drive = google.drive({
      version: "v3",
      auth: this.oauth
    });

    this.sheets = google.sheets({
      version: "v4",
      auth: this.oauth
    });
  }

  get connected(): boolean {
    return Boolean(this.drive && this.sheets);
  }

  private ensureConnected(): void {
    if (!this.drive || !this.sheets) {
      throw new Error("Google authorization is required");
    }
  }

  async inspectRoot(): Promise<{
    name: string;
    clientsFolder: string | undefined;
    reporterSheet: string | undefined;
    outletSheet: string | undefined;
  }> {
    this.ensureConnected();

    const root = await this.drive.files.get({
      fileId: this.rootFolderId,
      fields: "id,name,mimeType"
    });

    const children = await this.drive.files.list({
      q: `'${this.rootFolderId}' in parents and trashed = false`,
      fields: "files(id,name,mimeType)"
    });

    const files = children.data.files ?? [];

    const clientsFolder =
      files.find(
        (file) =>
          file.name?.trim().toLowerCase() === "clients" &&
          file.mimeType === "application/vnd.google-apps.folder"
      )?.id ?? undefined;

    const reporterSheet =
      files.find(
        (file) =>
          file.name?.trim().toLowerCase() ===
            "master reporter list" &&
          file.mimeType ===
            "application/vnd.google-apps.spreadsheet"
      )?.id ?? undefined;

    const outletSheet = files.find(
      (file) =>
        file.name?.trim() === "Master Outlet Sheet" &&
        file.mimeType === "application/vnd.google-apps.spreadsheet"
    )?.id ?? undefined;

    return {
      name: root.data.name ?? "Media List Builder",
      clientsFolder,
      reporterSheet,
      outletSheet
    };
  }

  async diagnostics(): Promise<GoogleDiagnostics> {
    this.ensureConnected();

    const rootResponse = await this.drive.files.get({
      fileId: this.rootFolderId,
      fields: "id,name"
    });

    const rootChildren = await this.drive.files.list({
      q: `'${this.rootFolderId}' in parents and trashed = false`,
      fields: "files(id,name,mimeType)"
    });

    const files = rootChildren.data.files ?? [];

    const clients = files.find(
      (file) =>
        file.name?.trim().toLowerCase() === "clients" &&
        file.mimeType === "application/vnd.google-apps.folder"
    );

    const master = files.find(
      (file) =>
        file.name?.trim().toLowerCase() ===
          "master reporter list" &&
        file.mimeType ===
          "application/vnd.google-apps.spreadsheet"
    );

    const outletMaster = files.find(
      (file) =>
        file.name?.trim() === "Master Outlet Sheet" &&
        file.mimeType === "application/vnd.google-apps.spreadsheet"
    );

    const clientFolderFiles = clients?.id
      ? await this.drive.files.list({
          q: `'${clients.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: "files(id,name)"
        })
      : { data: { files: [] } };

    const clientFolders = (clientFolderFiles.data.files ?? []).map(
      (file) => ({
        id: file.id!,
        name: file.name ?? ""
      })
    );

    const clientSheets: GoogleDiagnostics["clientSheets"] = [];

    for (const clientFolder of clientFolders) {
      const sheetsResponse = await this.drive.files.list({
        q: `'${clientFolder.id}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: "files(id,name)"
      });

      const sheets = [] as Array<{ id: string; name: string; worksheetNames: string[] }>;
      for (const file of sheetsResponse.data.files ?? []) {
        const metadata = await this.sheets.spreadsheets.get({
          spreadsheetId: file.id!,
          fields: "sheets(properties(title))"
        });
        sheets.push({
          id: file.id!,
          name: file.name ?? "",
          worksheetNames: (metadata.data.sheets ?? [])
            .map((sheet) => sheet.properties?.title ?? "")
            .filter(Boolean)
        });
      }

      const expectedName = `${clientFolder.name} - Media Coverage`;

      clientSheets.push({
        clientFolder,
        sheets,
        coverageSheet:
          sheets.find(
            (sheet) =>
              normalizeName(sheet.name) ===
              normalizeName(expectedName)
          ) ?? null
      });
    }

    const masterRows = master?.id
      ? await this.sheets.spreadsheets.values.get({
          spreadsheetId: master.id,
          range: "A:J"
        })
      : null;

    const masterValues = masterRows?.data.values ?? [];
    const outletRows = outletMaster?.id
      ? await this.sheets.spreadsheets.values.get({
          spreadsheetId: outletMaster.id,
          range: "A:C"
        })
      : null;
    const outletValues = outletRows?.data.values ?? [];

    return {
      connected: true,
      root: {
        id: rootResponse.data.id!,
        name: rootResponse.data.name ?? ""
      },
      clientsFolder: clients?.id
        ? { id: clients.id, name: clients.name ?? "" }
        : null,
      clientFolders,
      clientSheets,
      masterReporterList: master?.id
        ? { id: master.id, name: master.name ?? "" }
        : null,
      masterReporterHeader: masterRows
        ? (masterValues[0] ?? [])
        : null,
      masterReporterRawRows: masterRows
        ? masterValues.length
        : null,
      masterReporterDataRows: masterRows
        ? Math.max(masterValues.length - 1, 0)
        : null,
      masterOutletList: outletMaster?.id
        ? { id: outletMaster.id, name: outletMaster.name ?? "Master Outlet Sheet" }
        : null,
      masterOutletHeader: outletRows ? (outletValues[0] ?? []) : null,
      masterOutletDataRows: outletRows
        ? Math.max(outletValues.length - 1, 0)
        : null
    };
  }

  async loadOutlets(spreadsheetId: string): Promise<OutletRecord[]> {
    this.ensureConnected();

    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "A:C"
    });
    const rows = response.data.values ?? [];
    const header = rows[0] ?? [];
    const indexOf = (name: string) => header.findIndex(
      (value) => String(value ?? "").trim().toLowerCase() === name.toLowerCase()
    );
    const nameIndex = indexOf("Name");
    const uvmIndex = indexOf("UVM");
    const linkIndex = indexOf("Link");

    const hasExactHeaders = header.length === OUTLET_HEADERS.length &&
      OUTLET_HEADERS.every((name, index) => String(header[index] ?? "").trim().toLowerCase() === name.toLowerCase());
    if (!hasExactHeaders || nameIndex < 0 || uvmIndex < 0 || linkIndex < 0) {
      throw new Error("Master Outlet Sheet must have exactly the headers Name, UVM, Link");
    }

    return rows.slice(1)
      .map((row) => {
        const name = String(row[nameIndex] ?? "").trim();
        const rawUvm = String(row[uvmIndex] ?? "").replaceAll(",", "").trim();
        const parsedUvm = rawUvm ? Number(rawUvm) : null;
        return {
          name,
          uvm: parsedUvm !== null && Number.isFinite(parsedUvm) ? parsedUvm : null,
          link: String(row[linkIndex] ?? "").trim()
        };
      })
      .filter((outlet) => outlet.name);
  }

  async loadReporters(
    spreadsheetId: string
  ): Promise<ReporterRecord[]> {
    this.ensureConnected();

    const response =
      await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "A:Z"
      });

    const rows = response.data.values ?? [];
    const header = rows[0] ?? [];

    return rows
      .slice(1)
      .filter((row) => row[0] || row[2] || row[3])
      .map((row) => {
        const index = this.reporterFieldIndex(header, "ID");
        const outletIndex = this.reporterFieldIndex(header, "Outlet");
        const firstNameIndex = this.reporterFieldIndex(header, "Reporter First Name");
        const lastNameIndex = this.reporterFieldIndex(header, "Reporter Last Name");
        const emailIndex = this.reporterFieldIndex(header, "Email");
        const typeIndex = this.reporterFieldIndex(header, "Reporter Type");
        const clientsIndex = this.reporterFieldIndex(header, "Clients Covered");
        const beatsIndex = this.reporterFieldIndex(header, "Beats");
        const notesIndex = this.reporterFieldIndex(header, "Notes");
        const statusIndex = this.reporterFieldIndex(header, "Status");

        return {
          id: String(row[index >= 0 ? index : 0] ?? ""),
          outlet: String(row[outletIndex >= 0 ? outletIndex : 1] ?? ""),
          firstName: String(row[firstNameIndex >= 0 ? firstNameIndex : 2] ?? ""),
          lastName: String(row[lastNameIndex >= 0 ? lastNameIndex : 3] ?? ""),
          email: String(row[emailIndex >= 0 ? emailIndex : 4] ?? ""),
          clientsCovered: String(row[clientsIndex >= 0 ? clientsIndex : 5] ?? ""),
          beats: String(row[beatsIndex >= 0 ? beatsIndex : 6] ?? ""),
          notes: String(row[notesIndex >= 0 ? notesIndex : 8] ?? ""),
          status:
            String(row[statusIndex >= 0 ? statusIndex : 9] ?? "") === "Inactive"
              ? "Inactive"
              : String(row[statusIndex >= 0 ? statusIndex : 9] ?? "") === "Needs Review"
                ? "Needs Review"
                : "Active",
          reporterType: this.normalizeReporterType(String(typeIndex >= 0 ? row[typeIndex] ?? "" : "reporter"))
        };
      });
  }

  async syncLocalRecords(
    records: CoverageRecord[],
    contacts: { clientContacts: ContactRecord[]; teamContacts: ContactRecord[] } = {
      clientContacts: [],
      teamContacts: []
    }
  ): Promise<CoverageSyncSummary> {
    this.ensureConnected();

    const root = await this.inspectRoot();

    if (!root.clientsFolder) {
      throw new Error(
        "The configured root folder does not contain a Clients folder"
      );
    }

    const recordsByClient = new Map<string, CoverageRecord[]>();

    for (const record of records) {
      const clientName = record.clientName.trim();
      if (!clientName) {
        continue;
      }

      const key = normalizeName(clientName);
      const bucket = recordsByClient.get(key) ?? [];
      bucket.push(record);
      recordsByClient.set(key, bucket);
    }

    const clients: ClientCoverageSyncResult[] = [];

    for (const clientRecords of recordsByClient.values()) {
      const clientName = clientRecords[0].clientName.trim();
      const syncResult = await this.syncClientCoverage(
        clientName,
        clientRecords,
        root.clientsFolder,
        contacts
      );
      clients.push(syncResult);
    }

    return {
      clients,
      totalAddedCoverageRows: clients.reduce(
        (sum, item) => sum + item.addedCoverageRows,
        0
      ),
      totalSkippedCoverageRows: clients.reduce(
        (sum, item) => sum + item.skippedCoverageRows,
        0
      ),
      debug: {
        coverageSkips: clients
          .map((client) => client.coverageSkipDiagnostic)
          .filter((diagnostic): diagnostic is CoverageSkipDiagnostic => diagnostic !== null)
      }
    };
  }

  async syncClientCoverage(
    clientName: string,
    records: CoverageRecord[],
    clientsFolderId?: string,
    contacts: { clientContacts: ContactRecord[]; teamContacts: ContactRecord[] } = {
      clientContacts: [],
      teamContacts: []
    }
  ): Promise<ClientCoverageSyncResult> {
    this.ensureConnected();

    const root = clientsFolderId
      ? undefined
      : await this.inspectRoot();

    const resolvedClientsFolderId =
      clientsFolderId ?? root?.clientsFolder;

    if (!resolvedClientsFolderId) {
      throw new Error(
        "The configured root folder does not contain a Clients folder"
      );
    }

    const clientFolder = await this.findOrCreateFolder(
      clientName,
      resolvedClientsFolderId
    );

    const coverageName = `${clientName} - Media Coverage`;
    const coverageSheet = await this.findOrCreateSheet(
      coverageName,
      clientFolder.id!
    );

    const existing =
      await this.sheets.spreadsheets.values.get({
        spreadsheetId: coverageSheet.id!,
        range: "A:K"
      });

    let existingRows = existing.data.values ?? [];

    const existingHeader = existingRows[0] ?? [];
    const hasCanonicalHeader = COVERAGE_HEADERS.every(
      (value, index) => String(existingHeader[index] ?? "").trim().toLowerCase() === value.toLowerCase()
    ) && existingHeader.length === COVERAGE_HEADERS.length;

    if (existingRows.length && !hasCanonicalHeader) {
      const migratedRows = canonicalCoverageRowsFromLegacy(existingRows);
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: coverageSheet.id!,
        range: `A1:K${Math.max(migratedRows.length + 1, 1)}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [COVERAGE_HEADERS, ...migratedRows] }
      });
      existingRows = [COVERAGE_HEADERS, ...migratedRows];
    }

    const outletMap = new Map<string, OutletRecord>();
    const rootForOutlets = await this.inspectRoot();
    if (rootForOutlets.outletSheet) {
      for (const outlet of await this.loadOutlets(rootForOutlets.outletSheet)) {
        outletMap.set(normalizeName(outlet.name), outlet);
      }
    }

    const reporterMap = new Map<string, ReporterRecord>();
    if (rootForOutlets.reporterSheet) {
      for (const reporter of await this.loadReporters(rootForOutlets.reporterSheet)) {
        reporterMap.set(reporter.id, reporter);
      }
    }

    const existingKeys = new Set(
      existingRows.slice(1).map((row) =>
        this.coverageKey(
          String(row[0] ?? ""),
          String(row[3] ?? ""),
          String(row[4] ?? ""),
          String(row[1] ?? ""),
          String(row[10] ?? "")
        )
      )
    );

    const rowsToAppend: string[][] = [];
    const appendedReviewRecords: CoverageRecord[] = [];
    const reviewRows: Array<{ rowNumber: number; record: CoverageRecord }> = [];
    const rowsToUpdate: sheets_v4.Schema$ValueRange[] = [];
    let skippedCoverageRows = 0;
    let skipDiagnosticLogged = false;
    let coverageSkipDiagnostic: CoverageSkipDiagnostic | null = null;

    for (const record of records) {
      const masterOutlet = outletMap.get(normalizeName(record.outlet));
      const masterReporter = record.reporterId
        ? reporterMap.get(record.reporterId)
        : undefined;
      const resolvedReporter = masterReporter ?? [...reporterMap.values()].find((candidate) =>
        normalizeName(`${candidate.firstName} ${candidate.lastName}`) === normalizeName(record.reporterName) &&
        normalizeName(candidate.outlet) === normalizeName(record.outlet)
      );
      const row = coverageReportRow(record, masterOutlet, resolvedReporter);

      const key = this.coverageKey(
        row[0],
        row[3],
        row[4],
        row[1],
        row[10]
      );

      const existingRowIndex = existingRows.slice(1).findIndex((existingRow) => {
        const sameKey = this.coverageKey(
          String(existingRow[0] ?? ""),
          String(existingRow[3] ?? ""),
          String(existingRow[4] ?? ""),
          String(existingRow[1] ?? ""),
          String(existingRow[10] ?? "")
        ) === key;
        const sameLegacyIdentity = !String(existingRow[10] ?? "").trim() &&
          String(existingRow[0] ?? "") === row[0] &&
          normalizeName(String(existingRow[3] ?? "")) === normalizeName(row[3]) &&
          normalizeName(String(existingRow[4] ?? "")) === normalizeName(row[4]) &&
          String(existingRow[1] ?? "") === row[1];
        return sameKey || sameLegacyIdentity;
      });

      if (existingRowIndex >= 0) {
        const rowNumber = existingRowIndex + 2;
        reviewRows.push({ rowNumber, record });
        const existingRow = existingRows[rowNumber - 1] ?? [];
        if (row.some((value, index) => String(existingRow[index] ?? "") !== value)) {
          rowsToUpdate.push({ range: `A${rowNumber}:K${rowNumber}`, values: [row] });
        } else {
          skippedCoverageRows += 1;
          if (!coverageSkipDiagnostic) {
            coverageSkipDiagnostic = {
              clientName,
              localRecordId: record.id,
              publicationDate: record.publicationDate,
              articleTitle: record.articleTitle,
              outlet: record.outlet,
              reporterName: record.reporterName,
              localComparisonKey: key,
              skipReason: "existing Google row matched and values were unchanged",
              matchedGoogleRowNumber: rowNumber,
              matchedGoogleRow: existingRow,
              matchedGoogleKey: this.coverageKey(
                String(existingRow[0] ?? ""),
                String(existingRow[3] ?? ""),
                String(existingRow[4] ?? ""),
                String(existingRow[1] ?? ""),
                String(existingRow[10] ?? "")
              )
            };
          }
          if (!skipDiagnosticLogged) {
            console.log("[GOOGLE][COVERAGE SKIP DIAGNOSTIC]", {
              clientName,
              spreadsheetId: coverageSheet.id,
              fetchedRange: "A:K",
              existingRowCount: Math.max(existingRows.length - 1, 0),
              localRecordId: record.id,
              localRow: row,
              localKey: key,
              matchType: "existing-row",
              matchedRowNumber: rowNumber,
              matchedRow: existingRow,
              matchedKey: this.coverageKey(
                String(existingRow[0] ?? ""),
                String(existingRow[3] ?? ""),
                String(existingRow[4] ?? ""),
                String(existingRow[1] ?? ""),
                String(existingRow[10] ?? "")
              )
            });
            skipDiagnosticLogged = true;
          }
        }
        continue;
      }

      if (existingKeys.has(key)) {
        skippedCoverageRows += 1;
        if (!coverageSkipDiagnostic) {
          const matchedGoogleRowIndex = existingRows.slice(1).findIndex((existingRow) =>
            this.coverageKey(
              String(existingRow[0] ?? ""),
              String(existingRow[3] ?? ""),
              String(existingRow[4] ?? ""),
              String(existingRow[1] ?? ""),
              String(existingRow[10] ?? "")
            ) === key
          );
          const matchedGoogleRow = matchedGoogleRowIndex >= 0
            ? existingRows[matchedGoogleRowIndex + 1] ?? null
            : null;
          coverageSkipDiagnostic = {
            clientName,
            localRecordId: record.id,
            publicationDate: record.publicationDate,
            articleTitle: record.articleTitle,
            outlet: record.outlet,
            reporterName: record.reporterName,
            localComparisonKey: key,
            skipReason: "comparison key already exists in Google Coverage rows",
            matchedGoogleRowNumber: matchedGoogleRow ? matchedGoogleRowIndex + 2 : null,
            matchedGoogleRow,
            matchedGoogleKey: matchedGoogleRow ? key : null
          };
        }
        if (!skipDiagnosticLogged) {
          console.log("[GOOGLE][COVERAGE SKIP DIAGNOSTIC]", {
            clientName,
            spreadsheetId: coverageSheet.id,
            fetchedRange: "A:K",
            existingRowCount: Math.max(existingRows.length - 1, 0),
            localRecordId: record.id,
            localRow: row,
            localKey: key,
            matchType: "existing-key-set",
            matchedRow: existingRows.slice(1).find((existingRow) =>
              this.coverageKey(
                String(existingRow[0] ?? ""),
                String(existingRow[3] ?? ""),
                String(existingRow[4] ?? ""),
                String(existingRow[1] ?? ""),
                String(existingRow[10] ?? "")
              ) === key
            ) ?? null
          });
          skipDiagnosticLogged = true;
        }
        continue;
      }

      existingKeys.add(key);
      rowsToAppend.push(row);
      appendedReviewRecords.push(record);
    }

    if (rowsToAppend.length || !existingRows.length) {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: coverageSheet.id!,
        range: "A:K",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [
            ...(!existingRows.length
              ? [COVERAGE_HEADERS]
              : []),
            ...rowsToAppend
          ]
        }
      });
    }

    if (rowsToUpdate.length) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: coverageSheet.id!,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: rowsToUpdate
        }
      });
    }

    const appendedStartRow = existingRows.length ? existingRows.length + 1 : 2;
    appendedReviewRecords.forEach((record, index) => reviewRows.push({ rowNumber: appendedStartRow + index, record }));
    await this.syncCoverageUrlReviewFormatting(coverageSheet.id!, reviewRows);

    const reportSheetResult = await this.syncClientReportSheets(
      coverageSheet.id!,
      clientName,
      records,
      outletMap,
      reporterMap,
      contacts
    );

    return {
      clientName,
      clientFolder: {
        id: clientFolder.id!,
        name: clientFolder.name ?? clientName
      },
      coverageSheet: {
        id: coverageSheet.id!,
        name: coverageSheet.name ?? coverageName
      },
      addedCoverageRows: rowsToAppend.length,
      skippedCoverageRows,
      reportSheets: reportSheetResult.reportSheets,
      createdReportSheets: reportSheetResult.createdReportSheets,
      migratedFromOneTab: reportSheetResult.migratedFromOneTab,
      alreadyCompliant: reportSheetResult.alreadyCompliant,
      coveragePreserved: reportSheetResult.coveragePreserved,
      coverageSkipDiagnostic
    };
  }

  private async syncClientReportSheets(
    spreadsheetId: string,
    clientName: string,
    records: CoverageRecord[],
    outletMap: Map<string, OutletRecord>,
    reporterMap: Map<string, ReporterRecord>,
    contacts: { clientContacts: ContactRecord[]; teamContacts: ContactRecord[] }
  ): Promise<{
    reportSheets: string[];
    createdReportSheets: string[];
    migratedFromOneTab: boolean;
    alreadyCompliant: boolean;
    coveragePreserved: boolean;
  }> {
    const metadata = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(sheetId,title,index),data(startRow,startColumn,rowData(values(effectiveValue,effectiveFormat(textFormat(fontFamily,bold))))))"
    });
    const sheets = metadata.data.sheets ?? [];
    const existingReportNames = sheets
      .map((sheet) => sheet.properties?.title ?? "")
      .filter((title): title is typeof REPORT_SHEET_NAMES[number] => REPORT_SHEET_NAMES.includes(title as typeof REPORT_SHEET_NAMES[number]));
    const createdReportSheets = REPORT_SHEET_NAMES.filter((title) => !existingReportNames.includes(title));
    const alreadyCompliant = existingReportNames.length === REPORT_SHEET_NAMES.length &&
      new Set(existingReportNames).size === REPORT_SHEET_NAMES.length;
    const byTitle = new Map<string, sheets_v4.Schema$Sheet>();
    const duplicateSheetIds: number[] = [];

    for (const sheet of sheets) {
      const title = sheet.properties?.title ?? "";
      if (!REPORT_SHEET_NAMES.includes(title as typeof REPORT_SHEET_NAMES[number])) {
        continue;
      }
      if (byTitle.has(title)) {
        if (sheet.properties?.sheetId != null) duplicateSheetIds.push(sheet.properties.sheetId);
      } else {
        byTitle.set(title, sheet);
      }
    }

    const requests: sheets_v4.Schema$Request[] = duplicateSheetIds.map((sheetId) => ({
      deleteSheet: { sheetId }
    }));
    for (const title of REPORT_SHEET_NAMES) {
      if (!byTitle.has(title)) {
        requests.push({ addSheet: { properties: { title } } });
      }
    }
    if (requests.length) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests }
      });
    }

    const refreshed = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(sheetId,title,index),data(startRow,startColumn,rowData(values(effectiveValue,effectiveFormat(textFormat(fontFamily,bold))))))"
    });
    const finalSheets = new Map(
      (refreshed.data.sheets ?? []).map((sheet) => [sheet.properties?.title ?? "", sheet])
    );
    const orderRequests: sheets_v4.Schema$Request[] = [];
    REPORT_SHEET_NAMES.forEach((title, index) => {
      const properties = finalSheets.get(title)?.properties;
      const sheetId = properties?.sheetId;
      const currentIndex = properties?.index;
      if (sheetId !== undefined && currentIndex !== index) {
        orderRequests.push({ updateSheetProperties: {
          properties: { sheetId, index },
          fields: "index"
        } });
      }
    });
    if (orderRequests.length) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: orderRequests }
      });
    }

    const relevantReporters = new Map<string, ReporterRecord>();
    for (const record of records) {
      const reporter = (record.reporterId ? reporterMap.get(record.reporterId) : undefined) ??
        [...reporterMap.values()].find((candidate) =>
          normalizeName(`${candidate.firstName} ${candidate.lastName}`) === normalizeName(record.reporterName) &&
          normalizeName(candidate.outlet) === normalizeName(record.outlet)
        );
      const key = reporterReportKey(reporter ?? {
        firstName: record.reporterName,
        lastName: "",
        outlet: record.outlet
      });
      if (key) {
        relevantReporters.set(key, reporter ?? {
          id: "",
          firstName: record.reporterName,
          lastName: "",
          outlet: record.outlet,
          email: "",
          clientsCovered: clientName,
          beats: "",
          reporterType: "reporter",
          notes: "Unmatched in Master Reporter List",
          status: "Needs Review"
        });
      }
    }
    const relevantOutlets = new Map<string, { record: CoverageRecord; outlet: OutletRecord | undefined }>();
    for (const record of records) {
      const key = normalizeName(record.outlet);
      if (key && !relevantOutlets.has(key)) relevantOutlets.set(key, { record, outlet: outletMap.get(key) });
    }
    const rows = {
      Coverage: [COVERAGE_HEADERS, ...records.map((record) => {
        const outlet = outletMap.get(normalizeName(record.outlet));
        const reporter = (record.reporterId ? reporterMap.get(record.reporterId) : undefined) ??
          [...reporterMap.values()].find((candidate) =>
            normalizeName(`${candidate.firstName} ${candidate.lastName}`) === normalizeName(record.reporterName) &&
            normalizeName(candidate.outlet) === normalizeName(record.outlet)
          );
        return coverageReportRow(record, outlet, reporter);
      })],
      Reporters: [REPORTER_REPORT_HEADERS, ...[...relevantReporters.values()].map(reporterReportRow)],
      Outlets: [OUTLET_REPORT_HEADERS, ...[...relevantOutlets.values()].map(({ record, outlet }) => outletReportRow(record, outlet))],
      "Client Contact": [CONTACT_HEADERS, ...uniqueContactReportRows(contacts.clientContacts, clientName)],
      "Team Contact": [CONTACT_HEADERS, ...uniqueContactReportRows(contacts.teamContacts, clientName)]
    };

    const reportRanges = REPORT_SHEET_NAMES.map((title) =>
      `'${title.replaceAll("'", "''")}'!A:K`
    );
    const existingReportValues = await this.sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: reportRanges
    });

    const normalizeGrid = (grid: unknown[][]): string[][] => {
      const normalized = grid.map((row) => {
        const cells = row.map((value) => String(value ?? ""));
        let end = cells.length;
        while (end > 0 && cells[end - 1] === "") {
          end -= 1;
        }
        return cells.slice(0, end);
      });

      let rowEnd = normalized.length;
      while (rowEnd > 0 && normalized[rowEnd - 1].length === 0) {
        rowEnd -= 1;
      }
      return normalized.slice(0, rowEnd);
    };

    const changedTitles = REPORT_SHEET_NAMES.filter((title, index) => {
      const currentValues = normalizeGrid((existingReportValues.data.valueRanges?.[index]?.values ?? []) as unknown[][]);
      const nextValues = normalizeGrid(rows[title]);
      return JSON.stringify(currentValues) !== JSON.stringify(nextValues);
    });

    // A values.batchUpdate replaces every supplied cell (including supplied
    // empty strings). Clearing is only needed when the existing grid has data
    // outside the desired grid, where a values update cannot reach it.
    const titlesRequiringClear = changedTitles.filter((title) => {
      const reportIndex = REPORT_SHEET_NAMES.indexOf(title);
      const currentValues = (existingReportValues.data.valueRanges?.[reportIndex]?.values ?? []) as unknown[][];
      const nextValues = rows[title];

      return currentValues.some((row, rowIndex) =>
        row.some((value, columnIndex) =>
          String(value ?? "") !== "" &&
          (rowIndex >= nextValues.length ||
            columnIndex >= (nextValues[rowIndex]?.length ?? 0))
        )
      );
    });

    if (titlesRequiringClear.length) {
      await this.sheets.spreadsheets.values.batchClear({
        spreadsheetId,
        requestBody: {
          ranges: titlesRequiringClear.map((title) =>
            `'${title.replaceAll("'", "''")}'!A:K`
          )
        }
      });
    }

    if (changedTitles.length) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: changedTitles.map((title) => ({
            range: `'${title.replaceAll("'", "''")}'!A1`,
            values: rows[title]
          }))
        }
      });
    }

    const formattingRequests: sheets_v4.Schema$Request[] = [];
    const titlesNeedingFormatting = new Set([...changedTitles, ...createdReportSheets]);
    for (const title of REPORT_SHEET_NAMES) {
      const sheet = finalSheets.get(title);
      const rowData = sheet?.data?.flatMap((grid) => grid.rowData ?? []) ?? [];
      const hasFormatMismatch = rowData.some((row, rowIndex) =>
        (row.values ?? []).some((cell) => {
          if (cell.effectiveValue === undefined) return false;
          const textFormat = cell.effectiveFormat?.textFormat;
          return textFormat?.fontFamily !== "Calibri" ||
            (rowIndex === 0 && textFormat?.bold !== true);
        })
      );
      if (hasFormatMismatch) titlesNeedingFormatting.add(title);
    }
    for (const title of titlesNeedingFormatting) {
      const sheetId = finalSheets.get(title)?.properties?.sheetId;
      if (sheetId === undefined) continue;
      formattingRequests.push(
        {
          repeatCell: {
            range: { sheetId },
            cell: { userEnteredFormat: { textFormat: { fontFamily: "Calibri" } } },
            fields: "userEnteredFormat.textFormat.fontFamily"
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { fontFamily: "Calibri", bold: true } } },
            fields: "userEnteredFormat.textFormat(fontFamily,bold)"
          }
        }
      );
    }
    if (formattingRequests.length) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: formattingRequests }
      });
    }

    return {
      reportSheets: [...REPORT_SHEET_NAMES],
      createdReportSheets: [...createdReportSheets],
      migratedFromOneTab: existingReportNames.length === 1 && existingReportNames[0] === "Coverage",
      alreadyCompliant,
      coveragePreserved: true
    };
  }

  /** Applies review formatting in one Sheets batch, and only when the URL cell differs. */
  private async syncCoverageUrlReviewFormatting(
    spreadsheetId: string,
    rows: Array<{ rowNumber: number; record: CoverageRecord }>
  ): Promise<void> {
    if (!rows.length) return;
    const maxRow = Math.max(...rows.map((item) => item.rowNumber));
    const metadata = await this.sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [`K2:K${maxRow}`],
      includeGridData: true,
      fields: "sheets(properties(sheetId,index),data(startRow,rowData(values(note,effectiveFormat(textFormat(bold),backgroundColor),userEnteredFormat(textFormat(bold),backgroundColor)))))"
    });
    const sheet = (metadata.data.sheets ?? []).find((item) => item.properties?.index === 0);
    const sheetId = sheet?.properties?.sheetId;
    if (!sheet || sheetId === undefined) return;
    const grid = sheet.data?.[0];
    const startRow = grid?.startRow ?? 1;
    const cells = grid?.rowData ?? [];
    const requests: sheets_v4.Schema$Request[] = [];
    for (const { rowNumber, record } of rows) {
      const note = urlReviewNote(record);
      const cell = cells[rowNumber - 1 - startRow]?.values?.[0];
      const existingNote = cell?.note ?? "";
      const existingBold = cell?.effectiveFormat?.textFormat?.bold === true;
      const needsReview = note !== null;
      if (!coverageUrlReviewNeedsUpdate(record, { note: existingNote, bold: existingBold, backgroundColor: cell?.effectiveFormat?.backgroundColor ?? undefined })) continue;
      requests.push({ updateCells: {
        range: { sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: 10, endColumnIndex: 11 },
        rows: [{ values: [{ note: note ?? "", userEnteredFormat: needsReview
          ? { textFormat: { bold: true }, backgroundColor: { red: 1, green: 0.95, blue: 0.6 } }
          : { textFormat: { bold: false }, backgroundColor: { red: 1, green: 1, blue: 1 } } }] }],
        fields: "note,userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor"
      }});
    }
    if (requests.length) await this.sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }

  async syncMasterReporterList(
    reporters: ReporterRecord[]
  ): Promise<ReporterSyncSummary> {
    this.ensureConnected();

    const root = await this.inspectRoot();

    if (!root.reporterSheet) {
      throw new Error(
        "The existing Master Reporter List was not found under the configured root"
      );
    }

    const response =
      await this.sheets.spreadsheets.values.get({
        spreadsheetId: root.reporterSheet,
        range: "A:Z"
      });

    const existingRows = await this.ensureCanonicalReporterLayout(
      root.reporterSheet,
      response.data.values ?? []
    );

    const rowsById = new Map<string, number>();
    const rowsByKey = new Map<string, number>();
    const header = REPORTER_HEADERS;

    existingRows.slice(1).forEach((row, index) => {
      const rowNumber = index + 2;
      const id = String(row[this.reporterFieldIndex(header, "ID")] ?? "").trim();

      if (id) {
        rowsById.set(id, rowNumber);
      }

      rowsByKey.set(
        this.reporterKey(
          String(row[this.reporterFieldIndex(header, "Outlet")] ?? ""),
          String(row[this.reporterFieldIndex(header, "Reporter First Name")] ?? ""),
          String(row[this.reporterFieldIndex(header, "Reporter Last Name")] ?? "")
        ),
        rowNumber
      );
    });

    const updates: sheets_v4.Schema$ValueRange[] = [];
    const appends: string[][] = [];
    const appendKeys = new Set<string>();

    let skippedReporterRows = 0;

    for (const reporter of reporters) {
      const row = this.reporterRow(reporter);
      const key = this.reporterKey(
        reporter.outlet,
        reporter.firstName,
        reporter.lastName
      );

      const rowNumber =
        rowsById.get(reporter.id) ?? rowsByKey.get(key);

      if (rowNumber) {
        const existing = existingRows[rowNumber - 1] ?? [];

        const unchanged = row.every(
          (value, index) =>
            String(existing[index] ?? "") === value
        );

        if (unchanged) {
          skippedReporterRows += 1;
          continue;
        }

        updates.push({
          range: `A${rowNumber}:J${rowNumber}`,
          values: [row]
        });
      } else if (!appendKeys.has(key)) {
        appends.push(row);
        appendKeys.add(key);
      } else {
        skippedReporterRows += 1;
      }
    }

    if (appends.length) {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: root.reporterSheet,
        range: "A:J",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: appends
        }
      });
    }

    if (updates.length) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: root.reporterSheet,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updates
        }
      });
    }

    return {
      addedReporterRows: appends.length,
      updatedReporterRows: updates.length,
      skippedReporterRows,
      consideredReporters: reporters.length
    };
  }

  async applyEnrichmentProposals(
    proposals: EnrichmentProposal[],
    localReporters: ReporterRecord[] = []
  ): Promise<{ updated: number; added: number }> {
    this.ensureConnected();

    const root = await this.inspectRoot();

    if (!root.reporterSheet) {
      throw new Error(
        "The existing Master Reporter List was not found under the configured root"
      );
    }

    const response =
      await this.sheets.spreadsheets.values.get({
        spreadsheetId: root.reporterSheet,
        range: "A:Z"
      });

    const rows = await this.ensureCanonicalReporterLayout(
      root.reporterSheet,
      response.data.values ?? []
    );
    const header = REPORTER_HEADERS;
    const localReportersById = new Map(
      localReporters.map((reporter) => [reporter.id, reporter])
    );

    const rowsById = new Map<string, number>();
    const rowsByKey = new Map<string, number>();

    rows.slice(1).forEach((row, index) => {
      const rowNumber = index + 2;
      const idIndex = this.reporterFieldIndex(header, "ID");
      const outletIndex = this.reporterFieldIndex(header, "Outlet");
      const firstNameIndex = this.reporterFieldIndex(header, "Reporter First Name");
      const lastNameIndex = this.reporterFieldIndex(header, "Reporter Last Name");

      if (row[idIndex >= 0 ? idIndex : 0]) {
        rowsById.set(String(row[idIndex >= 0 ? idIndex : 0]).trim(), rowNumber);
      }

      rowsByKey.set(
        this.reporterKey(
          String(row[outletIndex >= 0 ? outletIndex : 1] ?? ""),
          String(row[firstNameIndex >= 0 ? firstNameIndex : 2] ?? ""),
          String(row[lastNameIndex >= 0 ? lastNameIndex : 3] ?? "")
        ),
        rowNumber
      );
    });

    const updates: sheets_v4.Schema$ValueRange[] = [];
    const appends: string[][] = [];

    for (const proposal of proposals) {
      const parts = proposal.reporterName
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      const firstName = parts.shift() ?? "";
      const lastName = parts.join(" ");

      const row = [
        proposal.reporterId ?? "",
        proposal.outlet,
        firstName,
        lastName,
        proposal.email ?? "",
        normalizeReporterType(proposal.reporterType),
        "",
        normalizeBeats(proposal.beats).join(", "),
        "",
        proposal.status === "verified"
          ? "Active"
          : "Needs Review"
      ];

      const rowNumber =
        (proposal.reporterId &&
          rowsById.get(proposal.reporterId)) ??
        rowsByKey.get(
          this.reporterKey(
            row[1],
            row[2],
            row[3]
          )
        );

      if (rowNumber) {
        const existingRow = rows[rowNumber - 1] ?? [];
        // These two fields are managed by people, never enrichment.
        row[6] = String(existingRow[6] ?? "");
        row[8] = String(existingRow[8] ?? "");

        updates.push({
          range: `A${rowNumber}:J${rowNumber}`,
          values: [row]
        });
      } else {
        row[6] = localReportersById.get(proposal.reporterId ?? "")?.clientsCovered ?? "";
        appends.push(row);
      }
    }

    if (appends.length) {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: root.reporterSheet,
        range: "A:J",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: appends
        }
      });
    }

    if (updates.length) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: root.reporterSheet,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updates
        }
      });
    }

    return {
      updated: updates.length,
      added: appends.length
    };
  }

  private reporterRow(reporter: ReporterRecord): string[] {
    return [
      reporter.id,
      reporter.outlet,
      reporter.firstName,
      reporter.lastName,
      reporter.email,
      reporter.reporterType,
      reporter.clientsCovered,
      reporter.beats,
      reporter.notes,
      reporter.status
    ];
  }

  private reporterFieldIndex(headers: string[], headerName: string): number {
    const key = String(headerName).trim().toLowerCase();
    const index = headers.findIndex(
      (header) => String(header ?? "").trim().toLowerCase() === key
    );
    return index >= 0 ? index : -1;
  }

  private async ensureCanonicalReporterLayout(
    spreadsheetId: string,
    rows: unknown[][]
  ): Promise<string[][]> {
    const header = (rows[0] ?? []).map((value) => String(value ?? ""));
    const isCanonical = REPORTER_HEADERS.every(
      (value, index) => String(header[index] ?? "").trim().toLowerCase() === value.toLowerCase()
    );

    if (isCanonical) {
      return rows.map((row) => row.map((value) => String(value ?? "")));
    }

    const canonicalRows = rows.length
      ? rows.slice(1).map((row) =>
          REPORTER_HEADERS.map((field) => {
            const index = this.reporterFieldIndex(header, field);
            return String(index >= 0 ? row[index] ?? "" : "");
          })
        )
      : [];

    // Map by the existing header names before writing the fixed A:J schema;
    // this preserves legacy client and note cells without relying on 8-column positions.
    await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `A1:J${Math.max(canonicalRows.length + 1, 1)}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [REPORTER_HEADERS, ...canonicalRows] }
    });

    return [REPORTER_HEADERS, ...canonicalRows];
  }

  private normalizeReporterType(value: string): ReporterRecord["reporterType"] {
    return normalizeReporterType(value);
  }

  private reporterKey(
    outlet: string,
    firstName: string,
    lastName: string
  ): string {
    return [outlet, firstName, lastName]
      .map((value) => normalizeName(value))
      .join("|");
  }

  private coverageKey(
    date: string,
    outlet: string,
    reporter: string,
    title: string,
    url: string
  ): string {
    const normalizedUrl = url.trim().toLowerCase();

    if (/^https?:\/\//i.test(normalizedUrl)) {
      return `url:${normalizedUrl}`;
    }

    return [date, outlet, reporter, title]
      .map((value) => value.trim().toLowerCase())
      .join("|");
  }

  private async findExistingFolder(
    name: string,
    parentId: string
  ): Promise<drive_v3.Schema$File | undefined> {
    const existing = await this.drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id,name,mimeType)"
    });

    return existing.data.files?.find(
      (file) =>
        normalizeName(file.name ?? "") ===
        normalizeName(name)
    );
  }

  private async findOrCreateFolder(
    name: string,
    parentId: string
  ): Promise<drive_v3.Schema$File> {
    const existing = await this.findExistingFolder(
      name,
      parentId
    );

    if (existing) {
      return existing;
    }

    const created = await this.drive.files.create({
      requestBody: {
        name,
        mimeType:
          "application/vnd.google-apps.folder",
        parents: [parentId]
      },
      fields: "id,name,mimeType"
    });

    return {
      id: created.data.id,
      name: created.data.name ?? name,
      mimeType:
        "application/vnd.google-apps.folder"
    };
  }

  private async findOrCreateSheet(
    name: string,
    parentId: string
  ): Promise<drive_v3.Schema$File> {
    const escapedName = name.replaceAll("'", "\\'");

    const existing = await this.drive.files.list({
      q: `'${parentId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: "files(id,name,mimeType)"
    });

    if (existing.data.files?.[0]) {
      return existing.data.files[0];
    }

    const created = await this.sheets.spreadsheets.create({
      requestBody: {
        properties: { title: name }
      },
      fields: "spreadsheetId,properties(title)"
    });

    const metadata = await this.drive.files.get({
      fileId: created.data.spreadsheetId!,
      fields: "parents"
    });

    await this.drive.files.update({
      fileId: created.data.spreadsheetId!,
      addParents: parentId,
      removeParents: metadata.data.parents?.join(","),
      fields: "id,parents"
    });

    return {
      id: created.data.spreadsheetId,
      name,
      mimeType:
        "application/vnd.google-apps.spreadsheet"
    };
  }
}

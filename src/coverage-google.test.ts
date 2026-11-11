import assert from "node:assert/strict";
import { syncClientWorkbook } from "./coverage-google.js";
import {
  TEMPLATE_HEADERS,
  workbookRows,
  mergeContactRows,
} from "./coverage-template.js";
import type { CoverageRecord } from "./domain.js";
const files = new Map<string, any>([
  [
    "root",
    {
      id: "root",
      name: "Media List Builder",
      mimeType: "application/vnd.google-apps.folder",
      parents: [],
      capabilities: { canAddChildren: true },
    },
  ],
  [
    "existing",
    {
      id: "existing",
      name: "Conquest - Clean Coverage",
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: ["root"],
      permissions: ["owner"],
      capabilities: { canEdit: true },
      webViewLink: "https://docs.google.com/spreadsheets/d/existing/edit",
    },
  ],
]);
type Tab = { properties: any; values: any[][]; font: string; widths: number[] };
const tab = (id: number, title: string): Tab => ({
  properties: {
    sheetId: id,
    title,
    index: 0,
    gridProperties: { rowCount: 1000, columnCount: 26 },
  },
  values: [],
  font: "Arial",
  widths: [],
});
const books = new Map<string, { tabs: Tab[]; defaultFormat: any; theme?: any }>(
  [["existing", { tabs: [tab(0, "Sheet1")], defaultFormat: {} }]],
);
let serial = 0,
  creates = 0,
  moves = 0,
  writes = 0,
  badFont = false,
  denyRoot = false;
let transientValueFailures = 0;
let failWriteAt = 0,
  valueRequests = 0;
function readRange(book: any, value: string) {
  const target = range(book, value);
  const end = value.match(/:[A-Z]+(\d+)$/)?.[1];
  return structuredClone(
    target.tab.values.slice(target.row, end ? Number(end) : undefined),
  );
}
const formats: any[] = [];
function range(book: any, value: string) {
  const match = value.match(/^'([^']+)'!([A-Z]+)(\d*)/)!;
  const column =
    [...match[2]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return {
    tab: book.tabs.find((t: Tab) => t.properties.title === match[1]) as Tab,
    row: match[3] ? Number(match[3]) - 1 : 0,
    column,
  };
}
const drive: any = {
  files: {
    get: async (r: any) => {
      if (denyRoot && r.fileId === "root")
        throw { code: 403, message: "Access denied" };
      if (!files.has(r.fileId)) throw { code: 404 };
      return { data: structuredClone(files.get(r.fileId)) };
    },
    list: async (r: any) => {
      const parent = r.q.match(/^'([^']+)' in parents/)?.[1],
        mime = r.q.match(/mimeType = '([^']+)'/)?.[1];
      return {
        data: {
          files: [...files.values()].filter((f) =>
            parent
              ? f.parents.includes(parent) && (!mime || f.mimeType === mime)
              : !!f.appProperties?.coverageRebuild,
          ),
        },
      };
    },
    create: async (r: any) => {
      creates++;
      const id = `created-${++serial}`,
        file = {
          id,
          ...r.requestBody,
          capabilities: { canEdit: true, canAddChildren: true },
        };
      files.set(id, file);
      if (file.mimeType.endsWith("spreadsheet"))
        books.set(id, { tabs: [tab(0, "Sheet1")], defaultFormat: {} });
      return { data: structuredClone(file) };
    },
    update: async (r: any) => {
      moves++;
      const file = files.get(r.fileId);
      if (r.requestBody?.name) file.name = r.requestBody.name;
      if (r.removeParents)
        file.parents = file.parents.filter(
          (p: string) => !r.removeParents.split(",").includes(p),
        );
      if (r.addParents && !file.parents.includes(r.addParents))
        file.parents.push(r.addParents);
      return { data: structuredClone(file) };
    },
  },
};
const sheets: any = {
  spreadsheets: {
    get: async (r: any) => {
      const book = books.get(r.spreadsheetId)!;
      return {
        data: {
          properties: {
            defaultFormat: book.defaultFormat,
            spreadsheetTheme: book.theme ?? {
              primaryFontFamily: "Arial",
              themeColors: [
                { colorType: "TEXT", color: { rgbColor: { red: 0 } } },
                {
                  colorType: "BACKGROUND",
                  color: { rgbColor: { red: 1, green: 1, blue: 1 } },
                },
              ],
            },
          },
          sheets: book.tabs.map((t) => ({
            properties: t.properties,
            ...(r.includeGridData
              ? {
                  data: [
                    {
                      startRow: 0,
                      startColumn: 0,
                      columnMetadata: t.widths.map((pixelSize) => ({
                        pixelSize,
                      })),
                      rowData: [
                        {
                          values: [
                            {
                              userEnteredFormat: {
                                textFormat: {
                                  fontFamily: badFont ? "Arial" : t.font,
                                  bold: true,
                                },
                              },
                            },
                          ],
                        },
                        {
                          values: [
                            {
                              userEnteredFormat: {
                                textFormat: { fontFamily: t.font },
                              },
                            },
                          ],
                        },
                      ],
                    },
                    {
                      startRow: 999,
                      startColumn: 25,
                      rowData: [
                        {
                          values: [
                            {
                              userEnteredFormat: {
                                textFormat: { fontFamily: t.font },
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                }
              : {}),
          })),
        },
      };
    },
    batchUpdate: async (r: any) => {
      const book = books.get(r.spreadsheetId)!;
      for (const request of r.requestBody.requests) {
        if (request.addSheet)
          book.tabs.push(
            tab(
              request.addSheet.properties.sheetId,
              request.addSheet.properties.title,
            ),
          );
        if (request.deleteSheet)
          book.tabs = book.tabs.filter(
            (t) => t.properties.sheetId !== request.deleteSheet.sheetId,
          );
        if (request.updateSheetProperties) {
          const p = request.updateSheetProperties.properties,
            t = book.tabs.find((t) => t.properties.sheetId === p.sheetId)!;
          t.properties = {
            ...t.properties,
            ...p,
            gridProperties: {
              ...t.properties.gridProperties,
              ...p.gridProperties,
            },
          };
        }
        if (request.updateSpreadsheetProperties) {
          assert.ok(
            request.updateSpreadsheetProperties.properties.spreadsheetTheme
              .themeColors?.length,
            "Font changes must preserve the full existing theme color set",
          );
          book.theme =
            request.updateSpreadsheetProperties.properties.spreadsheetTheme;
        }
        if (request.repeatCell) {
          formats.push(request.repeatCell);
          const t = book.tabs.find(
            (t) => t.properties.sheetId === request.repeatCell.range.sheetId,
          )!;
          if (request.repeatCell.cell.userEnteredFormat.textFormat?.fontFamily)
            t.font =
              request.repeatCell.cell.userEnteredFormat.textFormat.fontFamily;
        }
        if (request.updateDimensionProperties?.range.dimension === "COLUMNS") {
          const d = request.updateDimensionProperties;
          book.tabs.find(
            (t) => t.properties.sheetId === d.range.sheetId,
          )!.widths[d.range.startIndex] = d.properties.pixelSize;
        }
      }
      return { data: {} };
    },
    values: {
      get: async (r: any) => ({
        data: {
          values: structuredClone(
            range(books.get(r.spreadsheetId), r.range).tab.values,
          ),
        },
      }),
      batchGet: async (r: any) => ({
        data: {
          valueRanges: r.ranges.map((value: string) => ({
            range: value,
            values: readRange(books.get(r.spreadsheetId), value),
          })),
        },
      }),
      batchUpdate: async (r: any) => {
        valueRequests++;
        if (transientValueFailures-- > 0)
          throw Object.assign(new Error("temporary Google unavailable"), {
            code: 503,
          });
        if (failWriteAt === valueRequests)
          throw Object.assign(new Error("Fixture interrupted write"), {
            code: 400,
          });
        assert.ok(
          r.requestBody.data.length <= 2,
          "Google value writes are bounded",
        );
        for (const data of r.requestBody.data) {
          writes++;
          const target = range(books.get(r.spreadsheetId), data.range);
          assert.ok(
            target.row + data.values.length <=
              target.tab.properties.gridProperties.rowCount,
            "Grid expanded before values writes",
          );
          data.values.forEach((row: any[], i: number) => {
            target.tab.values[target.row + i] = [...row];
          });
        }
        return { data: {} };
      },
      batchClear: async (r: any) => {
        for (const value of r.requestBody.ranges) {
          const target = range(books.get(r.spreadsheetId), value);
          target.tab.values.splice(target.row);
        }
        return { data: {} };
      },
    },
  },
};
function record(url: string, reporter = "A Reporter"): CoverageRecord {
  return {
    id: url,
    clientId: "conquest",
    clientName: "Conquest",
    articleUrl: url,
    articleTitle: "Original title",
    publicationDate: "2026-11-01",
    reporterName: reporter,
    outlet: "Example",
    spokesperson: "CEO",
    originalPressType: "Media Commentary",
    coverageType: "Earned Coverage",
    sentiment: "Neutral",
    status: "Completed",
    reach: "72K+",
    outletType: "Trade Publication",
    rawFields: {},
    topics: [],
    source: "PRCC",
    createdAt: "",
    updatedAt: "",
    urlSource: "prcc",
    urlConfidence: "verified",
    urlResolvedAt: null,
  };
}
const records = [
  record("https://example.com/a"),
  record("https://example.com/b"),
];
const context: any = {
  reporters: [
    {
      firstName: "A",
      lastName: "Reporter",
      outlet: "Example",
      email: "verified@example.com",
      status: "Active",
    },
  ],
  outlets: [{ name: "Example", uvm: 100000, outletType: "Newsletter" }],
  clientContacts: [
    {
      name: "Manual Person",
      title: "Reliable different title",
      email: "new@example.com",
      phone: "555",
      clientName: "Conquest",
    },
    {
      name: "New Person",
      title: "CEO",
      email: "newperson@example.com",
      phone: "123",
      clientName: "Conquest",
    },
  ],
};
let saved = "";
const options = {
  drive,
  sheets,
  root: "root",
  client: "Conquest",
  records,
  destination: "existing",
  generation: "fixture",
  persist: async (id: string) => {
    saved = id;
  },
  context,
  requestIntervalMs: 0,
};
const first = await syncClientWorkbook(options);
assert.equal(saved, "existing");
assert.equal(files.get("existing").name, "Conquest");
assert.deepEqual(files.get("existing").permissions, ["owner"]);
assert.equal(first.clientsFolderId !== first.clientFolderId, true);
assert.equal(
  files.get(first.clientFolderId!).parents[0],
  first.clientsFolderId,
);
assert.equal(files.get(first.clientsFolderId!).parents[0], "root");
assert.equal(files.get("existing").parents[0], first.clientFolderId);
assert.equal(
  creates,
  2,
  "Only Clients and canonical client folders are created; existing spreadsheet is reused",
);
assert.equal(moves, 1);
const book = books.get("existing")!;
assert.deepEqual(
  book.tabs.map((t) => t.properties.title),
  Object.keys(TEMPLATE_HEADERS),
);
for (const t of book.tabs) {
  assert.deepEqual(
    t.values[0],
    TEMPLATE_HEADERS[t.properties.title as keyof typeof TEMPLATE_HEADERS],
  );
  assert.equal(t.font, "Calibri");
  assert.equal(t.properties.gridProperties.frozenRowCount, 1);
  assert.ok(t.widths.every((width) => width >= 100));
}
assert.equal(book.theme.primaryFontFamily, "Calibri");
assert.equal(first.tabsVerified?.length, 5);
assert.equal(
  book.tabs.find((t) => t.properties.title === "Reporters")!.values.length,
  2,
);
assert.deepEqual(
  book.tabs.find((t) => t.properties.title === "Reporters")!.values[1],
  ["A Reporter", "Example", "verified@example.com"],
);
assert.deepEqual(
  book.tabs.find((t) => t.properties.title === "Outlets")!.values[1],
  ["Example", "Newsletter", 100000],
);
const contacts = book.tabs.find(
  (t) => t.properties.title === "Client Contact",
)!;
contacts.values = [
  ["Name", "Title", "Email", "Phone"],
  ["Manual Person", "Human-entered title", "manual@example.com", "999"],
];
await syncClientWorkbook(options);
assert.deepEqual(contacts.values[1], [
  "Manual Person",
  "Human-entered title",
  "manual@example.com",
  "999",
]);
assert.equal(contacts.values.length, 3);
assert.equal(contacts.values[2][0], "New Person");
const counts = { creates, moves, writes };
await syncClientWorkbook(options);
assert.deepEqual(
  { creates, moves, writes },
  counts,
  "Repeating sync creates no extra folders/files/rows or value writes",
);
assert.ok(
  formats.some(
    (f) =>
      f.range.endRowIndex === undefined &&
      f.range.startRowIndex === undefined &&
      f.cell.userEnteredFormat.textFormat?.fontFamily === "Calibri",
  ),
  "Full grids, including empty template areas, receive Calibri",
);
const projection = workbookRows("Conquest", records, {
  reporters: [],
  outlets: [],
});
assert.equal(
  projection.Outlets[0][1],
  "",
  "Fallback classification must not be invented as verified outlet type",
);
assert.equal(projection.Reporters[0][2], "");
assert.deepEqual(
  mergeContactRows(
    [["Manual", "CEO", "keep@example.com", "111"]],
    [["Manual", "Changed", "other@example.com", "222"]],
  ),
  [["Manual", "CEO", "keep@example.com", "111"]],
);
badFont = true;
await assert.rejects(
  syncClientWorkbook(options),
  /Calibri verification failed/,
);
badFont = false;
const large = Array.from({ length: 1505 }, (_, i) =>
  record(`https://example.com/large/${i}`),
);
large.push({
  ...record(""),
  articleTitle: "",
  publicationDate: "",
  reporterName: "",
  outlet: "",
});
failWriteAt = valueRequests + 2;
await assert.rejects(
  syncClientWorkbook({ ...options, records: large }),
  /Fixture interrupted write/,
);
const committed = structuredClone(
  book.tabs
    .find((t) => t.properties.title === "Coverage")!
    .values.slice(0, 501),
);
failWriteAt = 0;
const resumed = await syncClientWorkbook({ ...options, records: large });
assert.equal(resumed.verifiedRecords, 1506);
assert.deepEqual(
  book.tabs
    .find((t) => t.properties.title === "Coverage")!
    .values.slice(0, 501),
  committed,
);
const afterResume = writes;
await syncClientWorkbook({ ...options, records: large });
assert.equal(
  writes,
  afterResume,
  "Completed batches are not written again on retry/restart",
);
const retriedRecords = large.map((r) => ({ ...r }));
retriedRecords[0].articleTitle = "Updated source headline";
const callsBeforeRetry = valueRequests;
transientValueFailures = 1;
await syncClientWorkbook({ ...options, records: retriedRecords });
assert.equal(
  valueRequests,
  callsBeforeRetry + 2,
  "Transient Google request retries back off and do not duplicate committed writes",
);
const incomplete = book.tabs
  .find((t) => t.properties.title === "Coverage")!
  .values.at(-1)!;
assert.equal(incomplete[0], "");
assert.equal(incomplete[1], "");
assert.equal(incomplete[10], "");
await assert.rejects(
  syncClientWorkbook({ ...options, destination: "missing-existing" }),
  (error) => (error as any).code === 404,
);
denyRoot = true;
await assert.rejects(
  syncClientWorkbook(options),
  /Configured Google Drive folder is invalid or inaccessible/,
);
assert.equal(creates, counts.creates);
console.log(
  "Client hierarchy reuse, in-place rename/move, five exact tabs, Calibri, deduplication, verified metadata, manual contacts and repeat sync tests passed.",
);

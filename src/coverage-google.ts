import type { drive_v3, sheets_v4 } from "googleapis";
import type { CoverageDestination, CoverageRecord } from "./domain.js";
import {
  TEMPLATE_HEADERS,
  TEMPLATE_WIDTHS,
  WORKBOOK_VERSION,
  workbookRows,
  mergeContactRows,
  identity,
  type TemplateContext,
  type TemplateTab,
} from "./coverage-template.js";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const folderMime = "application/vnd.google-apps.folder",
  sheetMime = "application/vnd.google-apps.spreadsheet";
const fail = (message: string) =>
  Object.assign(new Error(message), { code: 400 });
const comparable = (rows: unknown[][], width: number) =>
  JSON.stringify(
    rows.map((row) =>
      Array.from({ length: width }, (_, i) => String(row[i] ?? "")),
    ),
  );
export interface WorkbookOptions {
  drive: drive_v3.Drive;
  sheets: sheets_v4.Sheets;
  root: string;
  client: string;
  records: CoverageRecord[];
  destination?: string;
  generation: string;
  persist: (id: string) => Promise<void>;
  context?: TemplateContext;
  requestIntervalMs?: number;
}
export async function syncClientWorkbook(
  options: WorkbookOptions,
): Promise<CoverageDestination> {
  const {
    drive,
    sheets,
    root,
    client,
    records,
    persist,
    context = {},
  } = options;
  let next = 0;
  async function call<T>(action: () => Promise<T>) {
    const delay = Math.max(0, next - Date.now());
    if (delay) await new Promise((r) => setTimeout(r, delay));
    next = Date.now() + (options.requestIntervalMs ?? 1100);
    return action();
  }
  const getFile = async (id: string) =>
    (
      await call(() =>
        drive.files.get({
          fileId: id,
          fields:
            "id,name,mimeType,parents,trashed,webViewLink,capabilities(canEdit,canAddChildren),appProperties",
          supportsAllDrives: true,
        }),
      )
    ).data;
  let rootFile: drive_v3.Schema$File;
  try {
    rootFile = await getFile(root);
    if (
      rootFile.trashed ||
      rootFile.mimeType !== folderMime ||
      rootFile.capabilities?.canAddChildren !== true
    )
      throw fail("Folder is not writable");
  } catch (error: any) {
    throw Object.assign(
      new Error(
        `Configured Google Drive folder is invalid or inaccessible: ${error.message}`,
      ),
      { code: error.response?.status || error.code || 400 },
    );
  }
  async function findFolders(parent: string, name: string) {
    const result = await call(() =>
      drive.files.list({
        q: `${quote(parent)} in parents and trashed = false and mimeType = '${folderMime}'`,
        fields: "files(id,name)",
        pageSize: 1000,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      }),
    );
    const existing = (result.data.files ?? [])
      .filter((f) => identity(f.name ?? "") === identity(name))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    const file = existing
      ? await getFile(existing.id!)
      : (
          await call(() =>
            drive.files.create({
              requestBody: { name, mimeType: folderMime, parents: [parent] },
              fields:
                "id,name,parents,webViewLink,capabilities(canAddChildren)",
              supportsAllDrives: true,
            }),
          )
        ).data;
    if (!file.id) throw fail("Google Drive did not return a folder ID");
    if (file.name !== name)
      await call(() =>
        drive.files.update({
          fileId: file.id!,
          requestBody: { name },
          fields: "id,name",
          supportsAllDrives: true,
        }),
      );
    const verified = await getFile(file.id);
    if (
      verified.trashed ||
      verified.mimeType !== folderMime ||
      !verified.parents?.includes(parent) ||
      verified.capabilities?.canAddChildren !== true
    )
      throw fail(
        `Client folder ${name} is not accessible inside its expected parent`,
      );
    return verified;
  }
  const clientsFolder = await findFolders(root, "Clients");
  const clientFolder = await findFolders(clientsFolder.id!, client);
  let destination = options.destination;
  if (destination) {
    try {
      const file = await getFile(destination);
      if (file.trashed || file.mimeType !== sheetMime) destination = undefined;
      else if (
        /master.*(reporter|outlet)|(reporter|outlet).*master/i.test(
          file.name ?? "",
        )
      )
        throw fail(
          "Master reporter/outlet spreadsheets cannot be coverage destinations",
        );
      else if (file.capabilities?.canEdit === false)
        throw fail("Approved coverage spreadsheet is not writable");
    } catch (error: any) {
      if ([404, 410].includes(Number(error.response?.status || error.code)))
        destination = undefined;
      else throw error;
    }
  }
  if (!destination) {
    const marker = `coverage-v2:${options.generation}:${identity(client)}`;
    const escaped = marker.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const found = await call(() =>
      drive.files.list({
        q: `trashed = false and appProperties has { key='coverageRebuild' and value='${escaped}' }`,
        fields: "files(id)",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      }),
    );
    destination = found.data.files?.[0]?.id ?? undefined;
    if (!destination) {
      const foundByName = await call(() =>
        drive.files.list({
          q: `${quote(clientFolder.id!)} in parents and trashed = false and mimeType = '${sheetMime}'`,
          fields: "files(id,name)",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        }),
      );
      const matches = (foundByName.data.files ?? []).filter(
        (f) => f.name === client,
      );
      if (matches.length > 1)
        throw fail(
          "Multiple canonical client spreadsheets exist; refusing to choose or create another",
        );
      destination = matches[0]?.id ?? undefined;
    }
    if (!destination)
      destination =
        (
          await call(() =>
            drive.files.create({
              requestBody: {
                name: client,
                mimeType: sheetMime,
                parents: [clientFolder.id!],
                appProperties: { coverageRebuild: marker },
              },
              fields: "id",
              supportsAllDrives: true,
            }),
          )
        ).data.id ?? undefined;
  }
  if (!destination)
    throw fail("Google did not return a coverage spreadsheet ID");
  await persist(destination);
  let file = await getFile(destination);
  if (
    /master.*(reporter|outlet)|(reporter|outlet).*master/i.test(file.name ?? "")
  )
    throw fail(
      "Master reporter/outlet spreadsheets cannot be coverage destinations",
    );
  if (file.name !== client || !file.parents?.includes(clientFolder.id!)) {
    await call(() =>
      drive.files.update({
        fileId: destination!,
        requestBody: { name: client },
        ...(!file.parents?.includes(clientFolder.id!)
          ? {
              addParents: clientFolder.id!,
              removeParents:
                (file.parents ?? [])
                  .filter((id) => id !== clientFolder.id)
                  .join(",") || undefined,
            }
          : {}),
        fields: "id,name,parents",
        supportsAllDrives: true,
      }),
    );
    file = await getFile(destination);
  }
  if (file.name !== client || !file.parents?.includes(clientFolder.id!))
    throw fail(
      "Spreadsheet name or client folder placement could not be verified",
    );
  const metadata = await call(() =>
    sheets.spreadsheets.get({
      spreadsheetId: destination!,
      fields: "properties(spreadsheetTheme),sheets(properties)",
    }),
  );
  const tabs = metadata.data.sheets ?? [];
  const layout: sheets_v4.Schema$Request[] = [];
  let legacy = tabs.find((t) => t.properties?.title === "Sheet1");
  if (!tabs.some((t) => t.properties?.title === "Coverage") && legacy) {
    layout.push({
      updateSheetProperties: {
        properties: { sheetId: legacy.properties!.sheetId, title: "Coverage" },
        fields: "title",
      },
    });
    legacy.properties!.title = "Coverage";
  }
  for (const tab of tabs.filter(
    (t) => !Object.hasOwn(TEMPLATE_HEADERS, t.properties?.title ?? ""),
  )) {
    const values = await call(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: destination!,
        range: `${quote(tab.properties!.title!)}!A:ZZ`,
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
    );
    if (
      values.data.values?.some((row) => row.some((v) => v !== "" && v !== null))
    )
      throw fail(
        `Extra tab ${tab.properties!.title} contains client data; refusing to delete it`,
      );
    layout.push({ deleteSheet: { sheetId: tab.properties!.sheetId } });
  }
  let nextId = Math.max(0, ...tabs.map((t) => t.properties?.sheetId ?? 0)) + 1;
  for (const name of Object.keys(TEMPLATE_HEADERS) as TemplateTab[])
    if (!tabs.some((t) => t.properties?.title === name))
      layout.push({
        addSheet: {
          properties: {
            sheetId: nextId++,
            title: name,
            gridProperties: {
              rowCount: Math.max(1000, records.length + 1),
              columnCount: 26,
            },
          },
        },
      });
  if (layout.length)
    await call(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: destination!,
        requestBody: { requests: layout },
      }),
    );
  const refreshed =
    (
      await call(() =>
        sheets.spreadsheets.get({
          spreadsheetId: destination!,
          fields: "sheets(properties)",
        }),
      )
    ).data.sheets ?? [];
  const names = Object.keys(TEMPLATE_HEADERS) as TemplateTab[];
  if (
    refreshed.length !== 5 ||
    names.some((name) => !refreshed.some((t) => t.properties?.title === name))
  )
    throw fail(
      "The client workbook does not contain exactly the five standard tabs",
    );
  const before =
    (
      await call(() =>
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: destination!,
          ranges: names.map((name) => `${quote(name)}!A:Z`),
          valueRenderOption: "UNFORMATTED_VALUE",
        }),
      )
    ).data.valueRanges ?? [];
  const bodies = workbookRows(client, records, context);
  // Use real dates on Google; local ISO date values remain unchanged.
  bodies.Coverage = bodies.Coverage.map((row) => [
    /^\d{4}-\d{2}-\d{2}$/.test(String(row[0]))
      ? Date.parse(String(row[0])) / 86400000 + 25569
      : row[0],
    ...row.slice(1),
  ]);
  const writes: sheets_v4.Schema$ValueRange[] = [],
    clears: string[] = [],
    expected: Record<string, unknown[][]> = {};
  for (const [i, name] of names.entries()) {
    const headers = [...TEMPLATE_HEADERS[name]],
      width = headers.length,
      last = String.fromCharCode(64 + width);
    const current = before[i]?.values ?? [],
      header = current[0] ?? [];
    if (
      header.some(Boolean) &&
      header.some((value, index) => value !== headers[index])
    )
      throw fail(
        `The ${name} header does not match the standard schema; manual data was not overwritten`,
      );
    if (comparable([header], width) !== comparable([headers], width))
      writes.push({ range: `${quote(name)}!A1:${last}1`, values: [headers] });
    const contact = name === "Client Contact" || name === "Team Contact";
    const body = contact
      ? mergeContactRows(current.slice(1), bodies[name])
      : bodies[name];
    expected[name] = [headers, ...body];
    if (name === "Coverage" && current.length > body.length + 1)
      throw fail(
        "Coverage contains additional client data not present locally; refusing to discard it",
      );
    if (!contact && current.length > body.length + 1)
      clears.push(
        `${quote(name)}!A${body.length + 2}:${last}${current.length}`,
      );
    const start = contact ? current.slice(1).length : 0;
    for (let offset = start; offset < body.length; offset += 500) {
      const values = body.slice(offset, offset + 500);
      if (
        comparable(
          current.slice(offset + 1, offset + 1 + values.length),
          width,
        ) !== comparable(values, width)
      )
        writes.push({
          range: `${quote(name)}!A${offset + 2}:${last}${offset + values.length + 1}`,
          values,
        });
    }
  }
  if (clears.length)
    await call(() =>
      sheets.spreadsheets.values.batchClear({
        spreadsheetId: destination!,
        requestBody: { ranges: clears },
      }),
    );
  if (writes.length)
    await call(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: destination!,
        requestBody: { valueInputOption: "RAW", data: writes },
      }),
    );
  const formatting: sheets_v4.Schema$Request[] = [
    {
      updateSpreadsheetProperties: {
        properties: {
          spreadsheetTheme: {
            ...metadata.data.properties?.spreadsheetTheme,
            primaryFontFamily: "Calibri",
          },
        },
        fields: "spreadsheetTheme",
      },
    },
  ];
  for (const [index, name] of names.entries()) {
    const sheet = refreshed.find(
        (t) => t.properties?.title === name,
      )!.properties!,
      sheetId = sheet.sheetId!;
    formatting.push(
      {
        updateSheetProperties: {
          properties: {
            sheetId,
            index,
            gridProperties: {
              rowCount: Math.max(
                sheet.gridProperties?.rowCount ?? 1000,
                expected[name].length + 100,
              ),
              columnCount: Math.max(
                sheet.gridProperties?.columnCount ?? 26,
                26,
              ),
              frozenRowCount: 1,
            },
          },
          fields:
            "index,gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
        },
      },
      {
        repeatCell: {
          range: { sheetId },
          cell: {
            userEnteredFormat: {
              textFormat: { fontFamily: "Calibri", fontSize: 11 },
              verticalAlignment: "BOTTOM",
            },
          },
          fields:
            "userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              textFormat: { fontFamily: "Calibri", bold: true },
              wrapStrategy: "WRAP",
            },
          },
          fields:
            "userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.bold,userEnteredFormat.wrapStrategy",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 32 },
          fields: "pixelSize",
        },
      },
    );
    for (const [col, pixelSize] of TEMPLATE_WIDTHS[name].entries())
      formatting.push({
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: "COLUMNS",
            startIndex: col,
            endIndex: col + 1,
          },
          properties: { pixelSize },
          fields: "pixelSize",
        },
      });
    if (name === "Coverage") {
      formatting.push(
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 1,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" },
              },
            },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              startColumnIndex: 10,
              endColumnIndex: 11,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 1, green: 242 / 255, blue: 153 / 255 },
                textFormat: {
                  fontFamily: "Calibri",
                  foregroundColor: {
                    red: 17 / 255,
                    green: 85 / 255,
                    blue: 204 / 255,
                  },
                  underline: true,
                },
              },
            },
            fields:
              "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.underline",
          },
        },
      );
      if (records.length)
        formatting.push({
          updateCells: {
            range: {
              sheetId,
              startRowIndex: 1,
              startColumnIndex: 10,
              endColumnIndex: 11,
              endRowIndex: records.length + 1,
            },
            rows: [...records]
              .sort((a, b) =>
                b.publicationDate.localeCompare(a.publicationDate),
              )
              .map((r) => ({
                values: [
                  {
                    userEnteredFormat: {
                      textFormat: { link: { uri: r.articleUrl } },
                    },
                  },
                ],
              })),
            fields: "userEnteredFormat.textFormat.link",
          },
        });
    }
  }
  await call(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: destination!,
      requestBody: { requests: formatting },
    }),
  );
  const after =
    (
      await call(() =>
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: destination!,
          ranges: names.map((name) => `${quote(name)}!A:Z`),
          valueRenderOption: "UNFORMATTED_VALUE",
        }),
      )
    ).data.valueRanges ?? [];
  for (const [i, name] of names.entries())
    if (
      comparable(after[i]?.values ?? [], TEMPLATE_HEADERS[name].length) !==
      comparable(expected[name], TEMPLATE_HEADERS[name].length)
    )
      throw fail(`${name} write/read-back verification failed`);
  const formatRanges = names.flatMap((name) => [
    `${quote(name)}!A1:${String.fromCharCode(64 + TEMPLATE_HEADERS[name].length)}${Math.max(2, expected[name].length)}`,
    `${quote(name)}!Z1000`,
  ]);
  const verified = (
    await call(() =>
      sheets.spreadsheets.get({
        spreadsheetId: destination!,
        ranges: formatRanges,
        includeGridData: true,
        fields:
          "properties(spreadsheetTheme),sheets(properties(sheetId,title,index,gridProperties),data(startRow,startColumn,columnMetadata(pixelSize),rowData(values(userEnteredFormat,effectiveFormat))))",
      }),
    )
  ).data;
  if (verified.properties?.spreadsheetTheme?.primaryFontFamily !== "Calibri")
    throw fail("Calibri theme formatting was not verified");
  for (const [index, name] of names.entries()) {
    const tab = verified.sheets?.find((s) => s.properties?.title === name);
    if (
      tab?.properties?.index !== index ||
      tab?.properties?.gridProperties?.frozenRowCount !== 1
    )
      throw fail(`${name} tab order or frozen header verification failed`);
    const cells =
      tab.data?.flatMap(
        (d) => d.rowData?.flatMap((row) => row.values ?? []) ?? [],
      ) ?? [];
    if (
      !cells.length ||
      cells.some(
        (c) =>
          (c.userEnteredFormat?.textFormat?.fontFamily ??
            c.effectiveFormat?.textFormat?.fontFamily) !== "Calibri",
      )
    )
      throw fail(`${name} populated/empty cell Calibri verification failed`);
    const headerData = tab.data?.find(
      (d) => (d.startRow ?? 0) === 0 && (d.startColumn ?? 0) === 0,
    );
    if (
      !headerData?.rowData?.[0]?.values?.every(
        (c) => c.userEnteredFormat?.textFormat?.bold === true,
      )
    )
      throw fail(`${name} bold header verification failed`);
    if (
      TEMPLATE_WIDTHS[name].some(
        (width, i) => headerData?.columnMetadata?.[i]?.pixelSize !== width,
      )
    )
      throw fail(`${name} column width verification failed`);
  }
  const placement = await getFile(destination);
  if (
    placement.name !== client ||
    !placement.parents?.includes(clientFolder.id!)
  )
    throw fail("Final Drive placement verification failed");
  return {
    spreadsheetId: destination,
    spreadsheetName: placement.name!,
    spreadsheetUrl:
      placement.webViewLink ??
      `https://docs.google.com/spreadsheets/d/${destination}/edit`,
    parents: [
      {
        id: clientFolder.id!,
        name: clientFolder.name!,
        url:
          clientFolder.webViewLink ??
          `https://drive.google.com/drive/folders/${clientFolder.id}`,
      },
    ],
    clientsFolderId: clientsFolder.id!,
    clientFolderId: clientFolder.id!,
    verifiedRecords: records.length,
    verifiedAt: new Date().toISOString(),
    writtenBatches: writes.length,
    managed: true,
    templateVersion: WORKBOOK_VERSION,
    tabsVerified: names,
  };
}

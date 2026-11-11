import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { Parser } from "saxen";

export interface OriginalCell {
  address: string;
  type: string;
  storedValue: string;
  formula: string;
  text: string;
}
function xml(
  content: string,
  open: (name: string, attributes: Record<string, string>) => void,
  text: (value: string) => void = () => {},
  close: (name: string) => void = () => {},
) {
  const parser = new Parser();
  parser.on("openTag", (name, attributes, decode) =>
    open(
      name.split(":").at(-1),
      Object.fromEntries(
        Object.entries(attributes()).map(([k, v]) => [k, decode(v)]),
      ),
    ),
  );
  parser.on("text", (value, decode) => text(decode(value)));
  parser.on("closeTag", (name) => close(name.split(":").at(-1)));
  parser.on("error", (error) => {
    throw error;
  });
  parser.parse(content);
}
/** Preserve XLSX stored values/formulas as well as decoded text. Original archive bytes remain authoritative. */
export function originalXlsxTables(buffer: Buffer) {
  const archive = unzipSync(buffer);
  const read = (name: string) =>
    archive[name] ? strFromU8(archive[name]) : "";
  const shared: string[] = [];
  let item = "",
    inText = false;
  xml(
    read("xl/sharedStrings.xml"),
    (name) => {
      if (name === "si") item = "";
      if (name === "t") inText = true;
    },
    (value) => {
      if (inText) item += value;
    },
    (name) => {
      if (name === "si") shared.push(item);
      if (name === "t") inText = false;
    },
  );
  const relationships = new Map<string, string>();
  xml(read("xl/_rels/workbook.xml.rels"), (name, a) => {
    if (name === "Relationship") relationships.set(a.Id, a.Target);
  });
  const sheets: { tab: string; target: string }[] = [];
  xml(read("xl/workbook.xml"), (name, a) => {
    if (name === "sheet") {
      const target = relationships.get(
        a["r:id"] ||
          Object.entries(a).find(([k]) => k.endsWith(":id"))?.[1] ||
          "",
      );
      if (target)
        sheets.push({
          tab: a.name,
          target: target.startsWith("/")
            ? target.slice(1)
            : path.posix.normalize("xl/" + target),
        });
    }
  });
  return sheets.map(({ tab, target }) => {
    const rows: unknown[][] = [],
      cells: OriginalCell[][] = [];
    let cell: OriginalCell | undefined,
      field = "",
      sourceRow = 0,
      sourceColumn = -1;
    xml(
      read(target),
      (name, a) => {
        if (name === "row") {
          sourceRow = a.r ? Number(a.r) : sourceRow + 1;
          sourceColumn = -1;
        }
        if (name === "c")
          cell = {
            address: a.r || "",
            type: a.t || "n",
            storedValue: "",
            formula: "",
            text: "",
          };
        if (["v", "f", "t"].includes(name)) field = name;
      },
      (value) => {
        if (!cell) return;
        if (field === "v") cell.storedValue += value;
        if (field === "f") cell.formula += value;
        if (field === "t") cell.text += value;
      },
      (name) => {
        if (["v", "f", "t"].includes(name)) field = "";
        if (name !== "c" || !cell) return;
        const address = cell.address.match(/^([A-Z]+)(\d+)$/);
        if (cell.address && !address)
          throw Error("Source XLSX cell has an invalid address");
        const row = address ? Number(address[2]) - 1 : sourceRow - 1,
          column = address
            ? [...address[1]].reduce(
                (n, c) => n * 26 + c.charCodeAt(0) - 64,
                0,
              ) - 1
            : sourceColumn + 1;
        sourceColumn = column;
        if (cell.type === "s")
          cell.text = shared[Number(cell.storedValue)] ?? cell.storedValue;
        const value =
          cell.type === "s" || cell.type === "inlineStr"
            ? cell.text
            : cell.storedValue ||
              (cell.formula ? "=" + cell.formula : cell.text);
        rows[row] ??= [];
        rows[row][column] = value;
        (cells[row] ??= []).push(cell);
        cell = undefined;
      },
    );
    return {
      tab,
      rows: Array.from({ length: rows.length }, (_, i) =>
        Array.from(
          { length: rows[i]?.length ?? 0 },
          (_, j) => rows[i][j] ?? null,
        ),
      ),
      cells,
    };
  });
}

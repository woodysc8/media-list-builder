// Isolated test server: no live Google operations, credentials or application data.
import path from "node:path";
import { GoogleWorkspace } from "./google.js";
import { acquireCoverageLock } from "./coverage-lock.js";
GoogleWorkspace.prototype.inspectRoot=async()=>({name:'Fixture root',clientsFolder:undefined,reporterSheet:undefined,outletSheet:undefined});
GoogleWorkspace.prototype.syncCleanCoverage = async function (
  client,
  records,
  destination,
  persist,
) {
  const id = destination || `fixture-${client.toLowerCase()}`;
  await persist(id);
  return {
    spreadsheetId: id,
    spreadsheetName: `${client} coverage`,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
    parents: [
      {
        id: "fixture",
        name: "Fixture folder",
        url: "https://drive.google.com/drive/folders/fixture",
      },
    ],
    verifiedRecords: records.length,
    verifiedAt: new Date().toISOString(),
    writtenBatches: 1,
  };
};
if (!process.env.DATA_FILE?.includes("coverage-server-"))
  throw new Error("Fixture server requires disposable coverage-server data");
await acquireCoverageLock(path.dirname(process.env.DATA_FILE));
const { default: app } = await import("./server.js");
const server = app.listen(0, () => {
  const address = server.address();
  if (address && typeof address === "object")
    console.log(
      `Media List Builder running at http://localhost:${address.port}`,
    );
});

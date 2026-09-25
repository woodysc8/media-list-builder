import { access, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataFile = path.resolve(process.env.DATA_FILE ?? path.join(projectRoot, "data", "store.json"));
const backupFile = path.join(path.dirname(dataFile), "store.backup.json");
const cleanStore = { clients: [], reporters: [], coverage: [] };

try {
  await access(dataFile);
} catch {
  throw new Error(`Local store was not found: ${dataFile}`);
}

try {
  await access(backupFile);
  throw new Error(`Backup already exists; refusing to overwrite: ${backupFile}`);
} catch (error) {
  if (error instanceof Error && !error.message.startsWith("Backup already exists")) {
    await copyFile(dataFile, backupFile);
  } else if (error instanceof Error) {
    throw error;
  }
}

await writeFile(dataFile, `${JSON.stringify(cleanStore, null, 2)}\n`, "utf8");
console.log(`Backed up ${dataFile} to ${backupFile}`);
console.log(`Rebuilt clean local store at ${dataFile}`);
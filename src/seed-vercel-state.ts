import { config as loadEnv } from "dotenv";
loadEnv();
loadEnv({ path: ".env.local", override: false });
import { BlobNotFoundError, get, put } from "@vercel/blob";
import { readFile } from "node:fs/promises";

const seedFiles = [
  "store.json",
  "enrichment-audit.json",
  "enrichment-cache.json",
  "enrichment-proposals.json",
  "enrichment-queue.json",
  "enrichment-rate-limit.json"
];

for (const fileName of seedFiles) {
  const pathname = `media-list-builder/data/${fileName}`;
  let existing;
  try {
    existing = await get(pathname, { access: "private", useCache: false });
  } catch (error) {
    if (!(error instanceof BlobNotFoundError)) throw error;
  }
  if (existing?.statusCode === 200) {
    console.log(`Skipped existing private state: ${fileName}`);
    continue;
  }
  const content = await readFile(`data/${fileName}`, "utf8");
  await put(pathname, content, { access: "private", addRandomSuffix: false });
  console.log(`Seeded private persistent state: ${fileName}`);
}

console.log("Persistent state seed complete. Existing Blob files were never overwritten.");

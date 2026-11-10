import dotenv from "dotenv";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
dotenv.config();
// Metadata only: never log credentials, record contents or source filenames.
const directories = new Set([
  path.dirname(path.resolve(process.env.DATA_FILE ?? "data/store.json")),
  ...(await readdir(process.cwd()))
    .filter((name) => /^data[-_]|^coverage-backup-/.test(name))
    .map((name) => path.resolve(name)),
]);
for (const directory of directories) {
  for (const name of await readdir(directory).catch((e: any) => {
    if (e.code === "ENOENT") return [];
    throw e;
  })) {
    if (!name.endsWith(".json")) {
      console.log(
        JSON.stringify({
          location: path.relative(process.cwd(), path.join(directory, name)),
          kind: "directory or source file; never auto-imported",
        }),
      );
      continue;
    }
    const value = JSON.parse(
      await readFile(path.join(directory, name), "utf8"),
    );
    console.log(
      JSON.stringify({
        location: path.relative(process.cwd(), path.join(directory, name)),
        coverage: Array.isArray(value.coverage) ? value.coverage.length : 0,
        jobs: Array.isArray(value.jobs) ? value.jobs.length : 0,
        reporters: Array.isArray(value.reporters) ? value.reporters.length : 0,
        clients: Array.isArray(value.clients) ? value.clients.length : 0,
      }),
    );
  }
}
console.log(
  JSON.stringify({
    dataFileOverride: !!process.env.DATA_FILE,
    appConfigOverride: !!process.env.APP_CONFIG_FILE,
    googleAuthOverride: !!process.env.GOOGLE_AUTH_FILE,
    googleOAuthConfigured: !!(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ),
    blobConfigured: !!(
      process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.BLOB_STORE_ID ||
      process.env.VERCEL_OIDC_TOKEN
    ),
    vercelRuntime: process.env.VERCEL === "1",
    remoteStateInspected: false,
    remoteStateModified: false,
  }),
);

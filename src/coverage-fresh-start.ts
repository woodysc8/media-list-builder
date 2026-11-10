import dotenv from "dotenv";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, emptyCoverage } from "./coverage-workflow.js";
import { assertCoverageStopped } from "./coverage-lock.js";

/** Local-only reset. Caller must stop the server first; no Google or Blob clients are used. */
export async function freshStart(
  storeFile: string,
  confirmed: boolean,
  extras: string[] = [],
) {
  if (!confirmed)
    throw new Error(
      "No changes made. Stop the server and pass --confirm to back up and reset local coverage.",
    );
  if (process.env.VERCEL === "1")
    throw new Error("Remote reset is forbidden. Run against local data only.");
  const storePath = path.resolve(storeFile),
    directory = path.dirname(storePath);
  if (directory === path.parse(directory).root || directory === process.cwd())
    throw new Error("Data must be in a dedicated directory");
  await assertCoverageStopped(directory);
  // Reject junctions/symlinks before any recursive copy/delete can leave the data directory.
  async function checkTree(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(
      (e: any) => {
        if (e.code === "ENOENT") return [];
        throw e;
      },
    )) {
      const target = path.join(folder, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink())
        throw new Error(`Refusing reset of linked data: ${target}`);
      if (info.isDirectory()) await checkTree(target);
    }
  }
  try {
    if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase())
      throw new Error("Data directory must not be a symlink or junction");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  await checkTree(directory);
  const backup = path.join(
    path.dirname(directory),
    `coverage-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(backup, { recursive: false });
  try {
    await cp(directory, path.join(backup, "data"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const [index, file] of extras.entries()) {
    try {
      await cp(
        file,
        path.join(backup, `external-${index}-${path.basename(file)}`),
      );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  // Remove coverage-owned keys only. OAuth, reporter enrichment and settings survive.
  const scrub = (obj: any): any => {
    if (Array.isArray(obj)) return obj.map(scrub);
    if (!obj || typeof obj !== "object") return obj;
    return Object.fromEntries(
      Object.entries(obj)
        .filter(
          ([k]) =>
            !/coverage|uploadJobs|importHistory|urlResearch|titleResearch/i.test(
              k,
            ),
        )
        .map(([k, v]) => [
          k,
          /^(reporters|archivedReporters|clients|clientContacts|teamContacts)$/.test(
            k,
          )
            ? v
            : scrub(v),
        ]),
    );
  };
  const files = await readdir(directory).catch(() => []);
  for (const name of files) {
    const target = path.resolve(directory, name);
    if (path.dirname(target) !== directory) throw new Error("Unsafe data path");
    if (
      /^(coverage|upload[-_]?queue|uploads|queued[-_]?files|url[-_](research|cache)|title[-_](research|cache)|import[-_]history)/i.test(
        name,
      )
    ) {
      const resolved = await lstat(target);
      await rm(target, { recursive: resolved.isDirectory(), force: true });
    } else if (
      /\.json$/i.test(name) &&
      !(
        process.env.GOOGLE_AUTH_FILE &&
        target === path.resolve(process.env.GOOGLE_AUTH_FILE)
      ) &&
      !/google-auth|oauth|credentials/i.test(name)
    ) {
      const existing = JSON.parse(await readFile(target, "utf8"));
      const clean = scrub(existing);
      if (target === storePath) clean.coverage = [];
      await atomicJson(target, clean);
    }
  }
  for (const file of extras) {
    if (
      path.resolve(file) === storePath ||
      (process.env.GOOGLE_AUTH_FILE &&
        path.resolve(file) === path.resolve(process.env.GOOGLE_AUTH_FILE)) ||
      /google-auth|oauth|credentials/i.test(path.basename(file))
    )
      continue;
    try {
      await atomicJson(file, scrub(JSON.parse(await readFile(file, "utf8"))));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await atomicJson(path.join(directory, "coverage-v2.json"), emptyCoverage());
  return {
    backup,
    coverageRecords: 0,
    uploadJobs: 0,
    pendingCoverageSynchronizationJobs: 0,
    coverageResearchCacheEntries: 0,
    legacyCoverageMigrationsActive: false,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  dotenv.config();
  console.log(
    await freshStart(
      process.env.DATA_FILE ?? "data/store.json",
      process.argv.includes("--confirm"),
      [process.env.APP_CONFIG_FILE, process.env.GOOGLE_AUTH_FILE].filter(
        (x): x is string => !!x,
      ),
    ),
  );
}

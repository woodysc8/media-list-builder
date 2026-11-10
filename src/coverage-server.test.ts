import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { atomicJson } from "./coverage-workflow.js";
import { freshStart } from "./coverage-fresh-start.js";
const root = await mkdtemp(path.join(os.tmpdir(), "coverage-server-")),
  data = path.join(root, "data");
await mkdir(data);
const file = path.join(data, "store.json");
const reporter = {
  id: "REP-000001",
  firstName: "Test",
  lastName: "Writer",
  outlet: "Example",
  email: "",
  clientsCovered: "Acme",
  beats: "Fintech",
  reporterType: "reporter",
  notes: "preserve",
  mostRecentArticle: "2026-11-01",
  status: "Active",
};
await atomicJson(file, {
  coverage: [{ articleUrl: "https://old.example/history" }],
  reporters: [reporter],
  clients: [{ id: "a", name: "Acme", aliases: [] }],
});
await freshStart(file, true);
let child: ChildProcess | undefined;
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise<void>((resolve) =>
    child!.once("exit", () => resolve()),
  );
  child.kill();
  await done;
}
async function start() {
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "0",
      VERCEL: "0",
      REPORTER_PREFLIGHT_READ_ONLY: "0",
      APP_ACCESS_PASSWORD: "",
      DATA_FILE: file,
      APP_CONFIG_FILE: path.join(data, "app-config.json"),
      GOOGLE_AUTH_FILE: path.join(data, "google-auth.json"),
      GOOGLE_CLIENT_ID: "fixture",
      GOOGLE_CLIENT_SECRET: "fixture",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return await new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(
      () => reject(Error("Server startup timed out: " + log)),
      30000,
    );
    child!.stdout!.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/running at http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child!.stderr!.on("data", (chunk) => {
      log += chunk;
    });
    child!.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Server exited ${code}: ${log}`));
    });
  });
}
async function read(base: string, endpoint: string) {
  const response = await fetch(base + endpoint);
  assert.equal(response.status, 200, endpoint);
  return response.json() as Promise<any>;
}
try {
  let base = await start();
  await assert.rejects(freshStart(file, true), /running/);
  let state = await read(base, "/api/clean-coverage");
  assert.equal(state.verification.coverageRecords, 0);
  assert.equal(state.verification.uploadJobs, 0);
  assert.equal(state.summary.status, "Idle");
  const reference = await read(base, "/api/reference-data");
  assert.equal(reference.reporterSource.kind, "local");
  assert.equal(reference.reporters.length, 1);
  assert.ok(reference.clients.includes("Acme"));
  assert.equal(
    (await read(base, "/api/media-list/google/status")).connected,
    false,
  );
  assert.equal((await fetch(base + "/coverage.html")).status, 200);
  const approved = {
    Acme: { spreadsheetId: "fixture-approved", tab: "Coverage" },
  };
  await atomicJson(path.join(data, "app-config.json"), {
    rootFolderId: "fixture",
    coverageDestinations: approved,
  });
  const configured = await fetch(base + "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rootFolderId: "fixture" }),
  });
  assert.equal(configured.status, 200);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(data, "app-config.json"), "utf8"))
      .coverageDestinations,
    approved,
    "OAuth configuration saves preserve approved coverage destinations",
  );
  assert.equal(
    (await fetch(base + "/api/ingest", { method: "POST" })).status,
    410,
  );
  await stop();
  // Legacy JSON and restored Google credentials must not refill coverage.
  await atomicJson(path.join(data, "store.backup.json"), {
    coverage: [{ articleUrl: "https://old.example/backup" }],
  });
  await atomicJson(path.join(data, "app-config.json"), {
    rootFolderId: "fixture",
  });
  await atomicJson(path.join(data, "google-auth.json"), {
    refresh_token: "fixture",
  });
  base = await start();
  state = await read(base, "/api/clean-coverage");
  assert.equal(state.verification.coverageRecords, 0);
  assert.equal(state.verification.uploadJobs, 0);
  assert.equal(state.verification.pendingCoverageSynchronizationJobs, 0);
  assert.equal(state.verification.coverageResearchCacheEntries, 0);
  assert.equal(
    (await read(base, "/api/media-list/google/status")).connected,
    true,
  );
  const form = new FormData();
  const csv =
    "Date,Publication,UVM,Reporter,Status,Raw URL\n2026-01-01,Example,100,Test Writer,Headline,https://example.com/new";
  form.append("files", new Blob([csv]), "Conquest PRCC 2026.csv");
  form.append("files", new Blob([csv]), "Conquest PRCC duplicate.csv");
  const response = await fetch(base + "/api/clean-coverage/upload", {
    method: "POST",
    body: form,
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as any).jobs.length, 2);
  // No start/control call: upload must persist automatic processing across restart.
  await stop();
  base = await start();
  for (let i = 0; i < 20; i++) {
    state = await read(base, "/api/clean-coverage");
    if (state.jobs.every((j: any) => j.state === "completed")) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(
    state.jobs.filter((j: any) => j.state === "completed").length,
    2,
  );
  assert.equal(state.records.length, 1);
  assert.equal(state.jobs[1].duplicates, 1);
  assert.equal(state.summary.status, "Completed");
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).reporters[0].notes,
    "preserve",
  );
  console.log(
    "HTTP multi-file upload, real server restarts, zero counts after Google reconnection, reporter preservation and overnight recovery passed.",
  );
} finally {
  await stop();
}

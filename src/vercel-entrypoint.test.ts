import assert from "node:assert/strict";
import fs from "node:fs";

process.env.REPORTER_PREFLIGHT_READ_ONLY = "1";
process.env.APP_ACCESS_PASSWORD = "test-only-access-password";
const { default: app } = await import("./server.ts");
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
try {
  const denied = await fetch(`${baseUrl}/api/status`);
  assert.equal(denied.status, 401, "Anonymous API calls are gated when an application password is configured");
  assert.equal(denied.headers.get("x-app-auth-required"), "1");
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: process.env.APP_ACCESS_PASSWORD })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const sessionCookie = setCookie.split(";")[0] ?? "";
  const authorizedFetch = (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", sessionCookie);
    return fetch(url, { ...init, headers });
  };

  const root = await authorizedFetch(baseUrl);
  assert.equal(root.status, 200, "The existing frontend is served from the exported Express app");
  assert.match(await root.text(), /Build Media List/);

  const status = await authorizedFetch(`${baseUrl}/api/status`);
  assert.equal(status.status, 200);

  const reference = await authorizedFetch(`${baseUrl}/api/reference-data`);
  assert.equal(reference.status, 200);
  const referenceData = await reference.json() as { canonicalBeats?: string[]; reporterSource?: { kind?: string } };
  assert.equal(referenceData.canonicalBeats?.length, 16);
  assert.equal(referenceData.reporterSource?.kind, "local");

  const coverage = await authorizedFetch(`${baseUrl}/api/coverage-data`);
  assert.equal(coverage.status, 200);

  const google = await authorizedFetch(`${baseUrl}/api/media-list/google/status`);
  assert.equal(google.status, 200);
  assert.equal((await google.json() as { connected: boolean }).connected, false);

  assert.equal(JSON.parse(fs.readFileSync("vercel.json", "utf8")).functions["src/server.ts"].includeFiles.includes("data/**"), true);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log("Exported Express/Vercel entrypoint smoke tests passed");

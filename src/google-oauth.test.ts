import assert from "node:assert/strict";
import { GoogleWorkspace, configuredGoogleRedirectUri } from "./google.js";

process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_REDIRECT_URI = "https://media.example.test/oauth2callback";
delete process.env.VERCEL;
const workspace = new GoogleWorkspace("folder-id", { refresh_token: "test-refresh-token" });
assert.equal(workspace.redirectUri, "https://media.example.test/oauth2callback");
assert.equal(workspace.connected, true, "Persisted Google credentials restore connected services");
assert.equal(workspace.credentials.refresh_token, "test-refresh-token", "Credentials remain available server-side for persistence");

delete process.env.GOOGLE_REDIRECT_URI;
process.env.VERCEL = "1";
process.env.VERCEL_URL = "media-list-builder-preview.vercel.app";
assert.equal(configuredGoogleRedirectUri(), "https://media-list-builder-preview.vercel.app/oauth2callback");
delete process.env.VERCEL_URL;
delete process.env.VERCEL;
console.log("Google OAuth deployment configuration tests passed");

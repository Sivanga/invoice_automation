/**
 * gmail-auth.js
 * 
 * Handles Gmail API OAuth2 authentication.
 * Run directly to generate a token: node gmail-auth.js
 * 
 * LEARNING NOTE:
 * This is a standard OAuth2 "installed app" flow:
 * 1. We build an auth URL and open it in the browser
 * 2. User approves, Google redirects to localhost:8080 with a code
 * 3. We exchange the code for access + refresh tokens
 * 4. We store tokens in token.json — future runs use the refresh token silently
 */

import { google } from "googleapis";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────────

const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

// Scopes we need:
// - gmail.modify: read emails + add/remove labels (needed for Detector + Marker)
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

// ── Build OAuth2 client ──────────────────────────────────────────────────────

export function getOAuthClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found at ${CREDENTIALS_PATH}\n` +
      `Copy your OAuth client secret JSON there and rename it credentials.json`
    );
  }

  const { web } = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  return new google.auth.OAuth2(
    web.client_id,
    web.client_secret,
    web.redirect_uris[0] // http://localhost:8080/
  );
}

// ── Load tokens if they exist ────────────────────────────────────────────────

export function loadTokens(auth) {
  if (!fs.existsSync(TOKEN_PATH)) return false;
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  auth.setCredentials(tokens);

  // Auto-save refreshed tokens
  auth.on("tokens", (newTokens) => {
    const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    const merged = { ...existing, ...newTokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });

  return true;
}

// ── Full auth flow (run once to generate token.json) ────────────────────────

async function runAuthFlow() {
  const auth = getOAuthClient();

  // Build the Google consent URL
  const authUrl = auth.generateAuthUrl({
    access_type: "offline",   // gives us a refresh_token
    scope: SCOPES,
    prompt: "consent",        // force consent screen to ensure refresh_token is returned
  });

  console.log("\n🔐 Opening browser for Google authorization...\n");
  console.log("If it doesn't open automatically, visit:\n", authUrl);

  // Try to open the browser
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${authUrl}"`);

  // Start a local server to catch the redirect
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:8080");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.end(`<h2>Authorization failed: ${error}</h2>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.end(`
          <h2>✅ Authorization successful!</h2>
          <p>You can close this tab and return to the terminal.</p>
        `);
        server.close();
        resolve(code);
      }
    });

    server.listen(8080, () => {
      console.log("⏳ Waiting for authorization on http://localhost:8080 ...\n");
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Authorization timed out after 2 minutes"));
    }, 120_000);
  });

  // Exchange code for tokens
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

  console.log("✅ Token saved to token.json");
  console.log("   Access token expires:", new Date(tokens.expiry_date).toLocaleString());
  console.log("   Refresh token:", tokens.refresh_token ? "✅ received" : "❌ missing (re-run with prompt:consent)");
  return auth;
}

// ── Get authenticated Gmail client (used by all agents) ─────────────────────

export async function getGmailClient() {
  const auth = getOAuthClient();

  if (!loadTokens(auth)) {
    throw new Error(
      "No token.json found. Run `node gmail-auth.js` first to authenticate."
    );
  }

  // Refresh if expired
  const { expiry_date } = auth.credentials;
  if (expiry_date && Date.now() > expiry_date - 60_000) {
    const { credentials } = await auth.refreshAccessToken();
    auth.setCredentials(credentials);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
  }

  return google.gmail({ version: "v1", auth });
}

// ── Run auth flow if called directly ─────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAuthFlow().catch(console.error);
}

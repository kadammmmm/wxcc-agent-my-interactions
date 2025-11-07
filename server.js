// server.js  ESM. Tasks-only list via Search API using an OAuth Integration token.
// No Captures. No recordings.
//
// ENV REQUIRED
// WXCC_API_BASE=https://api.wxcc-us1.cisco.com
// ORG_ID=<your WxCC org id>
// WXCC_DESKTOP_ORIGIN=https://desktop.wxcc-us1.cisco-bx.com   // optional but recommended
//
// INTEGRATION_CLIENT_ID=...
// INTEGRATION_CLIENT_SECRET=...
// INTEGRATION_REDIRECT_URI=https://<your-host>/oauth/callback
// INTEGRATION_SCOPES=<exact Search permission string shown in Integration UI, no quotes>
//
// OPTIONAL
// DEFAULT_DAYS_BACK=7
//
// package.json
// { "type": "module", "scripts": { "start": "node server.js" } }

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// ----------------------------------------------------
// Setup
// ----------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// ----------------------------------------------------
// Env
// ----------------------------------------------------
const {
  DEFAULT_DAYS_BACK,
  WXCC_API_BASE,
  ORG_ID,
  WXCC_DESKTOP_ORIGIN,
  INTEGRATION_CLIENT_ID,
  INTEGRATION_CLIENT_SECRET,
  INTEGRATION_REDIRECT_URI,
  INTEGRATION_SCOPES,
} = process.env;

const defaultDaysBack = parseInt(DEFAULT_DAYS_BACK || "7", 10);
const DESKTOP_ORIGIN = WXCC_DESKTOP_ORIGIN || "https://desktop.wxcc-us1.cisco-bx.com";

// ----------------------------------------------------
// Global headers for cross origin usage
// ----------------------------------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", DESKTOP_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

// ----------------------------------------------------
// Health and root
// ----------------------------------------------------
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.status(200).send("wxcc-agent-my-interactions is up"));

// ----------------------------------------------------
// Static assets  put your widget at public/widget.html
// ----------------------------------------------------
app.use(
  "/public",
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

// Serve the widget HTML with cache and frame headers
app.get("/widget", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'self' https://*.cisco-bx.com https://*.cisco.com;"
  );
  res.sendFile("widget.html", { root: path.join(__dirname, "public") }, (err) => {
    if (err) {
      res.status(err.statusCode || 500).send(`Failed to serve widget. ${err.message}`);
    }
  });
});

// Do not cache APIs
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ----------------------------------------------------
// OAuth Integration for Search. Authorization Code
// ----------------------------------------------------
let searchToken = { access: null, refresh: null, exp: 0 };

function searchTokenValid() {
  const now = Math.floor(Date.now() / 1000);
  return Boolean(searchToken.access && searchToken.exp > now + 120);
}

async function refreshSearchTokenIfNeeded() {
  if (searchTokenValid()) return searchToken.access;
  if (!searchToken.refresh) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: searchToken.refresh,
  });

  const r = await axios.post("https://webexapis.com/v1/access_token", body, {
    auth: { username: INTEGRATION_CLIENT_ID, password: INTEGRATION_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  const now = Math.floor(Date.now() / 1000);
  searchToken.access = r.data.access_token;
  searchToken.refresh = r.data.refresh_token || searchToken.refresh;
  searchToken.exp = now + (r.data.expires_in || 3600);
  return searchToken.access;
}

// Kick off OAuth
app.get("/oauth/login", (req, res) => {
  const params = new URLSearchParams({
    client_id: INTEGRATION_CLIENT_ID,
    response_type: "code",
    redirect_uri: INTEGRATION_REDIRECT_URI,
    scope: INTEGRATION_SCOPES || "",
    state: "nonce_" + Math.random().toString(36).slice(2),
  });
  res.redirect(`https://webexapis.com/v1/authorize?${params.toString()}`);
});

// OAuth callback
app.get("/oauth/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing code");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: INTEGRATION_REDIRECT_URI,
    });

    const r = await axios.post("https://webexapis.com/v1/access_token", body, {
      auth: { username: INTEGRATION_CLIENT_ID, password: INTEGRATION_CLIENT_SECRET },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    const now = Math.floor(Date.now() / 1000);
    searchToken.access = r.data.access_token;
    searchToken.refresh = r.data.refresh_token;
    searchToken.exp = now + (r.data.expires_in || 3600);

    res.status(200).send("Search API authorized. You can close this tab.");
  } catch (e) {
    res.status(500).send(`OAuth callback failed. ${e.message}`);
  }
});

// ----------------------------------------------------
// Utils
// ----------------------------------------------------
const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

// Normalize task item for UI
function normalizeTask(t) {
  // Many tenants include these fields. Leave undefined if absent.
  const participants = Array.isArray(t.participants) ? t.participants : [];
  const customer =
    participants.find((p) => (p?.role || "").toLowerCase() === "customer") || {};
  const agentEmail =
    t.agentEmail || t.agent?.email || participants.find((p) => p?.agentEmail)?.agentEmail || null;

  return {
    id: t.id,
    startTime: t.startTime || null,
    endTime: t.endTime || null,
    duration: t.duration || null,
    channelType: t.channelType || "telephony",
    queueName: t.queueName || t.queue?.name || null,
    ani: t.ani || customer.phoneNumber || null,
    dnis: t.dnis || t.calledNumber || null,
    agentEmail: agentEmail || null,
  };
}

// ----------------------------------------------------
// Search API. Use Integration token. Tasks only.
// ----------------------------------------------------
async function searchTasksPage({ userToken, orgId, fromMs, toMs, after = null, first = 200 }) {
  const url = `${WXCC_API_BASE.replace(/\/$/, "")}/v1/search?orgId=${encodeURIComponent(orgId)}`;

  // Keep query conservative. Different orgs expose different fields in the schema.
  const query = `
    query($from: Long!, $to: Long!, $first: Int!, $after: String) {
      tasks(
        from: $from, to: $to,
        filter: { channelType: { equals: "telephony" } },
        first: $first, after: $after
      ) {
        items {
          id
          startTime
          endTime
          duration
          channelType
          queueName
          ani
          dnis
          agentEmail
          agent { email }
          participants { role email agentEmail phoneNumber }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const variables = { from: fromMs, to: toMs, first, after };

  const r = await axios.post(url, { query, variables }, {
    headers: { Authorization: `Bearer ${userToken}` },
    timeout: 30000,
  });

  if (r.data?.errors?.length) {
    const err = new Error("search_graphql_error");
    err.response = { status: 400, data: r.data };
    throw err;
  }

  const items = r?.data?.data?.tasks?.items || [];
  const pageInfo = r?.data?.data?.tasks?.pageInfo || {};
  return { items, pageInfo };
}

// GET /api/tasks/search?hours=168&agentEmail=a@b.com&pageSize=200&maxPages=5
app.get("/api/tasks/search", async (req, res) => {
  try {
    // Ensure Search authorized
    let token = searchToken.access;
    token = await refreshSearchTokenIfNeeded();
    if (!token) {
      return res.status(401).json({ error: "search_not_authorized", login: "/oauth/login" });
    }

    if (!ORG_ID) {
      return res.status(500).json({ error: "missing_org_id", message: "Set ORG_ID in environment" });
    }

    const hours = toInt(req.query.hours, defaultDaysBack * 24);
    const toMs = Date.now();
    const fromMs = toMs - hours * 60 * 60 * 1000;
    const pageSize = toInt(req.query.pageSize, 200);
    const maxPages = toInt(req.query.maxPages, 5);
    const filterEmail = (req.query.agentEmail || "").toLowerCase();

    const all = [];
    let after = null;

    for (let i = 0; i < maxPages; i++) {
      const { items, pageInfo } = await searchTasksPage({
        userToken: token,
        orgId: ORG_ID,
        fromMs,
        toMs,
        after,
        first: pageSize,
      });

      // Local filter by agent email. Safer than assuming schema fields.
      const filtered = items.filter((t) => {
        if (!filterEmail) return true;
        const emails = new Set();
        if (t.agentEmail) emails.add(String(t.agentEmail).toLowerCase());
        if (t.agent?.email) emails.add(String(t.agent.email).toLowerCase());
        (t.participants || []).forEach((p) => {
          if (p?.email) emails.add(String(p.email).toLowerCase());
          if (p?.agentEmail) emails.add(String(p.agentEmail).toLowerCase());
        });
        return emails.has(filterEmail);
      });

      filtered.forEach((t) => all.push(normalizeTask(t)));

      if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
      after = pageInfo.endCursor;
    }

    res.json({
      count: all.length,
      fromMs,
      toMs,
      items: all,
    });
  } catch (err) {
    const up = err.response || {};
    res.status(up.status || 500).json({
      error: "search_failed",
      status: up.status,
      upstream: { status: up.status, data: up.data, url: up.config?.url },
      message: err.message,
    });
  }
});

// ----------------------------------------------------
// Diagnostics
// ----------------------------------------------------
app.get("/diag/config", (req, res) => {
  res.json({
    WXCC_API_BASE,
    ORG_ID: ORG_ID ? "set" : "not_set",
    DESKTOP_ORIGIN,
    IntegrationConfigured: Boolean(INTEGRATION_CLIENT_ID && INTEGRATION_CLIENT_SECRET && INTEGRATION_REDIRECT_URI),
    SearchAuthorized: Boolean(searchToken.access),
    SearchTokenExp: searchToken.exp || null,
    DEFAULT_DAYS_BACK: defaultDaysBack,
  });
});

app.get("/diag/routes", (req, res) => {
  const routes = [];
  app._router.stack.forEach((r) => {
    if (r.route && r.route.path) {
      const method = Object.keys(r.route.methods)[0]?.toUpperCase() || "GET";
      routes.push(`${method} ${r.route.path}`);
    }
  });
  res.json({ routes });
});

app.get("/diag/fs", (req, res) => {
  try {
    const cwd = process.cwd();
    const files = fs.readdirSync(cwd);
    const pub = path.join(cwd, "public");
    const pubFiles = fs.existsSync(pub) ? fs.readdirSync(pub) : [];
    res.json({ cwd, files, publicDir: pub, publicFiles: pubFiles });
  } catch (e) {
    res.status(500).json({ error: "fs_list_failed", detail: e.message });
  }
});

// ----------------------------------------------------
// Start
// ----------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on ${port}`);
});

// server.js  ESM. Hybrid auth: Service App for Captures. OAuth Integration for Search.

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
  WXCC_CLIENT_ID,
  WXCC_CLIENT_SECRET,
  WXCC_SCOPE,                 // Example: cjp:config_read  no quotes
  WXCC_TOKEN_URL,            // https://idbroker.webex.com/idb/oauth2/v1/access_token
  ORG_ID,                    // Strongly recommended
  WXCC_DESKTOP_ORIGIN,       // Optional. Desktop origin for CORS. Example: https://desktop.wxcc-us1.cisco-bx.com
  // OAuth Integration for Search
  INTEGRATION_CLIENT_ID,
  INTEGRATION_CLIENT_SECRET,
  INTEGRATION_REDIRECT_URI,  // Example: https://wxcc-agent-my-interactions.onrender.com/oauth/callback
  INTEGRATION_SCOPES,        // Use the exact Search scope string shown in the Integration UI
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
// Service App token cache. Client credentials
// ----------------------------------------------------
let svcToken = { access: null, exp: 0 };

async function getServiceAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (svcToken.access && svcToken.exp > now + 60) return svcToken.access;

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("scope", WXCC_SCOPE);

  const r = await axios.post(WXCC_TOKEN_URL, params, {
    auth: { username: WXCC_CLIENT_ID, password: WXCC_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  svcToken.access = r.data.access_token;
  svcToken.exp = now + (r.data.expires_in || 3600);
  return svcToken.access;
}

// Resolve org id. Prefer ORG_ID env
function resolveOrgIdFromToken(accessToken) {
  if (ORG_ID) return ORG_ID;
  const parts = String(accessToken || "").split("_");
  const last = parts[parts.length - 1];
  return /^[0-9a-f-]{8,}$/i.test(last) ? last : null;
}

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

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ----------------------------------------------------
// Search API. Use Integration token
// ----------------------------------------------------
async function searchTaskIds({ userToken, orgId, fromMs, toMs, agentEmail, pageSize = 200, maxPages = 5 }) {
  const url = `${WXCC_API_BASE.replace(/\/$/, "")}/v1/search?orgId=${encodeURIComponent(orgId)}`;
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
          agentEmail
          agent { email }
          participants { role email agentEmail }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const vars = { from: fromMs, to: toMs, first: toInt(pageSize, 200), after: null };
  const wantEmail = agentEmail ? String(agentEmail).toLowerCase() : null;

  const found = [];
  for (let page = 0; page < maxPages; page++) {
    const r = await axios.post(url, { query, variables: vars }, {
      headers: { Authorization: `Bearer ${userToken}` },
      timeout: 30000,
    });

    if (r.data?.errors?.length) {
      const err = new Error("search_graphql_error");
      err.response = { status: 400, data: r.data };
      throw err;
    }

    const items = r?.data?.data?.tasks?.items || [];
    for (const t of items) {
      if (!t?.id) continue;
      if (!wantEmail) { found.push(t.id); continue; }
      const set = new Set();
      if (t.agentEmail) set.add(String(t.agentEmail).toLowerCase());
      if (t.agent?.email) set.add(String(t.agent.email).toLowerCase());
      if (Array.isArray(t.participants)) {
        t.participants.forEach(p => {
          if (p?.email) set.add(String(p.email).toLowerCase());
          if (p?.agentEmail) set.add(String(p.agentEmail).toLowerCase());
        });
      }
      if (set.has(wantEmail)) found.push(t.id);
    }

    const info = r?.data?.data?.tasks?.pageInfo;
    if (!info?.hasNextPage || !info?.endCursor) break;
    vars.after = info.endCursor;
  }

  return Array.from(new Set(found));
}

// API. Use Integration token to get taskIds
// GET /api/tasks/search?hours=168&agentEmail=a@b.com&pageSize=200
app.get("/api/tasks/search", async (req, res) => {
  try {
    let token = searchToken.access;
    if (!token) {
      return res.status(401).json({ error: "search_not_authorized", login: "/oauth/login" });
    }
    token = await refreshSearchTokenIfNeeded();
    if (!token) {
      return res.status(401).json({ error: "search_not_authorized", login: "/oauth/login" });
    }

    const hours = toInt(req.query.hours, defaultDaysBack * 24);
    const toMs = Date.now();
    const fromMs = toMs - hours * 60 * 60 * 1000;
    const agentEmail = req.query.agentEmail || null;

    const svcAccess = await getServiceAccessToken();
    const orgId = resolveOrgIdFromToken(svcAccess);
    if (!orgId) return res.status(500).json({ error: "missing_org_id" });

    const taskIds = await searchTaskIds({
      userToken: token,
      orgId,
      fromMs,
      toMs,
      agentEmail,
      pageSize: toInt(req.query.pageSize, 200),
      maxPages: toInt(req.query.maxPages, 5),
    });

    res.json({ taskIds, count: taskIds.length, fromMs, toMs });
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
// Captures API. Use Service App token
// ----------------------------------------------------
async function listCapturesChunked({ token, orgId, taskIds, urlExpiration = 3600 }) {
  const all = [];
  const endpoint = `${WXCC_API_BASE.replace(/\/$/, "")}/v1/captures/query`;
  for (const batch of chunkArray(taskIds, 10)) {
    const r = await axios.post(
      endpoint,
      { orgId, taskIds: batch.map(String), urlExpiration: Number(urlExpiration) },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
    );
    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    all.push(...items);
  }
  return all;
}

// One taskId -> capture
app.get("/api/capture/by-task", async (req, res) => {
  try {
    const { taskId, urlExpiration = 3600 } = req.query;
    if (!taskId) return res.status(400).json({ error: "missing_taskId" });

    const token = await getServiceAccessToken();
    const orgId = resolveOrgIdFromToken(token);
    if (!orgId) return res.status(500).json({ error: "missing_org_id" });

    const endpoint = `${WXCC_API_BASE.replace(/\/$/, "")}/v1/captures/query`;
    const r = await axios.post(
      endpoint,
      { orgId, taskIds: [String(taskId)], urlExpiration: Number(urlExpiration) },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
    );

    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    res.json({ items, count: items.length });
  } catch (err) {
    const up = err.response || {};
    res.status(up.status || 500).json({
      error: "capture_fetch_failed",
      status: up.status,
      upstream: { status: up.status, url: up.config?.url, data: up.data },
      message: err.message,
    });
  }
});

// Many taskIds -> captures
app.post("/api/captures/by-tasks", async (req, res) => {
  try {
    const { taskIds = [], urlExpiration = 3600 } = req.body || {};
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: "missing_taskIds" });
    }

    const token = await getServiceAccessToken();
    const orgId = resolveOrgIdFromToken(token);
    if (!orgId) return res.status(500).json({ error: "missing_org_id" });

    const items = await listCapturesChunked({ token, orgId, taskIds, urlExpiration: Number(urlExpiration) });
    res.json({ items, count: items.length });
  } catch (err) {
    const up = err.response || {};
    res.status(up.status || 500).json({
      error: "capture_fetch_failed",
      status: up.status,
      upstream: { status: up.status, url: up.config?.url, data: up.data },
      message: err.message,
    });
  }
});

// Stream capture audio via backend
app.get("/api/capture/:id/stream", async (req, res) => {
  try {
    const token = await getServiceAccessToken();
    const url = `${WXCC_API_BASE.replace(/\/$/, "")}/v1/captures/${encodeURIComponent(req.params.id)}/download`;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "stream",
      timeout: 60000,
    });
    res.setHeader("Content-Type", r.headers["content-type"] || "audio/mpeg");
    r.data.pipe(res);
  } catch (e) {
    res.status(e.response?.status || 500).json({
      error: "stream_failed",
      detail: e.response?.data || e.message,
    });
  }
});

// Convenience. Combined route: find tasks and return captures
// GET /api/captures/recent?hours=168&agentEmail=a@b.com
app.get("/api/captures/recent", async (req, res) => {
  try {
    // Ensure Search authorized
    let tokenUser = searchToken.access;
    tokenUser = await refreshSearchTokenIfNeeded();
    if (!tokenUser) {
      return res.status(401).json({ error: "search_not_authorized", login: "/oauth/login" });
    }

    const hours = toInt(req.query.hours, defaultDaysBack * 24);
    const toMs = Date.now();
    const fromMs = toMs - hours * 60 * 60 * 1000;
    const agentEmail = req.query.agentEmail || null;

    const tokenSvc = await getServiceAccessToken();
    const orgId = resolveOrgIdFromToken(tokenSvc);
    if (!orgId) return res.status(500).json({ error: "missing_org_id" });

    const taskIds = await searchTaskIds({
      userToken: tokenUser,
      orgId,
      fromMs,
      toMs,
      agentEmail,
      pageSize: 200,
      maxPages: 5,
    });

    if (taskIds.length === 0) return res.json({ items: [], count: 0 });

    const captures = await listCapturesChunked({ token: tokenSvc, orgId, taskIds, urlExpiration: 3600 });

    const normalized = captures.map((c) => {
      const emails = new Set();
      if (c.agentEmail) emails.add(String(c.agentEmail).toLowerCase());
      if (c.agent?.email) emails.add(String(c.agent.email).toLowerCase());
      return {
        id: c.id,
        taskId: c.taskId,
        startTime: c.startTime,
        endTime: c.endTime,
        duration: c.duration,
        agentEmails: Array.from(emails),
        downloadUrl: c.downloadUrl || (Array.isArray(c.files) ? (c.files.find((f) => f.url)?.url || null) : null),
      };
    });

    res.json({ items: normalized, count: normalized.length });
  } catch (err) {
    const up = err.response || {};
    res.status(up.status || 500).json({
      error: "capture_fetch_failed",
      status: up.status,
      upstream: { status: up.status, url: up.config?.url, data: up.data },
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
    WXCC_SCOPE,
    WXCC_TOKEN_URL: !!WXCC_TOKEN_URL,
    WXCC_CLIENT_ID: WXCC_CLIENT_ID ? "set" : "missing",
    WXCC_CLIENT_SECRET: WXCC_CLIENT_SECRET ? "set" : "missing",
    DESKTOP_ORIGIN,
    ORG_ID: ORG_ID ? "set" : "not_set",
    IntegrationConfigured: Boolean(INTEGRATION_CLIENT_ID && INTEGRATION_CLIENT_SECRET && INTEGRATION_REDIRECT_URI),
    SearchAuthorized: Boolean(searchToken.access),
    SearchTokenExp: searchToken.exp || null,
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

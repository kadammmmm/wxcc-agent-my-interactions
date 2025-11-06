// server.js  ESM
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// ------------------------
// Config
// ------------------------
const {
  DEFAULT_DAYS_BACK,
  WXCC_API_BASE,
  WXCC_CLIENT_ID,
  WXCC_CLIENT_SECRET,
  WXCC_SCOPE,
  WXCC_TOKEN_URL,
  WXCC_DESKTOP_ORIGIN, // optional. set to your desktop origin if iframing
  ORG_ID,             // optional but recommended
} = process.env;

const defaultDaysBack = parseInt(DEFAULT_DAYS_BACK || "7", 10);
const DESKTOP_ORIGIN =
  WXCC_DESKTOP_ORIGIN || "https://desktop.wxcc-us1.cisco-bx.com";

// ------------------------
// Global headers for cross origin usage
// ------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", DESKTOP_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

// ------------------------
// Health and root
// ------------------------
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) =>
  res.status(200).send("wxcc-agent-my-interactions is up")
);

// ------------------------
// Static assets
// Put your widget at public/widget.html
// ------------------------
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
      res
        .status(err.statusCode || 500)
        .send(`Failed to serve widget. ${err.message}`);
    }
  });
});

// Do not cache APIs
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ------------------------
// Token cache and retrieval  Service App using client_credentials
// ------------------------
let tokenCache = { access_token: null, expires_at: 0 };

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.access_token && tokenCache.expires_at > now + 60) {
    return tokenCache.access_token;
  }

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("scope", WXCC_SCOPE);

  const resp = await axios.post(WXCC_TOKEN_URL, params, {
    auth: { username: WXCC_CLIENT_ID, password: WXCC_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  tokenCache.access_token = resp.data.access_token;
  tokenCache.expires_at = now + (resp.data.expires_in || 3600);
  return tokenCache.access_token;
}

// ------------------------
// Helpers
// ------------------------
function resolveOrgId({ accessToken }) {
  if (ORG_ID) return ORG_ID;
  if (!accessToken) return null;
  const parts = String(accessToken).split("_");
  const last = parts[parts.length - 1];
  return /^[0-9a-f-]{8,}$/i.test(last) ? last : null;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function pickAgentEmails(capture) {
  const emails = new Set();
  if (typeof capture?.agentEmail === "string") {
    emails.add(capture.agentEmail.toLowerCase());
  }
  if (capture?.agent && typeof capture.agent.email === "string") {
    emails.add(capture.agent.email.toLowerCase());
  }
  if (Array.isArray(capture?.participants)) {
    capture.participants.forEach((p) => {
      if (typeof p?.email === "string") emails.add(p.email.toLowerCase());
      if (typeof p?.agentEmail === "string") emails.add(p.agentEmail.toLowerCase());
    });
  }
  return Array.from(emails);
}

function pickUrl(capture) {
  const links = [];
  if (capture?.downloadUrl) links.push(capture.downloadUrl);
  if (Array.isArray(capture?.files)) {
    capture.files.forEach((f) => {
      if (typeof f?.url === "string") links.push(f.url);
    });
  }
  return links[0] || null;
}

// ------------------------
// Search API  fetch recent tasks for an agent
// If your tenant has a recording flag in the schema, you can add that filter
// ------------------------
async function findRecentTaskIds({ token, orgId, agentEmail, fromMs, toMs }) {
  const query = `
    query($from: Long!, $to: Long!, $email: String!) {
      tasks(
        from: $from, to: $to,
        filter: {
          agentEmail: { equals: $email },
          channelType: { equals: "telephony" }
          # hasRecording: { equals: true }  // uncomment if supported in your tenant
        }
      ) {
        items { id startTime agentEmail }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const body = { query, variables: { from: fromMs, to: toMs, email: agentEmail } };
  const url = `${WXCC_API_BASE.replace(/\/$/, "")}/search?orgId=${encodeURIComponent(orgId)}`;

  const r = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000
  });

  const items = r?.data?.data?.tasks?.items || [];
  return items.map(it => it.id).filter(Boolean);
}

// ------------------------
// Captures API  call in batches of 10 taskIds
// ------------------------
async function listCapturesChunked({ token, orgId, taskIds, urlExpiration = 3600 }) {
  const all = [];
  const chunks = chunkArray(taskIds, 10);
  const endpoint = `${WXCC_API_BASE.replace(/\/$/, "")}/v1/captures/query`;

  for (const ids of chunks) {
    const body = { orgId, taskIds: ids, urlExpiration };
    const r = await axios.post(endpoint, body, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000
    });
    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    all.push(...items);
  }
  return all;
}

// ------------------------
// API  recent captures
// ------------------------
app.get("/api/captures/recent", async (req, res) => {
  try {
    const { agentEmail, hours } = req.query;
    if (!agentEmail) {
      return res.status(400).json({ error: "missing_agent_email", message: "Provide ?agentEmail=" });
    }

    const windowHours = hours ? parseInt(hours, 10) : defaultDaysBack * 24;
    const toMs = Date.now();
    const fromMs = toMs - windowHours * 60 * 60 * 1000;

    const token = await getAccessToken();
    const orgId = resolveOrgId({ accessToken: token });
    if (!orgId) {
      return res.status(500).json({ error: "missing_org_id", message: "Set ORG_ID env or ensure token contains org id" });
    }

    // Step 1. find recent taskIds for this agent
    const taskIds = await findRecentTaskIds({ token, orgId, agentEmail, fromMs, toMs });
    if (taskIds.length === 0) {
      return res.json({ items: [], count: 0 });
    }

    // Step 2. list captures in batches of 10
    const captures = await listCapturesChunked({ token, orgId, taskIds, urlExpiration: 3600 });

    // Step 3. normalize
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
        downloadUrl:
          c.downloadUrl ||
          (Array.isArray(c.files) ? (c.files.find((f) => f.url)?.url || null) : null),
      };
    });

    res.json({ items: normalized, count: normalized.length });
  } catch (err) {
    const up = err.response || {};
    res.status(up.status || 500).json({
      error: "capture_fetch_failed",
      status: up.status,
      upstream: {
        status: up.status,
        url: up.config?.url,
        data: up.data
      },
      message: err.message
    });
  }
});

// ------------------------
// API  stream capture audio via backend
// ------------------------
app.get("/api/capture/:id/stream", async (req, res) => {
  try {
    const token = await getAccessToken();
    const url = `${WXCC_API_BASE}/v1/captures/${encodeURIComponent(req.params.id)}/download`;
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

// ------------------------
// Diagnostics
// ------------------------
app.get("/diag/config", (req, res) => {
  res.json({
    WXCC_API_BASE,
    WXCC_SCOPE,
    WXCC_TOKEN_URL: !!WXCC_TOKEN_URL,
    WXCC_CLIENT_ID: WXCC_CLIENT_ID ? "set" : "missing",
    WXCC_CLIENT_SECRET: WXCC_CLIENT_SECRET ? "set" : "missing",
    DESKTOP_ORIGIN,
    ORG_ID: ORG_ID ? "set" : "not_set",
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

// Lists files in working dir. useful if a file is missing in container
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

// ------------------------
// Start server
// ------------------------
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on ${port}`);
});

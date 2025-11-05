import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: false }));

const PORT = process.env.PORT || 8080;
const WXCC_API_BASE = process.env.WXCC_API_BASE || "https://api.wxcc-us1.cisco.com";
const TOKEN_URL = process.env.WXCC_TOKEN_URL || "https://idbroker.webex.com/idb/oauth2/v1/access_token";
const DEFAULT_DAYS_BACK = Number(process.env.DEFAULT_DAYS_BACK || 7);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------- helpers ---------- */
function normalizeError(e, route, req) {
  const status = e?.response?.status || 500;
  const data = e?.response?.data;
  const url = e?.config?.url;
  const method = e?.config?.method;
  const msg =
    (typeof data === "string" && data) ||
    data?.message ||
    data?.error_description ||
    data?.error ||
    e?.message ||
    "Unknown server error";
  console.error("UPSTREAM ERROR", { route: req?.originalUrl || route, status, method, url, msg, data });
  return {
    status,
    body: {
      error: msg || "(empty message from upstream)",
      upstream: { status, method, url, body: data ?? "(no body)" }
    }
  };
}

async function getAccessToken(req) {
  const fwd = req.headers["authorization"];
  if (fwd && /^Bearer\s+/i.test(fwd)) {
    return fwd.replace(/Bearer\s+/i, "").trim();
  }
  const { WXCC_CLIENT_ID, WXCC_CLIENT_SECRET, WXCC_SCOPE } = process.env;
  if (!WXCC_CLIENT_ID || !WXCC_CLIENT_SECRET || !TOKEN_URL) {
    throw new Error("Service credentials missing. Set WXCC_CLIENT_ID, WXCC_CLIENT_SECRET, WXCC_TOKEN_URL.");
  }
  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  if (WXCC_SCOPE && WXCC_SCOPE.trim()) params.append("scope", WXCC_SCOPE.trim());
  const r = await axios.post(TOKEN_URL, params, {
    auth: { username: WXCC_CLIENT_ID, password: WXCC_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  return r.data.access_token;
}

function dateRange(daysBack = DEFAULT_DAYS_BACK) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/* ---------- static + widget ---------- */
app.use("/public", express.static(path.join(__dirname, "public")));
app.get("/widget", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "widget.html"));
});

/* ---------- diagnostics ---------- */
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/diag/config", (req, res) => {
  res.json({
    WXCC_API_BASE,
    TOKEN_URL: TOKEN_URL ? "set" : "unset",
    WXCC_SCOPE: process.env.WXCC_SCOPE || "(unset)"
  });
});
app.get("/diag/routes", (req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).join(",").toUpperCase();
      routes.push({ methods, path: m.route.path });
    } else if (m.name === "router" && m.handle?.stack) {
      m.handle.stack.forEach((h) => {
        if (h.route) {
          const methods = Object.keys(h.route.methods).join(",").toUpperCase();
          routes.push({ methods, path: h.route.path });
        }
      });
    }
  });
  res.json({ routes });
});

/* ---------- interactions endpoint disabled here on purpose ---------- */
app.get("/api/interactions", (_req, res) => {
  res.status(501).json({
    error: "Historical interactions API is not enabled on this tenant. Use /api/captures/recent instead."
  });
});

/* ---------- captures via v1/captures/query ---------- */
/*
   We mirror your working curl:
   POST https://api.<region>.cisco.com/v1/captures/query
   Body: { "query": { "taskIds": [] } }

   Then we filter by createdAt within the requested hours window.
   If the capture payload exposes an agent email, we filter by that as well.
*/
app.get("/api/captures/recent", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const agentEmail = (req.query.agentEmail || "").toString().trim().toLowerCase();
    const hours = Math.max(1, Number(req.query.hours || 24));
    const now = new Date();
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);

    const headers = {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "Content-Type": "application/json"
    };

    const url = `${WXCC_API_BASE}/v1/captures/query`;

    // Minimal query body that matches your working curl.
    const body = { query: { taskIds: [] } };

    const r = await axios.post(url, body, { headers });

    // Normalize array of captures from various response shapes.
    const captures = Array.isArray(r.data?.items)
      ? r.data.items
      : Array.isArray(r.data)
      ? r.data
      : [];

    // Some orgs return different shapes. We will pick likely fields.
    const pickCreated = (c) => c.createdAt || c.startTime || c.timestamp || c.recordedAt || null;
    const pickUrl =
      (c) =>
        c.url ||
        c.playbackUrl ||
        c.downloadUrl ||
        (c.mediaFiles && c.mediaFiles[0] && c.mediaFiles[0].url) ||
        (c.links && (c.links.playback || c.links.download)) ||
        null;

    // Try to identify agent email in common places.
    const pickAgentEmails = (c) => {
      const emails = new Set();
      if (typeof c.agentEmail === "string") emails.add(c.agentEmail.toLowerCase());
      if (c.agent && typeof c.agent.email === "string") emails.add(c.agent.email.toLowerCase());
      if (Array.isArray(c.participants)) {
        c.participants.forEach((p) => {
          if (typeof p?.email === "string") emails.add(p.email.toLowerCase());
          if (typeof p?.agentEmail === "string") emails.add(p.agentEmail.toLowerCase());
        });
      }
      return [...emails];
    };

    const withinWindow = (c) => {
      const ts = pickCreated(c);
      if (!ts) return false;
      const t = new Date(ts);
      return t >= from && t <= now;
    };

    const agentMatches = (c) => {
      if (!agentEmail) return true;
      const emails = pickAgentEmails(c);
      if (!emails.length) return true; // do not drop if agent is not present in payload
      return emails.includes(agentEmail);
    };

    const normalized = captures
      .filter(withinWindow)
      .filter(agentMatches)
      .map((c) => {
        return {
          captureId: c.captureId || c.id || null,
          interactionId: c.interactionId || c.taskId || null,
          taskId: c.taskId || null,
          createdAt: pickCreated(c),
          url: pickUrl(c),
          // pass through a few helpful fields if present
          ani: c.ani || c.callerId || null,
          dnis: c.dnis || null,
          queueName: c.queueName || null,
          disposition: c.disposition || null
        };
      })
      .filter((x) => !!x.url);

    // Sort newest first.
    normalized.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      items: normalized,
      window: { start: from.toISOString(), end: now.toISOString() },
      note: "Results filtered client side because /v1/search is not enabled on this tenant."
    });
  } catch (e) {
    const { status, body } = normalizeError(e, "/api/captures/recent", req);
    res.status(status).json(body);
  }
});

app.listen(PORT, () => {
  console.log("My Interactions server listening on port " + PORT);
});

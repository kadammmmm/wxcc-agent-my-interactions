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

/* ---------- Helpers ---------- */
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

/* ---------- Static and Widget ---------- */
app.use("/public", express.static(path.join(__dirname, "public")));
app.get("/widget", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "widget.html"));
});

/* ---------- Diagnostics ---------- */
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

/* ---------- Interactions via Search API (GraphQL) ---------- */
/*
  We query /v1/search with a GraphQL body.
  Adjust field names if your tenant differs. The Search API is the supported
  way to read historical interactions programmatically.
*/
async function searchInteractions({ token, agentEmail, fromISO, toISO, limit }) {
  const url = `${WXCC_API_BASE}/v1/search`;
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  const query = `
    query ($from: DateTime!, $to: DateTime!, $agent: String!, $limit: Int!) {
      interactions(
        from: $from
        to: $to
        filter: { agentEmail: { equals: $agent }, interactionType: { equals: VOICE } }
        limit: $limit
        sort: { field: START_TIME, order: DESC }
      ) {
        items {
          interactionId
          startTime
          endTime
          ani
          dnis
          queueName
          disposition
          taskId
        }
      }
    }
  `;

  const variables = {
    from: fromISO,
    to: toISO,
    agent: agentEmail,
    limit: Math.min(1000, Number(limit) || 200)
  };

  const resp = await axios.post(url, { query, variables }, { headers });
  const items =
    resp.data?.data?.interactions?.items ||
    resp.data?.interactions?.items || // some tenants return a flattened payload
    [];
  return items;
}

app.get("/api/interactions", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const agentEmail = (req.query.agentEmail || "").toString().trim();
    const daysBack = Number(req.query.daysBack || DEFAULT_DAYS_BACK);
    if (!agentEmail) return res.status(400).json({ error: "agentEmail is required" });
    const { start, end } = dateRange(daysBack);

    const items = await searchInteractions({
      token,
      agentEmail,
      fromISO: start,
      toISO: end,
      limit: 200
    });

    res.json({ items });
  } catch (e) {
    const { status, body } = normalizeError(e, "/api/interactions", req);
    res.status(status).json(body);
  }
});

/* ---------- Captures. seed with interactionIds then /v1/captures/query ---------- */
app.get("/api/captures/recent", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const agentEmail = (req.query.agentEmail || "").toString().trim();
    const hours = Math.max(1, Number(req.query.hours || 24));
    const limit = Math.min(1000, Number(req.query.limit || 200));
    if (!agentEmail) return res.status(400).json({ error: "agentEmail is required" });

    const now = new Date();
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const headers = { Authorization: "Bearer " + token };

    const interactions = await searchInteractions({
      token,
      agentEmail,
      fromISO: from.toISOString(),
      toISO: now.toISOString(),
      limit
    });

    if (!interactions.length) {
      return res.json({ items: [], window: { start: from.toISOString(), end: now.toISOString() } });
    }

    const ixById = new Map(interactions.map((it) => [String(it.interactionId), it]));
    const interactionIds = [...ixById.keys()];

    const MAX_IDS_PER_CAPTURE_QUERY = 10;
    const allCaptures = [];

    async function postCapturesQuery(ids) {
      const url = `${WXCC_API_BASE}/v1/captures/query`;
      const payload = { query: { interactionIds: ids } };
      const r = await axios.post(url, payload, {
        headers: { ...headers, Accept: "application/json", "Content-Type": "application/json" }
      });
      return Array.isArray(r.data?.items) ? r.data.items : [];
    }

    for (let i = 0; i < interactionIds.length; i += MAX_IDS_PER_CAPTURE_QUERY) {
      const batch = interactionIds.slice(i, i + MAX_IDS_PER_CAPTURE_QUERY);
      const items = await postCapturesQuery(batch);
      allCaptures.push(...items);
      if (allCaptures.length >= limit) break;
    }

    const pickUrl = (rec) =>
      rec?.url ||
      rec?.playbackUrl ||
      rec?.downloadUrl ||
      (rec.mediaFiles?.[0]?.url) ||
      rec?.links?.playback ||
      rec?.links?.download ||
      null;

    const normalized = allCaptures
      .map((c) => {
        const ix = ixById.get(String(c.interactionId)) || {};
        const durationSec =
          ix.startTime && ix.endTime
            ? Math.max(0, Math.round((new Date(ix.endTime) - new Date(ix.startTime)) / 1000))
            : null;
        return {
          captureId: c.captureId || c.id || null,
          interactionId: c.interactionId || null,
          taskId: c.taskId || ix.taskId || null,
          createdAt: c.createdAt || ix.startTime || null,
          url: pickUrl(c),
          ani: ix.ani || null,
          queueName: ix.queueName || null,
          disposition: ix.disposition || null,
          durationSec
        };
      })
      .filter((x) => !!x.url);

    normalized.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const items = normalized.slice(0, limit);

    res.json({ items, window: { start: from.toISOString(), end: now.toISOString() } });
  } catch (e) {
    const { status, body } = normalizeError(e, "/api/captures/recent", req);
    res.status(status).json(body);
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("My Interactions server listening on port " + PORT);
});

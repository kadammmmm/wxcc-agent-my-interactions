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
const DEFAULT_DAYS_BACK = Number(process.env.DEFAULT_DAYS_BACK || 7);
const TOKEN_URL = process.env.WXCC_TOKEN_URL || "https://idbroker.webex.com/idb/oauth2/v1/access_token";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeAxiosError(e, route) {
  const status = e?.response?.status || 500;
  const data = e?.response?.data;
  const msg =
    typeof data === "string"
      ? data
      : data?.message ||
        data?.error_description ||
        data?.error ||
        e?.message ||
        "Unknown server error";
  console.error("API error", {
    route,
    status,
    message: msg,
    url: e?.config?.url,
    method: e?.config?.method,
    payload: e?.config?.data
  });
  return { status, msg, data };
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
  try {
    const r = await axios.post(TOKEN_URL, params, {
      auth: { username: WXCC_CLIENT_ID, password: WXCC_CLIENT_SECRET },
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    return r.data.access_token;
  } catch (e) {
    const { msg } = normalizeAxiosError(e, "oauth/token");
    throw new Error("Token request failed. " + msg);
  }
}

function dateRange(daysBack = DEFAULT_DAYS_BACK) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/widget", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "widget.html"));
});

app.get("/diag/auth", (req, res) => {
  res.json({
    authHeaderPresent: !!req.headers["authorization"],
    serviceCredsPresent: !!process.env.WXCC_CLIENT_ID && !!process.env.WXCC_CLIENT_SECRET && !!TOKEN_URL,
    WXCC_API_BASE,
    WXCC_SCOPE: process.env.WXCC_SCOPE ? "set" : "unset",
    TOKEN_URL: TOKEN_URL ? "set" : "unset"
  });
});

app.get("/diag/interactions", (req, res) => {
  res.json({
    WXCC_API_BASE,
    DEFAULT_DAYS_BACK,
    primaryPath: "/v1/data/historical/interactions/search",
    fallbackPath: "/v1/analytics/interactions/search"
  });
});

app.get("/api/interactions", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const agentEmail = (req.query.agentEmail || "").toString().trim();
    const daysBack = Number(req.query.daysBack || DEFAULT_DAYS_BACK);
    if (!agentEmail) return res.status(400).json({ error: "agentEmail is required" });

    const { start, end } = dateRange(daysBack);
    const payloadBase = {
      limit: 50,
      sort: [{ field: "startTime", order: "DESC" }],
      fields: ["interactionId", "startTime", "endTime", "ani", "dnis", "queueName", "disposition"]
    };
    const filters = [
      { field: "agentEmail", operator: "EQUALS", value: agentEmail },
      { field: "interactionType", operator: "EQUALS", value: "VOICE" },
      { field: "startTime", operator: "BETWEEN", value: [start, end] }
    ];
    const headers = { Authorization: "Bearer " + token };

    async function postSearch(url, body) {
      const r = await axios.post(url, body, { headers });
      return r.data?.items || r.data?.data || [];
    }

    let items;
    try {
      items = await postSearch(`${WXCC_API_BASE}/v1/data/historical/interactions/search`, {
        ...payloadBase,
        filters
      });
    } catch (e) {
      const status = e?.response?.status;
      if (status === 404) {
        items = await postSearch(`${WXCC_API_BASE}/v1/analytics/interactions/search`, {
          ...payloadBase,
          filters
        });
      } else if (status === 400) {
        items = await postSearch(`${WXCC_API_BASE}/v1/data/historical/interactions/search`, {
          ...payloadBase,
          filters: [
            { field: "interactionType", operator: "EQUALS", value: "VOICE" },
            { field: "startTime", operator: "BETWEEN", value: [start, end] }
          ]
        });
        items = items.filter((x) => (x.agentEmail || "").toLowerCase() === agentEmail.toLowerCase());
      } else {
        throw e;
      }
    }

    res.json({ items });
  } catch (e) {
    const { status, msg, data } = normalizeAxiosError(e, "/api/interactions");
    res.status(status).json({ error: msg, details: typeof data === "object" ? data : undefined });
  }
});

app.post("/api/recordings/query", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const headers = {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "Content-Type": "application/json"
    };
    const url = `${WXCC_API_BASE}/v1/captures/query`;
    const payload = req.body && req.body.query ? req.body : { query: {} };
    const r = await axios.post(url, payload, { headers });
    res.json(r.data);
  } catch (e) {
    const { status, msg, data } = normalizeAxiosError(e, "/api/recordings/query");
    res.status(status).json({ error: msg, details: typeof data === "object" ? data : undefined });
  }
});

app.get("/api/recordings", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const { taskId, interactionId } = req.query;
    if (!taskId && !interactionId) {
      return res.status(400).json({ error: "taskId or interactionId is required" });
    }

    const headers = {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "Content-Type": "application/json"
    };
    const url = `${WXCC_API_BASE}/v1/captures/query`;

    const payload =
      taskId
        ? { query: { taskIds: [String(taskId)] } }
        : { query: { interactionIds: [String(interactionId)] } };

    const r = await axios.post(url, payload, { headers });

    const list = Array.isArray(r.data?.items) ? r.data.items : [];
    const first = list[0] || null;

    const pickUrl = (rec) =>
      rec?.url ||
      rec?.playbackUrl ||
      rec?.downloadUrl ||
      rec?.mediaUrl ||
      (Array.isArray(rec?.mediaFiles) && rec.mediaFiles[0]?.url) ||
      rec?.links?.playback ||
      rec?.links?.download ||
      null;

    if (first) {
      const mediaUrl = pickUrl(first);
      if (mediaUrl) {
        return res.json({
          recordingId: first.captureId || first.id || null,
          url: mediaUrl,
          startTime: first.createdAt || first.startTime || null
        });
      }
    }

    return res.json({ urls: [] });
  } catch (e) {
    const { status, msg, data } = normalizeAxiosError(e, "/api/recordings");
    res.status(status).json({ error: msg, details: typeof data === "object" ? data : undefined });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("My Interactions server listening on port " + PORT);
});

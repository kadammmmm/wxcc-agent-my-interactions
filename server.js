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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function getAccessToken(req) {
  const fwd = req.headers["authorization"];
  if (fwd && /^Bearer\s+/i.test(fwd)) {
    return fwd.replace(/Bearer\s+/i, "").trim();
  }

  const { WXCC_CLIENT_ID, WXCC_CLIENT_SECRET, WXCC_TOKEN_URL, WXCC_SCOPE } = process.env;
  if (!WXCC_CLIENT_ID || !WXCC_CLIENT_SECRET || !WXCC_TOKEN_URL) {
    throw new Error("No Authorization header and service credentials not configured.");
  }

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  if (WXCC_SCOPE) params.append("scope", WXCC_SCOPE);

  const tokenResp = await axios.post(WXCC_TOKEN_URL, params, {
    auth: { username: WXCC_CLIENT_ID, password: WXCC_CLIENT_SECRET },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return tokenResp.data.access_token;
}

function dateRange(daysBack = DEFAULT_DAYS_BACK) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// Serve the widget HTML
app.get("/widget", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "widget.html"));
});

// --- API: Interactions ---
app.get("/api/interactions", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const agentEmail = (req.query.agentEmail || "").toString().trim();
    const daysBack = Number(req.query.daysBack || DEFAULT_DAYS_BACK);

    if (!agentEmail) {
      return res.status(400).json({ error: "agentEmail is required" });
    }

    const { start, end } = dateRange(daysBack);
    const url = WXCC_API_BASE + "/v1/data/historical/interactions/search";
    const payload = {
      filters: [
        { field: "agentEmail", operator: "EQUALS", value: agentEmail },
        { field: "interactionType", operator: "EQUALS", value: "VOICE" },
        { field: "startTime", operator: "BETWEEN", value: [start, end] },
      ],
      limit: 50,
      sort: [{ field: "startTime", order: "DESC" }],
      fields: ["interactionId", "startTime", "endTime", "ani", "dnis", "queueName", "disposition"],
    };

    const resp = await axios.post(url, payload, {
      headers: { Authorization: "Bearer " + token },
    });

    res.json({ items: resp.data.items || resp.data.data || [] });
  } catch (e) {
    const status = e.response?.status || 500;
    res.status(status).json({ error: e.response?.data || e.message });
  }
});

// --- API: Recordings ---
app.get("/api/recordings", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const { interactionId, agentEmail } = req.query;

    if (!interactionId) {
      return res.status(400).json({ error: "interactionId is required" });
    }

    let recUrl = WXCC_API_BASE + "/v1/recordings?interactionId=" + encodeURIComponent(interactionId);
    if (agentEmail) recUrl += "&agentEmail=" + encodeURIComponent(agentEmail);

    const recResp = await axios.get(recUrl, {
      headers: { Authorization: "Bearer " + token },
    });

    const normalize = (r) => ({
      recordingId: r.recordingId || r.id,
      url: r.url || r.playbackUrl || r.downloadUrl,
      startTime: r.startTime || r.createdAt,
    });

    const data = recResp.data;
    if (Array.isArray(data.items) && data.items.length) {
      return res.json(normalize(data.items[0]));
    }
    if (Array.isArray(data) && data.length) {
      return res.json(normalize(data[0]));
    }

    res.json({ urls: [] });
  } catch (e) {
    const status = e.response?.status || 500;
    res.status(status).json({ error: e.response?.data || e.message });
  }
});

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("My Interactions server listening on port " + PORT);
});

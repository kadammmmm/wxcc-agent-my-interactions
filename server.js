import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

const {
  DEFAULT_DAYS_BACK,
  WXCC_API_BASE,
  WXCC_CLIENT_ID,
  WXCC_CLIENT_SECRET,
  WXCC_SCOPE,
  WXCC_TOKEN_URL,
} = process.env;

const defaultDaysBack = parseInt(DEFAULT_DAYS_BACK || "7", 10);
let tokenCache = { access_token: null, expires_at: 0 };

// ------------------------------------------------------
// Helper: Get access token (Service App / client_credentials)
// ------------------------------------------------------
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
  });

  tokenCache.access_token = resp.data.access_token;
  tokenCache.expires_at = now + (resp.data.expires_in || 3600);
  return tokenCache.access_token;
}

// ------------------------------------------------------
// Helpers: Pick agent emails and audio URLs
// ------------------------------------------------------
const pickAgentEmails = (capture) => {
  const emails = new Set();
  if (typeof capture.agentEmail === "string") emails.add(capture.agentEmail.toLowerCase());
  if (capture.agent && typeof capture.agent.email === "string") emails.add(capture.agent.email.toLowerCase());
  if (Array.isArray(capture.participants)) {
    capture.participants.forEach((p) => {
      if (typeof p?.email === "string") emails.add(p.email.toLowerCase());
      if (typeof p?.agentEmail === "string") emails.add(p.agentEmail.toLowerCase());
    });
  }
  return Array.from(emails);
};

const pickUrl = (capture) => {
  const links = [];
  if (capture.downloadUrl) links.push(capture.downloadUrl);
  if (Array.isArray(capture.files)) {
    capture.files.forEach((f) => {
      if (typeof f.url === "string") links.push(f.url);
    });
  }
  return links[0] || null;
};

// ------------------------------------------------------
// Route: /api/captures/recent
// ------------------------------------------------------
app.get("/api/captures/recent", async (req, res) => {
  try {
    const { agentEmail, hours } = req.query;
    const since = new Date();
    since.setHours(since.getHours() - (hours ? parseInt(hours, 10) : defaultDaysBack * 24));

    const token = await getAccessToken();
    const url = `${WXCC_API_BASE}/v1/captures/query`;

    const r = await axios.post(
      url,
      { query: {} },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!r.data || !Array.isArray(r.data.items)) {
      return res.status(502).json({ error: "invalid_response", upstream: r.data });
    }

    const recent = r.data.items.filter((c) => {
      const start = new Date(c.startTime || c.createdTime || 0);
      return start >= since;
    });

    const normalized = recent
      .filter((c) => !agentEmail || pickAgentEmails(c).includes(agentEmail.toLowerCase()))
      .map((c) => ({
        id: c.id,
        startTime: c.startTime,
        endTime: c.endTime,
        duration: c.duration,
        agentEmails: pickAgentEmails(c),
        downloadUrl: pickUrl(c),
      }));

    res.json({ items: normalized, count: normalized.length });
  } catch (err) {
    const up = err.response || {};
    res.status(up.status || 500).json({
      error: "capture_fetch_failed",
      status: up.status,
      upstream: {
        status: up.status,
        url: up.config?.url,
        data: up.data,
      },
    });
  }
});

// ------------------------------------------------------
// Route: /api/capture/:id/stream
// Streams audio via backend to avoid CORS/auth issues
// ------------------------------------------------------
app.get("/api/capture/:id/stream", async (req, res) => {
  try {
    const token = await getAccessToken();
    const url = `${WXCC_API_BASE}/v1/captures/${encodeURIComponent(req.params.id)}/download`;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "stream",
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

// ------------------------------------------------------
// Diagnostics
// ------------------------------------------------------
app.get("/diag/config", (req, res) => {
  res.json({
    WXCC_API_BASE,
    WXCC_SCOPE,
    WXCC_TOKEN_URL: !!WXCC_TOKEN_URL,
    WXCC_CLIENT_ID: WXCC_CLIENT_ID ? "set" : "missing",
    WXCC_CLIENT_SECRET: WXCC_CLIENT_SECRET ? "set" : "missing",
  });
});

app.get("/diag/routes", (req, res) => {
  res.json({
    routes: app._router.stack
      .filter((r) => r.route)
      .map((r) => Object.keys(r.route.methods)[0].toUpperCase() + " " + r.route.path),
  });
});

// ------------------------------------------------------
// Start server
// ------------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});

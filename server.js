import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: false }));

const PORT = process.env.PORT || 8080;
const WXCC_API_BASE = process.env.WXCC_API_BASE || "https://api.wxcc-us1.cisco.com";
const DEFAULT_DAYS_BACK = Number(process.env.DEFAULT_DAYS_BACK || 7);

// --- Helper: get access token ---
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });
  return tokenResp.data.access_token;
}

// --- Helper: date range ---
function dateRange(daysBack = DEFAULT_DAYS_BACK) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

// --- Widget UI with postMessage bridge for agentEmail ---
app.get("/widget", (req, res) => {
  res.type("html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My Interactions</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 0; padding: 16px; }
      header { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 8px; border-bottom: 1px solid #e5e7eb; text-align:left; }
      th { background: #f9fafb; position: sticky; top: 0; }
      .controls { display:flex; gap:8px; align-items:center; margin-bottom: 12px; flex-wrap: wrap; }
      .badge { background:#eef2ff; color:#3730a3; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
      .muted { color:#6b7280; font-size:12px; }
      .btn { padding:6px 10px; border:1px solid #d1d5db; border-radius:8px; background:#fff; cursor:pointer; }
      audio { width: 240px; }
      input { padding:6px; border:1px solid #d1d5db; border-radius:6px }
    </style>
  </head>
  <body>
    <header>
      <h2 style="margin:0">My Interactions</h2>
      <span class="badge" id="range"></span>
    </header>

    <div class="controls">
      <label>Agent Email <input id="agentEmail" placeholder="agent@example.com"/></label>
      <label>Hours Back <input id="hoursBack" type="number" min="1" max="72" value="24" style="width:80px"/></label>
      <button class="btn" id="reload">Reload</button>
      <span class="muted">If embedded, parent can send agent email via postMessage</span>
    </div>

    <table id="grid">
      <thead>
        <tr>
          <th>Date/Time</th>
          <th>ANI</th>
          <th>Queue</th>
          <th>Disposition</th>
          <th>Duration</th>
          <th>Recording</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>

    <script>
      const $ = (s) => document.querySelector(s);

      // Prefer query param if present, else wait for parent postMessage
      const params = new URLSearchParams(location.search);
      if (params.get("agentEmail")) {
        $("#agentEmail").value = params.get("agentEmail");
      }

      // Ask parent for context, parent should reply with { type: "WXCC_CONTEXT", agentEmail: "..." }
      function requestParentContext() {
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: "REQUEST_WXCC_CONTEXT" }, "*");
          }
        } catch (_) {}
      }

      window.addEventListener("message", (ev) => {
        const d = ev?.data || {};
        if (d && d.type === "WXCC_CONTEXT" && d.agentEmail) {
          $("#agentEmail").value = d.agentEmail;
        }
      });

      // Better error surfacing
      async function getJsonOrThrow(resp) {
        const ct = resp.headers.get("content-type") || "";
        let body = null;
        if (ct.includes("application/json")) {
          body = await resp.json().catch(() => ({}));
        } else {
          const txt = await resp.text().catch(() => "");
          try { body = JSON.parse(txt); } catch { body = { error: txt || "no body" }; }
        }
        if (!resp.ok) {
          const msg = typeof body?.error === "string" ? body.error
                    : body?.message || body?.error_description
                    || JSON.stringify(body || {}) || "Request failed";
          throw new Error(resp.status + " " + resp.statusText + ". " + msg);
        }
        return body;
      }

      async function load() {
        const agentEmail = $("#agentEmail").value.trim();
        const hoursBack = Number($("#hoursBack").value || 24);
        $("#range").textContent = hoursBack + "h window";
        const tbody = $("#grid tbody");
        tbody.innerHTML = "";

        if (!agentEmail) {
          requestParentContext();
          const tr = document.createElement("tr");
          tr.innerHTML = "<td colspan='6'>Waiting for agent email from parent, or enter it above.</td>";
          tbody.appendChild(tr);
          return;
        }

        try {
          const data = await fetch(
            "/api/captures/recent?agentEmail=" + encodeURIComponent(agentEmail) + "&hours=" + hoursBack
          ).then(getJsonOrThrow);

          const items = Array.isArray(data.items) ? data.items : [];
          if (!items.length) {
            const tr = document.createElement("tr");
            tr.innerHTML = "<td colspan='6'>No recordings found in the window.</td>";
            tbody.appendChild(tr);
            return;
          }

          for (const c of items) {
            const tr = document.createElement("tr");
            const t = c.createdAt ? new Date(c.createdAt).toLocaleString() : "";
            const dur = c.durationSec != null
              ? Math.floor(c.durationSec/60) + ":" + String(c.durationSec % 60).padStart(2, "0")
              : "";
            tr.innerHTML =
              "<td>" + t + "</td>" +
              "<td>" + (c.ani || "") + "</td>" +
              "<td>" + (c.queueName || "") + "</td>" +
              "<td>" + (c.disposition || "") + "</td>" +
              "<td>" + dur + "</td>" +
              "<td>" + (c.url ? ('<audio controls src="' + c.url + '"></audio>') : "—") + "</td>";
            tbody.appendChild(tr);
          }
        } catch (e) {
          const tr = document.createElement("tr");
          tr.innerHTML = "<td colspan='6'>Failed to load: " + (e.message || "error") + "</td>";
          tbody.appendChild(tr);
        }
      }

      document.getElementById("reload").addEventListener("click", load);

      // Kick off a parent context request shortly after load
      setTimeout(requestParentContext, 50);
      // If query param already set, auto load
      if ($("#agentEmail").value) load();
    </script>
  </body>
</html>
  `);
});

// --- API: captures for last N hours, default 24 ---
app.get("/api/captures/recent", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const agentEmail = (req.query.agentEmail || "").toString().trim();
    const hours = Math.max(1, Number(req.query.hours || 24));
    const limit = Math.min(1000, Number(req.query.limit || 200));

    if (!agentEmail) return res.status(400).json({ error: "agentEmail is required" });

    const now = new Date();
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const headers = { Authorization: "Bearer " + token };

    // 1) Fetch recent interactions for this agent
    const interactionsUrl = `${WXCC_API_BASE}/v1/data/historical/interactions/search`;
    const interactionsPayload = {
      filters: [
        { field: "agentEmail", operator: "EQUALS", value: agentEmail },
        { field: "interactionType", operator: "EQUALS", value: "VOICE" },
        { field: "startTime", operator: "BETWEEN", value: [start.toISOString(), now.toISOString()] }
      ],
      limit,
      sort: [{ field: "startTime", order: "DESC" }],
      fields: ["interactionId", "taskId", "startTime", "endTime", "ani", "queueName", "disposition"]
    };

    async function fetchInteractions() {
      try {
        const r = await axios.post(interactionsUrl, interactionsPayload, { headers });
        return r.data?.items || r.data?.data || [];
      } catch (e) {
        if (e.response?.status === 404) {
          const alt = `${WXCC_API_BASE}/v1/analytics/interactions/search`;
          const r2 = await axios.post(alt, interactionsPayload, { headers });
          return r2.data?.items || r2.data?.data || [];
        }
        throw e;
      }
    }

    const interactions = await fetchInteractions();
    if (!interactions.length) return res.json({ items: [] });

    const ixById = new Map(interactions.map((it) => [String(it.interactionId), it]));

    // 2) Query captures by interactionIds in batches
    const interactionIds = [...ixById.keys()];
    const batchSize = 100;
    const allCaptures = [];

    for (let i = 0; i < interactionIds.length; i += batchSize) {
      const batch = interactionIds.slice(i, i + batchSize);
      const url = `${WXCC_API_BASE}/v1/captures/query`;
      const payload = { query: { interactionIds: batch } };
      const r = await axios.post(url, payload, {
        headers: {
          ...headers,
          Accept: "application/json",
          "Content-Type": "application/json"
        }
      });
      const items = Array.isArray(r.data?.items) ? r.data.items : [];
      allCaptures.push(...items);
      if (allCaptures.length >= limit) break;
    }

    // 3) Normalize
    const pickUrl = (rec) =>
      rec?.url || rec?.playbackUrl || rec?.downloadUrl ||
      (rec.mediaFiles?.[0]?.url) || rec?.links?.playback || rec?.links?.download || null;

    const normalized = allCaptures.map((c) => {
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
    }).filter((x) => !!x.url);

    normalized.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const items = normalized.slice(0, limit);

    res.json({ items, window: { start: start.toISOString(), end: now.toISOString() } });
  } catch (e) {
    const status = e.response?.status || 500;
    const data = e.response?.data;
    const msg =
      typeof data === "string"
        ? data
        : data?.message || data?.error_description || data?.error || e.message || "Unknown server error";
    res.status(status).json({ error: msg, details: typeof data === "object" ? data : undefined });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`My Interactions server listening on port ${PORT}`);
});

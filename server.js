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

  try {
    const tokenResp = await axios.post(WXCC_TOKEN_URL, params, {
      auth: { username: WXCC_CLIENT_ID, password: WXCC_CLIENT_SECRET },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return tokenResp.data.access_token;
  } catch (err) {
    const msg =
      err.response?.data?.error_description ||
      err.response?.data?.error ||
      err.message;
    throw new Error("Token request failed: " + msg);
  }
}

// --- Helper: date range ---
function dateRange(daysBack = DEFAULT_DAYS_BACK) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

// --- Widget UI ---
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
      .controls { display:flex; gap:8px; align-items:center; margin-bottom: 12px; }
      .badge { background:#eef2ff; color:#3730a3; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
      .muted { color:#6b7280; font-size:12px; }
      .btn { padding:6px 10px; border:1px solid #d1d5db; border-radius:8px; background:#fff; cursor:pointer; }
      audio { width: 240px; }
    </style>
  </head>
  <body>
    <header>
      <h2 style="margin:0">My Interactions</h2>
      <span class="badge" id="range"></span>
    </header>

    <div class="controls">
      <label>Agent Email <input id="agentEmail" style="padding:6px; border:1px solid #d1d5db; border-radius:6px" placeholder="agent@example.com"/></label>
      <label>Days Back <input id="daysBack" type="number" min="1" max="60" value="${DEFAULT_DAYS_BACK}" style="width:70px; padding:6px; border:1px solid #d1d5db; border-radius:6px"/></label>
      <button class="btn" id="reload">Reload</button>
      <span class="muted">(If embedded in Agent Desktop, pass Authorization and agentEmail via query or headers)</span>
    </div>

    <table id="grid">
      <thead>
        <tr>
          <th>Date/Time</th>
          <th>ANI</th>
          <th>DNIS</th>
          <th>Queue</th>
          <th>Disposition</th>
          <th>Duration</th>
          <th>Recording</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>

    <script>
      const \$ = (s) => document.querySelector(s);
      const params = new URLSearchParams(location.search);
      if (params.get("agentEmail")) $("#agentEmail").value = params.get("agentEmail");

      async function getJsonOrThrow(resp) {
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          const errText = typeof body.error === "string" ? body.error : JSON.stringify(body.error || body);
          throw new Error(errText || "Request failed");
        }
        return body;
      }

      async function load() {
        const agentEmail = $("#agentEmail").value.trim();
        const daysBack = Number($("#daysBack").value || ${DEFAULT_DAYS_BACK});
        $("#range").textContent = daysBack + " day window";

        if (!agentEmail) { alert("Enter Agent Email"); return; }

        const tbody = document.querySelector("#grid tbody");
        tbody.innerHTML = "";

        try {
          const interactions = await fetch("/api/interactions?agentEmail=" + encodeURIComponent(agentEmail) + "&daysBack=" + daysBack)
            .then(getJsonOrThrow);

          for (const it of interactions.items || []) {
            const tr = document.createElement("tr");
            const started = new Date(it.startTime).toLocaleString();
            const durationSec = Math.round((new Date(it.endTime) - new Date(it.startTime)) / 1000);
            const mm = Math.floor(durationSec / 60).toString().padStart(2, "0");
            const ss = (durationSec % 60).toString().padStart(2, "0");
            tr.innerHTML = \`
              <td>\${started}</td>
              <td>\${it.ani || ""}</td>
              <td>\${it.dnis || ""}</td>
              <td>\${it.queueName || ""}</td>
              <td>\${it.disposition || ""}</td>
              <td>\${mm}:\${ss}</td>
              <td data-rec>Loading...</td>
            \`;
            tbody.appendChild(tr);

            try {
              const rec = await fetch("/api/recordings?interactionId=" + encodeURIComponent(it.interactionId) + "&agentEmail=" + encodeURIComponent(agentEmail)).then(getJsonOrThrow);
              const cell = tr.querySelector("[data-rec]");
              if (rec && rec.url) {
                cell.innerHTML = '<audio controls src="' + rec.url + '"></audio>';
              } else {
                cell.textContent = "—";
              }
            } catch (e) {
              tr.querySelector("[data-rec]").textContent = "—";
            }
          }

          if (!interactions.items?.length) {
            const tr = document.createElement("tr");
            tr.innerHTML = "<td colspan='7'>No interactions found.</td>";
            tbody.appendChild(tr);
          }

        } catch (err) {
          const tr = document.createElement("tr");
          tr.innerHTML = "<td colspan='7'>Failed to load interactions: " + err.message + "</td>";
          tbody.appendChild(tr);
        }
      }

      $("#reload").addEventListener("click", load);
      if ($("#agentEmail").value) load();
    </script>
  </body>
</html>
  `);
});

// --- API: interactions ---
app.get("/api/interactions", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const agentEmail = (req.query.agentEmail || "").toString().trim();
    const daysBack = Number(req.query.daysBack || DEFAULT_DAYS_BACK);
    if (!agentEmail) return res.status(400).json({ error: "agentEmail is required" });

    const { start, end } = dateRange(daysBack);
    const url = `${WXCC_API_BASE}/v1/data/historical/interactions/search`;

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
      headers: { Authorization: `Bearer ${token}` },
    });

    res.json({ items: resp.data.items || resp.data.data || [] });
  } catch (e) {
    const status = e.response?.status || 500;
    const data = e.response?.data;
    const msg =
      typeof data === "string"
        ? data
        : data?.message || data?.error || e.message || "Unknown server error";
    console.error("API error", { route: req.originalUrl, status, message: msg, data });
    res.status(status).json({ error: msg, details: typeof data === "object" ? data : undefined });
  }
});

// --- API: recordings ---
app.get("/api/recordings", async (req, res) => {
  try {
    const token = await getAccessToken(req);
    const { taskId, interactionId, agentEmail } = req.query;
    if (!taskId && !interactionId)
      return res.status(400).json({ error: "taskId or interactionId is required" });

    const auth = { headers: { Authorization: "Bearer " + token } };
    const pickUrl = (r) =>
      r?.url || r?.playbackUrl || r?.downloadUrl || r?.mediaUrl || r?.links?.playback || r?.links?.download || null;

    const capturesUrl = `${WXCC_API_BASE}/v1/data/historical/captures/search`;

    async function tryCapturesSearch(field, value) {
      const payload = {
        filters: [{ field, operator: "EQUALS", value: String(value) }],
        limit: 1,
        sort: [{ field: "createdAt", order: "DESC" }],
        fields: [
          "id",
          "captureId",
          field,
          "createdAt",
          "url",
          "playbackUrl",
          "downloadUrl",
          "mediaUrl",
          "links",
        ],
      };
      const resp = await axios.post(capturesUrl, payload, auth);
      const item = Array.isArray(resp.data.items) && resp.data.items[0] ? resp.data.items[0] : null;
      const mediaUrl = item ? pickUrl(item) : null;
      if (mediaUrl) {
        return {
          recordingId: item.captureId || item.id,
          url: mediaUrl,
          startTime: item.createdAt || null,
        };
      }
      return null;
    }

    let result = null;
    if (taskId) result = await tryCapturesSearch("taskId", taskId);
    if (!result && interactionId) result = await tryCapturesSearch("interactionId", interactionId);

    // Fallback to legacy recordings endpoint
    if (!result && interactionId) {
      let recUrl = `${WXCC_API_BASE}/v1/recordings?interactionId=${encodeURIComponent(String(interactionId))}`;
      if (agentEmail) recUrl += `&agentEmail=${encodeURIComponent(String(agentEmail))}`;
      const r = await axios.get(recUrl, auth);
      const arr = Array.isArray(r.data?.items)
        ? r.data.items
        : Array.isArray(r.data)
        ? r.data
        : [];
      const first = arr[0] || null;
      const mediaUrl = first ? pickUrl(first) : null;
      if (mediaUrl) {
        result = {
          recordingId: first.recordingId || first.id,
          url: mediaUrl,
          startTime: first.startTime || first.createdAt || null,
        };
      }
    }

    if (result) return res.json(result);
    res.json({ urls: [] });
  } catch (e) {
    const status = e.response?.status || 500;
    const data = e.response?.data;
    const msg =
      typeof data === "string"
        ? data
        : data?.message || data?.error || e.message || "Unknown server error";
    console.error("API error", { route: req.originalUrl, status, message: msg, data });
    res.status(status).json({ error: msg, details: typeof data === "object" ? data : undefined });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`My Interactions server listening on :${PORT}`);
});

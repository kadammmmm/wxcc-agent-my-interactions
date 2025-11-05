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
const TOKEN_URL = process.env.WXCC_TOKEN_URL || "https://idbroker.webex.com/idb/oauth2/v1/access_token";
const DEFAULT_DAYS_BACK = Number(process.env.DEFAULT_DAYS_BACK || 7);

function pick(err, route) {
  const status = err?.response?.status || 500;
  const data = err?.response?.data;
  const msg =
    typeof data === "string"
      ? data
      : data?.message || data?.error_description || data?.error || err?.message || "Unknown server error";
  console.error("API error", {
    route,
    status,
    message: msg,
    url: err?.config?.url,
    method: err?.config?.method,
    payload: err?.config?.data
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
    const { msg } = pick(e, "oauth/token");
    throw new Error("Token request failed. " + msg);
  }
}

function dateRange(daysBack = DEFAULT_DAYS_BACK) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

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
      <span class="muted">Parent can send agent email via postMessage</span>
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

      const params = new URLSearchParams(location.search);
      if (params.get("agentEmail")) {
        $("#agentEmail").value = params.get("agentEmail");
      }

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
          const msg = body?.error || body?.message || body?.error_description || JSON.stringify(body || {});
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
      setTimeout(requestParentContext, 50);
      if ($("#agentEmail").value) load();
    </script>
  </body>
</html>
  `);
});

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
      const primary = `${WXCC_API_BASE}/v1/data/historical/interactions/search`;
      try {
        const r = await axios.post(primary, interactionsPayload, { headers });
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
    const interactionIds = [...ixById.keys()];

    const MAX_IDS_PER_CAPTURE_QUERY = 10;
    const allCaptures = [];

    async function postCapturesQuery(ids) {
      const url = `${WXCC_API_BASE}/v1/captures/query`;
      const payload = { query: { interactionIds: ids } };
      const r = await axios.post(url, payload, {
        headers: {
          ...headers,
          Accept: "application/json",
          "Content-Type": "application/json"
        }
      });
      return Array.isArray(r.data?.items) ? r.data.items : [];
    }

    async function postCapturesSearch(ids) {
      const url = `${WXCC_API_BASE}/v1/data/historical/captures/search`;
      const filters = ids.map((id) => ({ field: "interactionId", operator: "EQUALS", value: id }));
      const payload = {
        filters,
        limit: ids.length,
        sort: [{ field: "createdAt", order: "DESC" }],
        fields: ["id", "captureId", "interactionId", "taskId", "createdAt", "url", "playbackUrl", "downloadUrl", "mediaFiles", "links"]
      };
      const r = await axios.post(url, payload, { headers });
      return Array.isArray(r.data?.items) ? r.data.items : [];
    }

    for (let i = 0; i < interactionIds.length; i += MAX_IDS_PER_CAPTURE_QUERY) {
      const batch = interactionIds.slice(i, i + MAX_IDS_PER_CAPTURE_QUERY);
      try {
        const items = await postCapturesQuery(batch);
        allCaptures.push(...items);
      } catch (e) {
        if (e.response?.status === 404) {
          const items2 = await postCapturesSearch(batch);
          allCaptures.push(...items2);
        } else {
          throw e;
        }
      }
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

    res.json({ items, window: { start: start.toISOString(), end: now.toISOString() } });
  } catch (e) {
    const { status, msg, data } = pick(e, "/api/captures/recent");
    res.status(status).json({ error: msg, details: typeof data === "object" ? data : undefined });
  }
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
    const { status, msg, data } = pick(e, "/api/interactions");
    res.status(status).json({ error: msg, details: typeof data === "object" ? data : undefined });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("My Interactions server listening on port " + PORT);
});

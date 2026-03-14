/**
 * Royal Priskalkulator → WoonTotaal Backend Proxy v2
 * Updated with correct API paths based on testing
 */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const WT_BASE_URL = process.env.WT_BASE_URL || 'https://bestilling.royalsolskjerming.no';
const WT_DOMAIN   = process.env.WT_DOMAIN   || 'Royal';
const WT_USERNAME = process.env.WT_USERNAME || 'kristoffer';
const WT_PASSWORD = process.env.WT_PASSWORD || '';
const PORT        = process.env.PORT        || 3001;

// ─── TOKEN ────────────────────────────────────────────────────────────
let cachedToken    = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const res = await fetch(`${WT_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domainName: WT_DOMAIN, username: WT_USERNAME, password: WT_PASSWORD })
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(e) {
    throw new Error(`Token endpoint returned HTML - check credentials. Status: ${res.status}`);
  }
  if (!data.access_token) throw new Error(`No token in response: ${JSON.stringify(data)}`);
  cachedToken    = `${data.token_type} ${data.access_token}`;
  tokenExpiresAt = new Date(data['.expires']).getTime() - 60000;
  return cachedToken;
}

function authHeaders(token) {
  return { 'Content-Type': 'application/json', 'Authorization': token };
}

// Helper: try multiple URL variants and return first that gives JSON
async function tryEndpoints(paths, method, token, body) {
  for (const path of paths) {
    const url = WT_BASE_URL + path;
    try {
      const opts = { method, headers: authHeaders(token) };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      const text = await res.text();
      if (text.trim().startsWith('<')) {
        console.log(`  ${path} → HTML (wrong endpoint)`);
        continue;
      }
      const json = JSON.parse(text);
      console.log(`  ${path} → OK (status ${res.status})`);
      return { ok: res.ok, status: res.status, data: json, url };
    } catch(e) {
      console.log(`  ${path} → Error: ${e.message}`);
    }
  }
  return null;
}

// ─── HEALTH ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, base: WT_BASE_URL }));

// ─── PROBE: discover working endpoints ────────────────────────────────
app.get('/api/probe', async (req, res) => {
  try {
    const token = await getToken();
    const results = {};

    // Test GET endpoints
    const getEndpoints = [
      '/api/Gateway/Material',
      '/gateway/material',
      '/api/Gateway/Project',
      '/gateway/project',
      '/api/Gateway/Supplier',
      '/api/Gateway/Model',
      '/api/Gateway/Status',
    ];

    for (const path of getEndpoints) {
      const url = WT_BASE_URL + path;
      try {
        const r = await fetch(url, { headers: authHeaders(token) });
        const text = await r.text();
        const isJson = !text.trim().startsWith('<');
        results[path] = { status: r.status, isJson, preview: text.slice(0,80) };
      } catch(e) {
        results[path] = { error: e.message };
      }
    }

    res.json({ tokenOk: true, endpoints: results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CREATE PROJECT ───────────────────────────────────────────────────
app.post('/api/create-project', async (req, res) => {
  try {
    const { products, customer } = req.body;
    if (!products || !products.length) return res.status(400).json({ error: 'No products' });

    const token = await getToken();
    console.log('Creating project, token OK');

    // Try multiple path variants for creating a project
    const createResult = await tryEndpoints([
      '/api/Gateway/Project',
      '/gateway/project',
      '/api/gateway/project',
      '/Gateway/Project',
    ], 'POST', token, {});

    if (!createResult) {
      throw new Error('Could not create project - all endpoint variants returned HTML. The API path needs to be confirmed with Sieval.');
    }

    let project = createResult.data;
    console.log('Project created:', project.id, 'via', createResult.url);

    // Set products on polygons
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      let polygon = project.polygons && project.polygons[i];

      if (!polygon && i > 0) {
        const addResult = await tryEndpoints([
          '/api/Gateway/Polygon',
          '/gateway/polygon',
        ], 'POST', token, { projectId: project.id });
        if (addResult) { project = addResult.data; polygon = project.polygons[i]; }
      }

      if (polygon && p.materialCode) {
        const modelResult = await tryEndpoints([
          '/api/Gateway/Model',
          '/gateway/model',
        ], 'POST', token, { polygonId: polygon.id, materialCode: p.materialCode });
        if (modelResult) {
          project = modelResult.data;
          polygon = project.polygons[i];
        }
      }

      if (polygon) {
        polygon.width       = p.w * 10; // cm to mm
        polygon.height      = p.h * 10;
        polygon.amount      = p.qty || 1;
        polygon.description = p.desc || '';
      }
    }

    // Attach customer
    if (customer && customer.name) {
      await tryEndpoints(['/api/Gateway/Customer','/gateway/customer'], 'POST', token, {
        projectId: project.id, name: customer.name, email: customer.email||'',
        address: customer.addr||'', city: customer.city||''
      });
    }

    // Calculate
    const calcResult = await tryEndpoints([
      `/api/Gateway/Project/${project.id}/Calculate`,
      `/gateway/project/${project.id}/calculate`,
    ], 'POST', token, project);
    if (calcResult) project = calcResult.data;

    // Save (required before Send per Sieval docs)
    const saveResult = await tryEndpoints([
      '/api/Gateway/Project/Save',
      '/gateway/project/save',
    ], 'POST', token, project);
    if (saveResult) project = saveResult.data;

    // Build embed URL
    const embedUrl = `${WT_BASE_URL}?token=${encodeURIComponent(token)}&isEmbedded=true&projectId=${project.id}`;
    return res.json({ projectId: project.id, embedUrl });

  } catch(e) {
    console.error('create-project error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─── SEND PROJECT ─────────────────────────────────────────────────────
app.post('/api/send-project', async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    const token = await getToken();

    // Get project
    const getResult = await tryEndpoints([
      `/api/Gateway/Project/${projectId}`,
      `/gateway/project/${projectId}`,
    ], 'GET', token, null);
    if (!getResult) throw new Error('Could not get project');
    const project = getResult.data;

    // Save then Send
    await tryEndpoints(['/api/Gateway/Project/Save','/gateway/project/save'], 'POST', token, project);
    const sendResult = await tryEndpoints([
      '/api/Gateway/Project/Send',
      '/gateway/project/send',
    ], 'POST', token, { projectId });

    if (!sendResult) throw new Error('Send endpoint failed');
    return res.json({ success: true });

  } catch(e) {
    console.error('send-project error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Royal→WoonTotaal proxy v2 running on port ${PORT}`));

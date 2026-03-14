/**
 * Royal Priskalkulator → Sieval / WoonTotaal
 * Backend proxy server (Node.js + Express)
 *
 * Correct API paths confirmed via email chain with Sieval (Ruurd Zwigt):
 *   POST /api/Gateway/Project/Save  ← must be called first
 *   POST /api/Gateway/Project/Send  ← called after Save
 *
 * Install:  npm install express cors node-fetch dotenv
 * Run:      node sieval-backend.js
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// ─── CONFIG (.env) ────────────────────────────────────────────────────
const WT_BASE_URL = process.env.WT_BASE_URL || 'https://bestilling.royalsolskjerming.no';
const WT_DOMAIN   = process.env.WT_DOMAIN   || 'Royal';
const WT_USERNAME = process.env.WT_USERNAME || 'kristoffer';
const WT_PASSWORD = process.env.WT_PASSWORD || 'wt2020';
const PORT        = process.env.PORT        || 3001;

// ─── TOKEN CACHE ──────────────────────────────────────────────────────
let cachedToken    = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await fetch(`${WT_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      domainName: WT_DOMAIN,
      username:   WT_USERNAME,
      password:   WT_PASSWORD
      // no apiKey needed for Royal
    })
  });

  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const data = await res.json();

  cachedToken    = `${data.token_type} ${data.access_token}`;
  tokenExpiresAt = new Date(data['.expires']).getTime() - 60000;
  return cachedToken;
}

function authHeaders(token) {
  return {
    'Content-Type':  'application/json',
    'Authorization': token
  };
}

// ─── ROUTE: Create project from Royal quote ───────────────────────────
//
// POST /api/create-project
// Body: { products: [...], customer: {...} }
//
// Returns: { projectId, embedUrl }
// ─────────────────────────────────────────────────────────────────────
app.post('/api/create-project', async (req, res) => {
  try {
    const { products, customer } = req.body;
    if (!products || !products.length) {
      return res.status(400).json({ error: 'No products provided' });
    }

    const token = await getToken();

    // 1) Create empty project
    const createRes = await fetch(`${WT_BASE_URL}/api/Gateway/Project`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({})
    });
    if (!createRes.ok) throw new Error(`Create project failed: ${createRes.status} ${await createRes.text()}`);
    let project = await createRes.json();
    console.log('Project created:', project.id);

    // 2) Set model + dimensions for each product line
    for (let i = 0; i < products.length; i++) {
      const p = products[i];

      // Get or create polygon for this line
      let polygon = project.polygons[i];
      if (!polygon) {
        const addRes = await fetch(`${WT_BASE_URL}/api/Gateway/Polygon`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ projectId: project.id })
        });
        if (!addRes.ok) throw new Error(`Add polygon failed: ${addRes.status}`);
        project = await addRes.json();
        polygon = project.polygons[i];
      }

      // Set material/model
      const modelRes = await fetch(`${WT_BASE_URL}/api/Gateway/Model`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          polygonId:    polygon.id,
          materialCode: p.materialCode
        })
      });
      if (!modelRes.ok) throw new Error(`Set model failed: ${modelRes.status}`);
      project = await modelRes.json();
      polygon = project.polygons[i];

      // Set dimensions and qty
      polygon.width       = p.w;
      polygon.height      = p.h;
      polygon.amount      = p.qty || 1;
      polygon.description = p.desc || '';
    }

    // 3) Attach customer info
    if (customer && customer.name) {
      const custRes = await fetch(`${WT_BASE_URL}/api/Gateway/Customer`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          projectId: project.id,
          name:      customer.name,
          email:     customer.email || '',
          address:   customer.addr  || '',
          city:      customer.city  || ''
        })
      });
      if (!custRes.ok) console.warn('Customer attach failed:', custRes.status);
    }

    // 4) Calculate
    const calcRes = await fetch(`${WT_BASE_URL}/api/Gateway/Project/${project.id}/Calculate`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(project)
    });
    if (!calcRes.ok) throw new Error(`Calculate failed: ${calcRes.status}`);
    project = await calcRes.json();
    console.log('Project calculated, id:', project.id);

    // 5) SAVE first (required before Send — confirmed by Sieval)
    const saveRes = await fetch(`${WT_BASE_URL}/api/Gateway/Project/Save`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(project)
    });
    if (!saveRes.ok) throw new Error(`Save failed: ${saveRes.status} ${await saveRes.text()}`);
    project = await saveRes.json();
    console.log('Project saved, id:', project.id);

    // 6) Return embed URL so dealer can review in iframe before sending
    const freshToken = await getToken();
    const embedUrl = `${WT_BASE_URL}?token=${encodeURIComponent(freshToken)}&isEmbedded=true&projectId=${project.id}`;

    return res.json({ projectId: project.id, embedUrl });

  } catch (err) {
    console.error('create-project error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE: Send project as order ─────────────────────────────────────
// Called after dealer confirms in the iframe (SAVE_PROJECT event)
// POST /api/send-project  { projectId }
app.post('/api/send-project', async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    const token = await getToken();

    // Get current project state
    const getRes = await fetch(`${WT_BASE_URL}/api/Gateway/Project/${projectId}`, {
      headers: authHeaders(token)
    });
    if (!getRes.ok) throw new Error(`Get project failed: ${getRes.status}`);
    const project = await getRes.json();

    // Save again with latest state (belt-and-suspenders)
    const saveRes = await fetch(`${WT_BASE_URL}/api/Gateway/Project/Save`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(project)
    });
    if (!saveRes.ok) throw new Error(`Pre-send save failed: ${saveRes.status}`);

    // Send — this creates the order + PDF confirmation
    const sendRes = await fetch(`${WT_BASE_URL}/api/Gateway/Project/Send`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ projectId })
    });
    if (!sendRes.ok) throw new Error(`Send failed: ${sendRes.status} ${await sendRes.text()}`);
    const result = await sendRes.json();
    console.log('Project sent as order:', projectId);

    return res.json({ success: true, result });

  } catch (err) {
    console.error('send-project error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE: Get project ───────────────────────────────────────────────
app.get('/api/project/:id', async (req, res) => {
  try {
    const token = await getToken();
    const r = await fetch(`${WT_BASE_URL}/api/Gateway/Project/${req.params.id}`, {
      headers: authHeaders(token)
    });
    if (!r.ok) throw new Error(`Get project failed: ${r.status}`);
    return res.json(await r.json());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE: Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Royal→WoonTotaal proxy running on port ${PORT}`));

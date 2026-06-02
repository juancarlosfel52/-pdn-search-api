const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const SERPER_API_KEY = process.env.SERPER_API_KEY || '';

/* ── Serper Search ────────────────────────────────────────── */
async function serperSearch(query) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': SERPER_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ q: query, num: 10, gl: 'us', hl: 'en' })
  });
  if (!res.ok) throw new Error(`Serper API error ${res.status}`);
  return res.json();
}

/* ── Parse Serper result into listing format ──────────────── */
function parseSerperItem(item) {
  const title   = item.title || '';
  const link    = item.link  || '';
  const snippet = item.snippet || '';
  const source  = (() => {
    try { return new URL(link).hostname.replace('www.',''); } catch(_) { return 'Web'; }
  })();

  const price = (title + ' ' + snippet).match(/\$[\d,]+/)?.[0] || null;
  const year  = (title + ' ' + snippet).match(/\b(19|20)\d{2}\b/)?.[0] || null;
  const image = item.imageUrl || null;

  const location = (() => {
    const m = (title + ' ' + snippet).match(/\b(Houston|Dallas|San Antonio|Austin|El Paso|Laredo|Texas|TX)\b/i);
    return m ? m[0] + (m[0].match(/Texas|TX/i) ? '' : ', TX') : 'Texas';
  })();

  return {
    id:          link + '-' + Math.random(),
    title:       title.replace(/\s*[-|]\s*.+$/, '').trim(),
    price,
    year,
    mileage:     null,
    location,
    image,
    url:         link,
    source:      source.includes('craigslist') ? 'Craigslist' : source,
    description: snippet.slice(0, 300),
    posted:      null,
    seller: {
      name:  'See listing',
      phone: 'See listing',
      email: 'See listing'
    },
    sellerTrust: 'new',
    trustNote:   'Verify seller independently'
  };
}

/* ── GET /search/stream (SSE) ─────────────────────────────── */
app.get('/search/stream', async (req, res) => {
  const query = (req.query.q || 'semi truck').trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const searches = [
    { label: 'Google Results',  q: `${query} semi truck for sale Texas` },
    { label: 'Classifieds',     q: `${query} truck site:craigslist.org OR site:truckpaper.com OR site:commercialtrucktrader.com` },
  ];

  send('start', { total_cities: searches.length, query });

  let total = 0;

  for (const s of searches) {
    try {
      const data  = await serperSearch(s.q);
      const items = (data.organic || []).map(parseSerperItem);
      total += items.length;
      send('city', { city: s.label, ok: true, count: items.length, items });
    } catch(e) {
      send('city', { city: s.label, ok: false, error: e.message, items: [] });
    }
  }

  send('done', { total, query });
  res.end();
});

/* ── GET /search (batch) ──────────────────────────────────── */
app.get('/search', async (req, res) => {
  const query = (req.query.q || 'semi truck').trim();

  const searches = [
    { label: 'Google Results',  q: `${query} semi truck for sale Texas` },
    { label: 'Classifieds',     q: `${query} truck site:craigslist.org OR site:truckpaper.com OR site:commercialtrucktrader.com` },
  ];

  const results  = [];
  const statuses = {};

  for (const s of searches) {
    try {
      const data  = await serperSearch(s.q);
      const items = (data.organic || []).map(parseSerperItem);
      results.push(...items);
      statuses[s.label] = { ok: true, count: items.length };
    } catch(e) {
      statuses[s.label] = { ok: false, error: e.message };
    }
  }

  res.json({ query, total: results.length, statuses, listings: results });
});

/* ── GET / ────────────────────────────────────────────────── */
app.get('/', (_req, res) => {
  res.send(`
    <html><head><title>PDN Search API</title>
    <style>body{font-family:monospace;background:#060608;color:#f4f4f5;padding:40px;}
    h1{color:#f59e0b;}a{color:#f59e0b;}</style></head>
    <body>
      <h1>🚛 Paso Del Norte — Search API</h1>
      <p>Status: <strong style="color:#22c55e">ONLINE</strong></p>
      <p>Endpoints:</p>
      <ul>
        <li><a href="/health">/health</a> — health check</li>
        <li><a href="/search?q=peterbilt">/search?q=peterbilt</a> — batch search</li>
        <li><a href="/search/stream?q=peterbilt">/search/stream?q=peterbilt</a> — live stream</li>
      </ul>
    </body></html>
  `);
});

/* ── GET /health ──────────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'PDN Search API', ts: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`PDN Search API running on port ${PORT}`));

const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const SERPER_API_KEY  = process.env.SERPER_API_KEY  || '';
const CLAUDE_API_KEY  = process.env.IMAGE_API_KEY   || '';

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

/* ── GET /detail?url= ────────────────────────────────────── */
app.get('/detail', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    // Fetch the listing page
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*'
      },
      timeout: 15000
    });

    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
    const html = await pageRes.text();

    // Extract images — filter for likely truck photos (large images, not icons)
    const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
    const images = imgMatches
      .map(m => {
        const src = m[1];
        if (src.startsWith('//')) return 'https:' + src;
        if (src.startsWith('/')) {
          try { const base = new URL(url); return base.origin + src; } catch(_) { return null; }
        }
        return src;
      })
      .filter(src => src && (src.includes('.jpg') || src.includes('.jpeg') || src.includes('.png') || src.includes('.webp')))
      .filter(src => !src.match(/logo|icon|avatar|banner|badge|pixel|tracking|1x1|spinner/i))
      .slice(0, 10);

    // Strip HTML to plain text for AI (limit size)
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);

    // Claude Haiku — extract structured info
    let aiData = {};
    if (CLAUDE_API_KEY) {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: `Extract from this truck listing page. Return ONLY valid JSON, no explanation:
{
  "dealer_name": "string or null",
  "phone": "phone number string or null",
  "email": "email string or null",
  "price": "$X,XXX or null",
  "year": "YYYY or null",
  "make": "string or null",
  "model": "string or null",
  "mileage": "string or null",
  "condition": "New or Used or null",
  "location": "City, State or null",
  "description": "1-2 sentence summary or null"
}

Page text: ${text}`
          }]
        })
      });

      if (aiRes.ok) {
        const aiJson = await aiRes.json();
        const raw = aiJson.content?.[0]?.text || '{}';
        try { aiData = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch(_) {}
      }
    }

    res.json({ ok: true, images, ...aiData });

  } catch(e) {
    res.json({ ok: false, error: e.message, images: [], dealer_name: null, phone: null, email: null });
  }
});

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

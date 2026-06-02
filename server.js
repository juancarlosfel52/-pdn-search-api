const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ── City map ─────────────────────────────────────────────── */
const CL_CITIES = {
  houston:     'https://houston.craigslist.org',
  dallas:      'https://dallas.craigslist.org',
  sanantonio:  'https://sanantonio.craigslist.org',
  austin:      'https://austin.craigslist.org',
  elpaso:      'https://elpaso.craigslist.org',
  laredo:      'https://laredo.craigslist.org',
};

const DISPLAY_NAMES = {
  houston:'Houston', dallas:'Dallas', sanantonio:'San Antonio',
  austin:'Austin', elpaso:'El Paso', laredo:'Laredo'
};

/* ── Parse Craigslist RSS ─────────────────────────────────── */
function parseRSS(xmlText, cityName) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];

    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`));
      return m ? (m[1] || m[2] || '').trim() : '';
    };

    const title    = get('title');
    const link     = get('link') || (block.match(/<link\s*\/>([^<]+)/)?.[1] || '').trim();
    const desc     = get('description').replace(/<[^>]*>/g, '').trim();
    const pubDate  = get('pubDate');

    const encMatch = block.match(/url="([^"]+\.jpg[^"]*)"/i);
    const image    = encMatch ? encMatch[1] : null;

    const price = title.match(/\$[\d,]+/)?.[0] || null;
    const year  = title.match(/\b(19|20)\d{2}\b/)?.[0] || null;
    const cleanTitle = title.replace(/\s*[-–]\s*\$[\d,]+/, '').trim();

    if (!cleanTitle) continue;

    items.push({
      id:          link + '-' + Date.now() + Math.random(),
      title:       cleanTitle,
      price,
      year,
      mileage:     null,
      location:    cityName + ', TX',
      image,
      url:         link,
      source:      'Craigslist',
      description: desc.slice(0, 300),
      posted:      pubDate,
      seller: {
        name:  'Private Seller / Dealer',
        phone: 'See listing',
        email: 'Via Craigslist'
      },
      sellerTrust: 'new',
      trustNote:   'Craigslist listing — verify seller independently'
    });
  }

  return items;
}

/* ── Fetch one city ───────────────────────────────────────── */
async function fetchCity(key, baseUrl, query) {
  const displayName = DISPLAY_NAMES[key] || key;
  const SCRAPER_KEY = process.env.SCRAPER_API_KEY || '';

  // Try hva (heavy vehicles) first, fall back to sss (all for sale)
  const categories = ['hva', 'sss'];

  for (const cat of categories) {
    const clUrl = `${baseUrl}/search/${cat}?format=rss&query=${encodeURIComponent(query)}`;
    const url = SCRAPER_KEY
      ? `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(clUrl)}`
      : clUrl;

    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*'
        },
        timeout: 20000
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      if (text.trimStart().startsWith('<html') || text.trimStart().startsWith('<!')) {
        throw new Error('Block page');
      }

      const items = parseRSS(text, displayName);
      if (items.length > 0 || cat === 'sss') {
        return { city: displayName, ok: true, count: items.length, items, category: cat };
      }
      // If hva returned 0 results, try sss
    } catch(e) {
      if (cat === 'sss') {
        return { city: displayName, ok: false, error: e.message, items: [], category: cat };
      }
      // Try next category
    }
  }

  return { city: displayName, ok: false, error: 'No results', items: [] };
}

/* ── GET /search/stream (SSE — live city-by-city) ─────────── */
app.get('/search/stream', async (req, res) => {
  const query  = (req.query.q || 'semi truck').trim();
  const cityQ  = (req.query.city || '').toLowerCase().replace(/\s+/g, '');
  const cities = cityQ
    ? Object.entries(CL_CITIES).filter(([k]) => k.includes(cityQ))
    : Object.entries(CL_CITIES);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('start', { total_cities: cities.length, query });

  let totalCount = 0;

  await Promise.allSettled(
    cities.map(async ([key, baseUrl]) => {
      const result = await fetchCity(key, baseUrl, query);
      totalCount += result.items.length;
      send('city', result);
    })
  );

  send('done', { total: totalCount, query });
  res.end();
});

/* ── GET /search (classic batch) ─────────────────────────── */
app.get('/search', async (req, res) => {
  const query  = (req.query.q || 'semi truck').trim();
  const cityQ  = (req.query.city || '').toLowerCase().replace(/\s+/g, '');
  const cities = cityQ
    ? Object.entries(CL_CITIES).filter(([k]) => k.includes(cityQ))
    : Object.entries(CL_CITIES);

  const results  = [];
  const statuses = {};

  await Promise.allSettled(
    cities.map(async ([key, baseUrl]) => {
      const result = await fetchCity(key, baseUrl, query);
      results.push(...result.items);
      statuses[result.city] = { ok: result.ok, count: result.count || 0, error: result.error };
    })
  );

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
        <li><a href="/search?q=peterbilt">/search?q=peterbilt</a> — batch search all TX cities</li>
        <li><a href="/search/stream?q=peterbilt">/search/stream?q=peterbilt</a> — live streaming search (SSE)</li>
        <li>/search?q=kenworth&city=houston — search one city</li>
      </ul>
    </body></html>
  `);
});

/* ── GET /health ──────────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'PDN Search API', ts: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`PDN Search API running on port ${PORT}`);
});

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

    // Image from enclosure or img tag in description
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

/* ── GET /search ──────────────────────────────────────────── */
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
      const cityName = key.charAt(0).toUpperCase() + key.slice(1).replace('sanantonio','San Antonio').replace('elpaso','El Paso');
      const displayName = {
        houston:'Houston', dallas:'Dallas', sanantonio:'San Antonio',
        austin:'Austin', elpaso:'El Paso', laredo:'Laredo'
      }[key] || key;

      const clUrl   = `${baseUrl}/search/ttt?format=rss&query=${encodeURIComponent(query)}`;
      const SCRAPER_KEY = process.env.SCRAPER_API_KEY || '';
      const url = SCRAPER_KEY
        ? `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(clUrl)}`
        : clUrl;
      try {
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*'
          },
          timeout: 15000
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        if (text.trimStart().startsWith('<html') || text.trimStart().startsWith('<!')) {
          throw new Error('Block page');
        }
        const items = parseRSS(text, displayName);
        results.push(...items);
        statuses[displayName] = { ok: true, count: items.length };
      } catch(e) {
        statuses[displayName] = { ok: false, error: e.message };
      }
    })
  );

  res.json({
    query,
    total:    results.length,
    statuses,
    listings: results
  });
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
        <li><a href="/search?q=peterbilt">/search?q=peterbilt</a> — search all TX cities</li>
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

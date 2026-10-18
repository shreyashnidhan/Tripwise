require('dotenv').config();
const express = require('express'), path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22: no native module to compile
const app = express(), PORT = process.env.PORT || 3000;
const db = new DatabaseSync(process.env.DB_PATH || 'tripwise.db');
db.transaction = fn => () => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
db.exec(`CREATE TABLE IF NOT EXISTS itinerary(id INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT NOT NULL,
code TEXT NOT NULL, name TEXT NOT NULL, capital TEXT, region TEXT, flag TEXT,
added_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(client, code))`);
db.exec(`CREATE TABLE IF NOT EXISTS trip(client TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'My Trip', start_date TEXT, num_days INTEGER NOT NULL DEFAULT 3)`);
db.exec(`CREATE TABLE IF NOT EXISTS stops(id INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, day_number INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, notes TEXT DEFAULT '', budget REAL DEFAULT 0)`);
for (const col of ['day_number INTEGER NOT NULL DEFAULT 1', 'sort_order INTEGER NOT NULL DEFAULT 0', "notes TEXT DEFAULT ''", 'budget REAL DEFAULT 0'])
  try { db.exec('ALTER TABLE itinerary ADD COLUMN ' + col); } catch {}
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const cache = new Map();
async function getJson(url, opts = {}, ttl = 36e5) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), ...opts, headers: { 'User-Agent': 'TripWise/1.0 (student project; +http://localhost)', ...opts.headers } })
    .catch(e => { console.error('Fetch failed:', url, (e.cause && e.cause.code) || e.message); throw Object.assign(new Error('Network error'), { status: 502 }); });
  if (!r.ok) throw Object.assign(new Error('Upstream API error ' + r.status), { status: 502 });
  const v = await r.json();
  cache.set(url, { t: Date.now(), v });
  return v;
}
// Destination API: REST Countries
const FIELDS = 'name,cca3,capital,region,subregion,population,area,flags,latlng,languages';
const REG = { 'North America': 'Americas', 'South America': 'Americas', Australia: 'Oceania', Zealandia: 'Oceania', Eurasia: 'Europe' };
const SPARQL = `SELECT ?code ?cLabel ?capLabel ?contLabel ?pop ?area ?coord ?flag WHERE {
 ?c wdt:P31 wd:Q3624078; wdt:P298 ?code.
 OPTIONAL{?c wdt:P36 ?cap} OPTIONAL{?c wdt:P30 ?cont} OPTIONAL{?c wdt:P1082 ?pop} OPTIONAL{?c wdt:P2046 ?area} OPTIONAL{?c wdt:P625 ?coord} OPTIONAL{?c wdt:P41 ?flag}
 SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
// Destination API: Wikidata SPARQL (keyless). REST Countries v1-v4 are deprecated and v5 needs an API key.
async function fromWikidata() {
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(SPARQL);
  const j = await getJson(url, { signal: AbortSignal.timeout(30000), headers: { Accept: 'application/sparql-results+json' } }, 864e5);
  const rows = j && j.results && j.results.bindings;
  if (!Array.isArray(rows) || !rows.length) { cache.delete(url); throw new Error('Unexpected response'); }
  const out = new Map(), val = (r, k) => (r[k] && !/^Q\d+$/.test(r[k].value) ? r[k].value : '');
  for (const r of rows) {
    const code = r.code && r.code.value, name = val(r, 'cLabel');
    if (!/^[A-Z]{3}$/.test(code || '') || !name) continue;
    const pop = r.pop ? Math.round(+r.pop.value) : 0, prev = out.get(code);
    if (prev && pop <= prev.population) continue;
    const cont = val(r, 'contLabel'), region = REG[cont] || cont || 'Other';
    const m = r.coord && /Point\(([-\d.eE+]+) ([-\d.eE+]+)\)/.exec(r.coord.value);
    out.set(code, { code, name, capital: val(r, 'capLabel') || 'N/A', region, subregion: cont && cont !== region ? cont : '', population: pop,
      area: r.area ? Math.round(+r.area.value) : 0, flag: r.flag ? r.flag.value.replace('http://', 'https://') : '', latlng: m ? [+m[2], +m[1]] : null, languages: [] });
  }
  return [...out.values()];
}
let downUntil = 0;
const fallback = () => require('fs').readFileSync(path.join(__dirname, 'data', 'fallback.csv'), 'utf8').trim().split('\n').map(l => {
  const [code, iso, name, capital, region, subregion, pop, area, lat, lng] = l.trim().split(',');
  return { code, name, capital, region, subregion, population: +pop, area: +area, flag: 'https://flagcdn.com/' + iso.toLowerCase() + '.svg', latlng: [+lat, +lng], languages: [] };
});
const allDestinations = async () => {
  if (Date.now() > downUntil) try { return await fromWikidata(); }
  catch (e) { console.error('Wikidata unavailable (' + e.message + '). Using bundled fallback for 60s.'); downUntil = Date.now() + 6e4; }
  return fallback();
};
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const client = (req, res) => { const id = req.get('x-client-id'); if (!/^[\w-]{8,64}$/.test(id || '')) { res.status(400).json({ error: 'Missing or invalid x-client-id header' }); return null; } return id; };

app.get('/api/destinations', wrap(async (req, res) => {
  const { q = '', region = '', size = '', sort = 'name', order = 'asc' } = req.query;
  if (!['', 'small', 'medium', 'large'].includes(size)) return res.status(400).json({ error: 'size must be small|medium|large' });
  if (!['name', 'population', 'area'].includes(sort) || !['asc', 'desc'].includes(order)) return res.status(400).json({ error: 'sort must be name|population|area, order asc|desc' });
  let list = await allDestinations();
  const regions = [...new Set(list.map(d => d.region))].sort();
  const needle = String(q).trim().toLowerCase();
  if (needle) list = list.filter(d => (d.name + ' ' + d.capital).toLowerCase().includes(needle));
  if (region) list = list.filter(d => d.region === region);
  if (size) list = list.filter(d => size === 'small' ? d.population < 1e7 : size === 'medium' ? d.population >= 1e7 && d.population < 1e8 : d.population >= 1e8);
  const dir = order === 'desc' ? -1 : 1;
  list.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : a[sort] - b[sort]) * dir);
  res.json({ total: list.length, regions, results: list });
}));

// Photography API: Unsplash (if key set), falls back to Wikipedia lead images
app.get('/api/photo', wrap(async (req, res) => {
  const q = String(req.query.q || '').slice(0, 80);
  if (!q) return res.status(400).json({ error: 'q is required' });
  let out = null; const key = process.env.UNSPLASH_ACCESS_KEY;
  if (key) try {
    const j = await getJson('https://api.unsplash.com/search/photos?per_page=1&orientation=landscape&query=' + encodeURIComponent(q + ' travel'), { headers: { Authorization: 'Client-ID ' + key } });
    const p = j.results[0]; if (p) out = { url: p.urls.regular, credit: p.user.name + ' / Unsplash', link: p.links.html + '?utm_source=tripwise&utm_medium=referral' };
  } catch {}
  const alt = String(req.query.alt || '').slice(0, 80);
  for (const t of ['Tourism in ' + q, alt, q]) {
    if (out || !t) continue;
    try {
      const j = await getJson('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(t.replace(/ /g, '_')));
      const u = j.thumbnail && j.thumbnail.source;
      if (u && !/flag|coat_of_arms|map|seal|emblem|logo/i.test(u)) {
        // Wikimedia only serves fixed thumbnail widths (e.g. 960); arbitrary widths return an error.
        // Use 960px when the original is bigger, otherwise the original file itself.
        const o = j.originalimage, big = o && o.width > 960 && /\/\d+px-/.test(u);
        out = { url: big ? u.replace(/\/\d+px-/, '/960px-') : (o && o.source) || u, backup: [u, o && o.source].filter(Boolean),
          credit: 'Wikipedia', link: j.content_urls && j.content_urls.desktop.page };
      }
    } catch {}
  }
  res.json(out || { url: null });
}));

app.get('/api/destinations/:code', wrap(async (req, res) => {
  if (!/^[A-Za-z]{3}$/.test(req.params.code)) return res.status(400).json({ error: 'Code must be 3 letters (ISO alpha-3)' });
  const d = (await allDestinations()).find(x => x.code === req.params.code.toUpperCase());
  if (!d) return res.status(404).json({ error: 'Destination not found' });
  const [wiki, wx] = await Promise.all([
    getJson('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(d.name.replace(/ /g, '_'))).catch(() => null),
    d.latlng ? getJson(`https://api.open-meteo.com/v1/forecast?latitude=${d.latlng[0]}&longitude=${d.latlng[1]}&current=temperature_2m,wind_speed_10m`, {}, 6e5).catch(() => null) : null]);
  res.json({ ...d, description: wiki && wiki.extract, weather: wx && wx.current });
}));

app.get('/api/itinerary', (req, res) => {
  const c = client(req, res); if (!c) return;
  res.json(getItems(c));
});
app.post('/api/itinerary', wrap(async (req, res) => {
  const c = client(req, res); if (!c) return;
  const code = String((req.body || {}).code || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return res.status(400).json({ error: 'A valid 3-letter destination code is required' });
  const d = (await allDestinations()).find(x => x.code === code);
  if (!d) return res.status(404).json({ error: 'Destination not found' });
  try {
    const r = db.prepare('INSERT INTO itinerary(client,code,name,capital,region,flag,sort_order) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM itinerary WHERE client=? AND day_number=1))').run(c, d.code, d.name, d.capital, d.region, d.flag, c);
    res.status(201).json(db.prepare('SELECT * FROM itinerary WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: d.name + ' is already in your trip' }); throw e; }
}));
app.delete('/api/itinerary/:code', (req, res) => {
  const c = client(req, res); if (!c) return;
  db.prepare('DELETE FROM stops WHERE client=? AND code=?').run(c, req.params.code.toUpperCase());
  const r = db.prepare('DELETE FROM itinerary WHERE client=? AND code=?').run(c, req.params.code.toUpperCase());
  r.changes ? res.status(204).end() : res.status(404).json({ error: 'Item not in your trip' });
});
const getTrip = c => { db.prepare('INSERT OR IGNORE INTO trip(client) VALUES(?)').run(c); return db.prepare('SELECT name,start_date,num_days FROM trip WHERE client=?').get(c); };
const getItems = c => db.prepare('SELECT * FROM itinerary WHERE client=? ORDER BY day_number,sort_order,id').all(c);
const getStops = c => db.prepare('SELECT * FROM stops WHERE client=? ORDER BY day_number,sort_order,id').all(c);
const bundle = c => ({ trip: getTrip(c), items: getItems(c), stops: getStops(c) });
const findItem = (c, code) => db.prepare('SELECT * FROM itinerary WHERE client=? AND code=?').get(c, String(code).toUpperCase());

app.get('/api/trip', (req, res) => { const c = client(req, res); if (c) res.json(bundle(c)); });
app.patch('/api/trip', (req, res) => {
  const c = client(req, res); if (!c) return;
  const t = getTrip(c), b = req.body || {};
  const name = b.name === undefined ? t.name : String(b.name).trim();
  const start = b.start_date === undefined ? t.start_date : b.start_date;
  const days = b.num_days === undefined ? t.num_days : Number(b.num_days);
  if (!name || name.length > 60) return res.status(400).json({ error: 'Trip name must be 1-60 characters' });
  if (!Number.isInteger(days) || days < 1 || days > 14) return res.status(400).json({ error: 'Days must be a whole number from 1 to 14' });
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(400).json({ error: 'Start date must be YYYY-MM-DD' });
  db.prepare('UPDATE trip SET name=?,start_date=?,num_days=? WHERE client=?').run(name, start || null, days, c);
  db.prepare('UPDATE itinerary SET day_number=? WHERE client=? AND day_number>?').run(days, c, days);
  db.prepare('UPDATE stops SET day_number=? WHERE client=? AND day_number>?').run(days, c, days);
  res.json(bundle(c));
});
app.patch('/api/itinerary/:code', (req, res) => {
  const c = client(req, res); if (!c) return;
  const it = findItem(c, req.params.code); if (!it) return res.status(404).json({ error: 'Item not in your trip' });
  const b = req.body || {}, t = getTrip(c);
  const day = b.day_number === undefined ? it.day_number : Number(b.day_number);
  const notes = b.notes === undefined ? it.notes : String(b.notes).slice(0, 200);
  const budget = b.budget === undefined ? it.budget : Number(b.budget);
  if (!Number.isInteger(day) || day < 1 || day > t.num_days) return res.status(400).json({ error: 'Day must be between 1 and ' + t.num_days });
  if (!Number.isFinite(budget) || budget < 0 || budget > 1e7) return res.status(400).json({ error: 'Budget must be a number between 0 and 10,000,000' });
  const so = day === it.day_number ? it.sort_order : db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM itinerary WHERE client=? AND day_number=?').get(c, day).n;
  db.prepare('UPDATE itinerary SET day_number=?,sort_order=?,notes=?,budget=? WHERE id=?').run(day, so, notes, budget, it.id);
  res.json(bundle(c));
});
app.post('/api/itinerary/:code/move', (req, res) => {
  const c = client(req, res); if (!c) return;
  const dir = (req.body || {}).direction;
  if (!['up', 'down'].includes(dir)) return res.status(400).json({ error: 'direction must be "up" or "down"' });
  const it = findItem(c, req.params.code); if (!it) return res.status(404).json({ error: 'Item not in your trip' });
  const ids = db.prepare('SELECT id FROM itinerary WHERE client=? AND day_number=? ORDER BY sort_order,id').all(c, it.day_number).map(r => r.id);
  const i = ids.indexOf(it.id), j = dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < ids.length) {
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const u = db.prepare('UPDATE itinerary SET sort_order=? WHERE id=?');
    db.transaction(() => ids.forEach((id, k) => u.run(k, id)))();
  }
  res.json(bundle(c));
});
// States / provinces of a country (Wikidata P150), used to plan places per day
app.get('/api/destinations/:code/regions', wrap(async (req, res) => {
  if (!/^[A-Za-z]{3}$/.test(req.params.code)) return res.status(400).json({ error: 'Code must be 3 letters (ISO alpha-3)' });
  const q = `SELECT DISTINCT ?rLabel WHERE { ?c wdt:P298 "${req.params.code.toUpperCase()}"; wdt:P150 ?r. SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`;
  const j = await getJson('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/sparql-results+json' } }, 864e5);
  const rows = (j.results && j.results.bindings) || [];
  res.json({ regions: [...new Set(rows.map(r => r.rLabel && r.rLabel.value).filter(n => n && !/^Q\d+$/.test(n)))].sort((a, b) => a.localeCompare(b)) });
}));
const stopErr = (day, budget, t) => !Number.isInteger(day) || day < 1 || day > t.num_days ? 'Day must be between 1 and ' + t.num_days : !Number.isFinite(budget) || budget < 0 || budget > 1e7 ? 'Budget must be a number between 0 and 10,000,000' : null;
app.post('/api/stops', (req, res) => {
  const c = client(req, res); if (!c) return;
  const b = req.body || {}, code = String(b.code || '').toUpperCase(), name = String(b.name || '').trim(), t = getTrip(c), day = Number(b.day_number || 1);
  if (!findItem(c, code)) return res.status(404).json({ error: 'Add the country to your trip first' });
  if (!name || name.length > 60) return res.status(400).json({ error: 'Place name must be 1-60 characters' });
  const err = stopErr(day, 0, t); if (err) return res.status(400).json({ error: err });
  db.prepare('INSERT INTO stops(client,code,name,day_number,sort_order) VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM stops WHERE client=? AND code=? AND day_number=?))').run(c, code, name, day, c, code, day);
  res.status(201).json(bundle(c));
});
app.patch('/api/stops/:id', (req, res) => {
  const c = client(req, res); if (!c) return;
  const s = db.prepare('SELECT * FROM stops WHERE client=? AND id=?').get(c, +req.params.id); if (!s) return res.status(404).json({ error: 'Place not found' });
  const b = req.body || {}, t = getTrip(c);
  const day = b.day_number === undefined ? s.day_number : Number(b.day_number), budget = b.budget === undefined ? s.budget : Number(b.budget);
  const notes = b.notes === undefined ? s.notes : String(b.notes).slice(0, 200), err = stopErr(day, budget, t); if (err) return res.status(400).json({ error: err });
  const so = day === s.day_number ? s.sort_order : db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM stops WHERE client=? AND code=? AND day_number=?').get(c, s.code, day).n;
  db.prepare('UPDATE stops SET day_number=?,sort_order=?,notes=?,budget=? WHERE id=?').run(day, so, notes, budget, s.id);
  res.json(bundle(c));
});
app.delete('/api/stops/:id', (req, res) => {
  const c = client(req, res); if (!c) return;
  const r = db.prepare('DELETE FROM stops WHERE client=? AND id=?').run(c, +req.params.id);
  r.changes ? res.json(bundle(c)) : res.status(404).json({ error: 'Place not found' });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
app.use((err, req, res, next) => { console.error(err.message); res.status(err.status || 500).json({ error: err.status === 502 ? 'External data source is unavailable. Try again shortly.' : 'Server error' }); });
app.listen(PORT, () => console.log('TripWise on http://localhost:' + PORT));

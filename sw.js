// Service worker for the published site (publish.sh copies it to the site root as sw.js and stamps DATA_VERSION).
// Goal: a second visit starts from the phone itself, and after one full visit the diorama keeps working offline (train).
//   data (renders-centrum/, viewer3d/water/, viewer3d/lights/, versioned CDN files): cache-first; a new DATA_VERSION
//     (= different renders) gives a new cache and the old one is deleted.
//   everything else (html, js, json, fonts css, card images, weather): network-first, cache as fallback; after 4 s
//     without an answer the cached copy is used so a weak train connection does not hang the page.
const DATA_VERSION = 'd3a015035130';
const DATA = `klei-data-${DATA_VERSION}`, APP = 'klei-app';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== DATA && k !== APP) await caches.delete(k);
  await self.clients.claim();
})()));

const isData = (u) => /\/renders-centrum(-v3)?\/|\/viewer3d\/water\/|\/viewer3d\/lights\//.test(u.pathname)
  || u.hostname === 'cdn.jsdelivr.net' || u.hostname === 'fonts.gstatic.com';   // CDN urls carry an exact version

async function dataFirst(req) {
  const c = await caches.open(DATA);
  const hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === 'opaque') c.put(req, r.clone()).catch(() => {});   // quota full: just serve it
  return r;
}

async function networkFirst(req, nav) {
  const c = await caches.open(APP);
  const net = fetch(req).then((r) => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()).catch(() => {}); return r; });
  const cached = () => c.match(req, { ignoreSearch: nav, ignoreVary: true });
  const slow = new Promise((res) => setTimeout(res, 4000));
  try {
    const r = await Promise.race([net, slow.then(async () => (await cached()) || net)]);
    return r;
  } catch (e) {
    return (await cached()) || Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const u = new URL(req.url);
  if (!/^https?:$/.test(u.protocol)) return;
  e.respondWith(isData(u) ? dataFirst(req) : networkFirst(req, req.mode === 'navigate'));
});

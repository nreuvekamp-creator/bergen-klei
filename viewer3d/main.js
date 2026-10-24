import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { decode as decodePng } from 'fast-png';

// Camera projection (DuneCrawl-style): the Blender passes are projected from the render camera onto a low-poly
// proxy (scene.glb), so panning/zooming/turning a little gives real parallax. See research-projectie/PROJECTIE.md.
//
// WATER HOOK (full contract: WATER-CONTRACT.md). If ./water.js exists it is imported and
//   const w = await createWater(ctx)  ->  { mesh?, update(dt, state) -> true to keep rendering at full rate, dispose() }
// replaces the built-in water (the glb water meshes are hidden when w.mesh is given, unless w.keepOriginal).
// Any import/create/update error falls back to the built-in water. ?water=0 skips the hook.
// LIGHTS HOOK: ./lights.js createLights(ctx) -> { group, update(dt, state), dispose }, same ctx/state; fails = no lights. ?lights=0 skips it.
//   ctx:   THREE, renderer, scene, camera, root (glb scene), waterMeshes, uniforms (U: projected passes + light),
//          projector (render camera), depthTexture (+ near/far in uniforms.uNF), box, tableZ, tile, target0,
//          metresPerTexel, small, FPS, shader: { COMMON, TONE }
//   state: time (s), dt (s), tick (8 fps stop-motion counter), clock (Bergen hours 0-24 as shown),
//          sunDir (world, toward the key light: sun or moon), sunElevation (deg), day (0 night .. 1 day),
//          keyColor, fillColor, ambient (linear RGB Vector3), fillDir, rain (0..1, eased), camera, zoom
//   World: Blender metres, Z up, x east, y north.
const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const coarse = matchMedia('(pointer: coarse)').matches;
const small = coarse || Math.min(innerWidth, innerHeight) < 700;
const FPS = 8;                                          // stop-motion rate for light, boil, grain, rain, clouds (camera stays smooth)
const DPR = Math.min(devicePixelRatio || 1, +(Q.get('dpr') || 1.5));
let SET = Q.get('set') || 'lo';                          // lo + deep-zoom tiles cover every zoom level (hi would duplicate tile level 1)
const DRACO = 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/draco/gltf/';
const deg = Math.PI / 180;

// ---------- loading: what the first picture needs (~9 MB) with a progress bar; deep-zoom tiles stream in later ----------
// Hook for an intro (intro.js): window.kleiLoad = { progress 0..1, ready bool }; events 'klei:progress' (detail = 0..1)
// and 'klei:ready' (first frame drawn, loading screen fades) on window. Loading starts as soon as main.js runs.
window.kleiLoad = { progress: 0, ready: false, offline: false };
// offline + fast second visit: the published site has a service worker (../sw.js, see publish.sh) that keeps every file.
// Not on localhost (renders change there; ?sw=1 forces it). After the first picture, the rest (all deep-zoom tiles, ~26 MB)
// is fetched in the background through it, so the whole diorama then works without network; kleiLoad.offline = true when done.
const SW = 'serviceWorker' in navigator && (Q.has('sw') || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) ? navigator.serviceWorker : null;
SW?.register('../sw.js').catch((e) => console.info('geen service worker:', e.message));
addEventListener('klei:ready', () => setTimeout(async () => {
  if (!SW || navigator.connection?.saveData) return;
  if (!SW.controller) await new Promise((res) => { SW.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 15000); });
  if (!SW.controller) return;
  const zOf = (k) => +k.split('/')[1];
  const tilesByZ = [...data.tiles.urls].sort((a, b) => zOf(a[0]) - zOf(b[0])).map((e) => e[1]);
  const seen = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /^https?:/.test(u) && !/api\.met\.no/.test(u) && !otherMap().test(u));   // not the other render's meta.json
  const list = [...new Set([location.href, new URL('../', location.href).href, ...seen, ...tilesByZ])];
  let i = 0, ok = 0;
  const worker = async () => { while (i < list.length) await fetch(list[i++]).then((r) => r.arrayBuffer()).then(() => ok++, () => {}); };
  await Promise.all([worker(), worker()]);   // two at a time: what the screen needs still gets most of the bandwidth
  window.kleiLoad.offline = ok === list.length;
  dispatchEvent(new CustomEvent('klei:offline', { detail: { ok, total: list.length } }));
}, 2000), { once: true });
const prog = { got: new Map(), tot: new Map() };
function bar() {
  let g = 0, t = 0;
  for (const [k, v] of prog.tot) { t += v; g += Math.min(v, prog.got.get(k) || 0); }
  const f = t ? g / t : 0;
  window.kleiLoad.progress = f; dispatchEvent(new CustomEvent('klei:progress', { detail: f }));
  $('load-bar').style.transform = `scaleX(${f})`;
  $('load-pct').textContent = `${Math.round(f * 100)}%`;
  $('load').setAttribute('aria-valuenow', Math.round(f * 100));
}
async function getBlob(url, est = 4e5) {   // fetch with byte progress
  prog.tot.set(url, est); prog.got.set(url, 0);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  const n = r.headers.get('content-encoding') ? 0 : +r.headers.get('content-length');   // gzip (Pages: glb, json): length is compressed, body is not
  if (n) { prog.tot.set(url, n); bar(); }
  let b;
  if (r.body?.getReader) {
    const rd = r.body.getReader(), parts = [];
    let got = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; prog.got.set(url, got); bar(); }
    b = new Blob(parts, { type: r.headers.get('content-type') || '' });
  } else b = await r.blob();
  prog.tot.set(url, b.size); prog.got.set(url, b.size); bar();
  return b;
}
const loader = new THREE.TextureLoader();
const tex = (blob, color) => {
  const u = URL.createObjectURL(blob);
  return loader.loadAsync(u).then((t) => {
    URL.revokeObjectURL(u);
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
    return t;
  });
};
const optional = (p) => p.catch(() => null);
// 16-bit PNG lightmaps are decoded in JS (the browser would squash them to 8 bit)
async function png(blob) {
  const p = decodePng(new Uint8Array(await blob.arrayBuffer()));
  return { w: p.width, h: p.height, ch: p.channels ?? p.data.length / (p.width * p.height), max: 2 ** p.depth - 1, data: p.data };
}
function floatTex(p, chans) {   // rows flipped so uv (0,0) is bottom-left like TextureLoader
  const out = new Uint16Array(p.w * p.h * chans), toHalf = THREE.DataUtils.toHalfFloat;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const i = (y * p.w + x) * p.ch, o = ((p.h - 1 - y) * p.w + x) * chans;
    for (let c = 0; c < chans; c++) out[o + c] = toHalf(c < p.ch ? p.data[i + c] / p.max : 1);
  }
  const t = new THREE.DataTexture(out, p.w, p.h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
// which deep-zoom tiles exist: complete_levels have all, partial_levels list "x_y"; without that info every tile is assumed present
const tileAvail = (TL, z, x, y) => !TL.complete_levels && !TL.partial_levels
  || (TL.complete_levels || []).includes(z) || !!TL.partial_levels?.[z]?.includes(`${x}_${y}`);

// Data layout (renders-centrum and testdata): meta.json, scene.glb, ground_top, lo/ (and hi/) with albedo, lightmap, windows, tiles/.
// File names come from meta.passes when it lists them, so only existing files are requested (no 404s).
async function loadSet(base, meta0) {
  prog.got.clear(); prog.tot.clear();
  const meta = meta0 || await fetch(`${base}/meta.json`, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`${base}/meta.json ${r.status}`);
    return r.json();
  });
  const names = Object.keys(meta.passes || {});
  const file = (n, ext = '.png') => names.find((k) => k.startsWith(n + '.')) || n + ext;
  const has = (n) => !meta.passes || names.some((k) => k.startsWith(n + '.'));
  const lmDesc = meta.passes?.[file('lightmap')] || '';
  const dir = `${base}/${SET}`;
  // tiles: only the list of what exists now; each is fetched when the screen first needs it (data.tiles.get -> Promise<Blob>)
  const TL = meta.tiles || (Q.has('tiles') ? meta.tiles_test : null);
  const urls = new Map(), blobs = new Map();
  if (TL) {
    const passList = (Array.isArray(TL.passes) ? TL.passes : Object.keys(TL.passes || { albedo: 1, lightmap: 1 })).filter((p) => p === 'albedo' || p === 'lightmap');
    const tpl = (pass) => ((TL.passes && !Array.isArray(TL.passes) && typeof TL.passes[pass] === 'string') ? TL.passes[pass]
      : TL.template || TL.path || TL.url || 'tiles/{pass}/{z}/{x}_{y}.png').split(' ')[0];
    const lv = TL.max_z ?? TL.z_max ?? TL.levels ?? 0;
    const maxZ = Array.isArray(lv) ? Math.max(...lv.map((l) => +(l.z ?? l))) : +lv;
    for (const pass of passList) for (let z = 1; z <= maxZ; z++) for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++) {
      if (tileAvail(TL, z, x, y)) urls.set(`${pass}/${z}/${x}_${y}`, `${base}/${tpl(pass).replace('{pass}', pass).replace('{z}', z).replace('{x}', x).replace('{y}', y)}`);
    }
  }
  const tiles = { has: (k) => urls.has(k), get size() { return urls.size; }, urls,
    get(k) {   // memoised; a network error is forgotten so the tile is tried again later (train: flaky network)
      if (!blobs.has(k)) blobs.set(k, fetch(urls.get(k)).then((r) => r.ok ? r.blob() : Promise.reject(new Error(r.status))).catch((e) => { blobs.delete(k); throw e; }));
      return blobs.get(k);
    } };
  // phones/tablets: ground_top (fallback colour where the render saw nothing) at half size, 56 -> 19 MB of GPU memory
  const groundTex = (b) => (small ? createImageBitmap(b, { resizeWidth: 2048, resizeQuality: 'high' }).then((bm) => {
    const t = new THREE.Texture(bm); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4; t.needsUpdate = true; return t;
  }) : Promise.reject()).catch(() => tex(b, true));
  const gltfLoader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath(DRACO));
  const [alb, lm, win, ground, gltf] = await Promise.all([
    getBlob(`${dir}/${file('albedo')}`, 2e6).then((b) => tex(b, true)),
    getBlob(`${dir}/${file('lightmap')}`, 2e6).then((b) => /16-bit/i.test(lmDesc) ? png(b).then((p) => floatTex(p, 4)) : tex(b, /srgb/i.test(lmDesc))),
    has('windows') ? optional(getBlob(`${dir}/${file('windows')}`, 3e5).then((b) => tex(b)).then((t) => { t.format = THREE.RedFormat; return t; })) : null,   // mask: 1 channel, 19 -> 5 MB GPU
    has('ground_top') ? optional(getBlob(`${base}/${file('ground_top')}`, 1.1e6).then(groundTex)) : null,
    getBlob(`${base}/${file('scene', '.glb')}`, 3.7e6).then(async (b) => {
      const u = URL.createObjectURL(b);
      try { return await gltfLoader.loadAsync(u); } finally { URL.revokeObjectURL(u); }
    }),
  ]);
  if (ground) ground.flipY = false;   // glTF uv (top-left origin)
  return { base, meta, alb, lm, win, ground, gltf, tiles };
}

// ---------- which render: v3 ('nieuw') is the default as soon as its data set is complete (meta.json lists deep-zoom tiles
// and the last tile exists); until then, or when it fails to load, v2 ('klassiek'). The menu choice is remembered.
const MAPS = { v3: '../renders-centrum-v3', v2: '../renders-centrum' }, MAP_KEY = 'bergen-klei-kaart';
let mapPick = null;
try { mapPick = localStorage.getItem(MAP_KEY); } catch {}
const v3meta = Q.has('data') ? null : await fetch(`${MAPS.v3}/meta.json`, { cache: 'no-cache' }).then((r) => r.ok ? r.json() : null).catch(() => null);
const v3ok = await (async (TL) => {
  if (!TL) return false;
  const lv = TL.complete_levels?.length ? Math.max(...TL.complete_levels) : +(TL.max_z ?? TL.z_max ?? (Array.isArray(TL.levels) ? Math.max(...TL.levels) : TL.levels) ?? 1);
  const n = 2 ** lv - 1, ext = /\.webp/.test((TL.template || TL.path || '').split(' ')[0]) ? 'webp' : 'png';
  return fetch(`${MAPS.v3}/tiles/albedo/${lv}/${n}_${n}.${ext}`, { method: 'HEAD' }).then((r) => r.ok, () => false);
})(v3meta?.tiles);
let mapVer = v3ok && mapPick !== 'v2' ? 'v3' : 'v2';
let data;
try { data = await loadSet(Q.get('data') || MAPS[mapVer], mapVer === 'v3' && !Q.has('data') ? v3meta : undefined); } catch (e) {
  try {
    if (Q.has('data') || mapVer === 'v2') throw e;
    console.info('v3 laadt niet, val terug op v2:', e.message);
    mapVer = 'v2'; data = await loadSet(MAPS.v2);
  } catch (e2) {
    console.info('val terug op de Bryggen-testset:', e2.message);
    data = await loadSet('testdata');
  }
}
const otherMap = () => (mapVer === 'v3' ? /\/renders-centrum\// : /\/renders-centrum-v3\//);
if (!Q.has('data') && 'caches' in window) {   // offline cache (sw.js): keep only the render that is shown (iPad storage)
  const other = otherMap();
  caches.keys().then((ks) => ks.filter((k) => k.startsWith('klei-data-')).forEach(async (k) => {
    const c = await caches.open(k);
    for (const r of await c.keys()) if (other.test(r.url)) c.delete(r);
  })).catch(() => {});
}
const isTest = data.base === 'testdata';
$('badge').hidden = !isTest;
const { meta } = data;
let IW = data.alb.image.width, IH = data.alb.image.height;

// ---------- GL ----------
const canvas = $('c');
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }); }
catch (e) { $('err').hidden = false; $('err').textContent = 'WebGL is niet beschikbaar op dit apparaat.'; throw e; }
renderer.setPixelRatio(DPR);
const css = getComputedStyle(document.documentElement);
const cssColor = (v) => new THREE.Color(css.getPropertyValue(v).trim());
const paper = cssColor('--paper');
renderer.setClearColor(new THREE.Color().setRGB(...paper.convertLinearToSRGB().toArray(), THREE.LinearSRGBColorSpace), 0);   // alpha 0: no bloom

// ---------- projector = the Blender render camera (Blender world, Z up) ----------
const M4 = (rows) => new THREE.Matrix4().set(...rows.flat());
const cam0 = meta.camera;
const P0 = M4(cam0.projection);
const tanX = 1 / P0.elements[0], tanY = 1 / P0.elements[5];
const projCam = new THREE.PerspectiveCamera();
M4(cam0.matrix_world).decompose(projCam.position, projCam.quaternion, projCam.scale);
projCam.updateMatrixWorld(true);

const world = new THREE.Scene();
const root = data.gltf.scene;
{ // scene.glb from Blender is Z-up when exported with export_yup=False; a default (Y-up) export is turned back
  const sz = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  if (sz.y < sz.z) root.rotation.x = Math.PI / 2;
}
world.add(root);
root.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(root);
const tableZ = meta.world?.tile?.table_z ?? box.min.z;
// pivot = where the optical axis of the render camera meets the model (meta.camera.target when given)
const target0 = cam0.target ? new THREE.Vector3(...cam0.target) : (() => {
  const rc = new THREE.Raycaster(projCam.position.clone(), new THREE.Vector3(0, 0, -1).applyQuaternion(projCam.quaternion));
  return rc.intersectObject(root, true)[0]?.point || rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
})();
const dist0 = target0.distanceTo(projCam.position);
const mppD = 2 * dist0 * tanX / 4096;   // metres per depth texel at the pivot (scales bias, rain rings)
const table = new THREE.Mesh(new THREE.PlaneGeometry(dist0 * 4, dist0 * 4).translate(target0.x, target0.y, 0), null);
table.position.z = tableZ - 0.05; table.name = 'tafel';
world.add(table);

// near/far tight around the model: better depth precision for the visibility test
let dn = Infinity, df = 0;
for (let i = 0; i < 8; i++) {
  const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
  const d = -c.applyMatrix4(projCam.matrixWorldInverse).z; dn = Math.min(dn, d); df = Math.max(df, d);
}
dn = Math.max(1, dn * 0.8); df *= 1.6;
{ const e = P0.clone().elements; e[10] = -(df + dn) / (df - dn); e[14] = -2 * df * dn / (df - dn);
  projCam.projectionMatrix.fromArray(e); projCam.projectionMatrixInverse.copy(projCam.projectionMatrix).invert(); }
const projMat = new THREE.Matrix4().multiplyMatrices(projCam.projectionMatrix, projCam.matrixWorldInverse);
const toProjUv = (p) => { const v = p.clone().applyMatrix4(projMat); return [v.x * .5 + .5, v.y * .5 + .5, v.z]; };
function projRay(u, v, z) {   // ground point at height z seen by the render camera at image uv (u, v)
  const d = new THREE.Vector3(u * 2 - 1, v * 2 - 1, .5).unproject(projCam).sub(projCam.position);
  return projCam.position.clone().addScaledVector(d, (z - projCam.position.z) / d.z);
}

// depth from the render camera (shadow-map style): fragments behind something else get plain clay, not its facade
const DW = Math.min(renderer.capabilities.maxTextureSize, small ? 2048 : 4096),   // tablets/phones: 2048 (9 MB instead of 36 MB; screenshots: no new facade stains)
      DH = Math.round(DW * IH / IW);
const depthRT = new THREE.WebGLRenderTarget(DW, DH, { depthTexture: new THREE.DepthTexture(DW, DH) });

// ---------- lighting basis: lightmap R/G/B = sun from meta.light_dirs (world) ----------
const vec = (a) => new THREE.Vector3(...a);
const LD = ['R', 'G', 'B'].map((c) => vec(meta.light_dirs[c].world).normalize());
const lmInv = new THREE.Matrix3().set(LD[0].x, LD[1].x, LD[2].x, LD[0].y, LD[1].y, LD[2].y, LD[0].z, LD[1].z, LD[2].z).invert();
const lmWeights = (s) => { const w = s.clone().applyMatrix3(lmInv); return w.set(Math.max(w.x, 0), Math.max(w.y, 0), Math.max(w.z, 0)); };
// compass bearing / elevation (degrees) -> world direction toward the light (x east, y north, z up)
const dirOf = (az, el) => new THREE.Vector3(Math.sin(az * deg) * Math.cos(el * deg), Math.cos(az * deg) * Math.cos(el * deg), Math.sin(el * deg));

// ---------- shaders ----------
const COMMON = `
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }`;
const TONE = `
vec3 tone(vec3 c){
  c = 1. - exp(-c * uExpo);                         // soft shoulder: no hard white highlights
  c = pow(c, vec3(1. / 2.2));
  c = mix(c, c * c * (3. - 2. * c), uContrast);     // a little S-curve for depth
  return clamp(mix(vec3(dot(c, vec3(.2126, .7152, .0722))), c, uSat), 0., 1.);
}`;
const U = {
  tAlb: { value: data.alb }, tLm: { value: data.lm }, tWin: { value: data.win }, tGround: { value: data.ground },
  tDepth: { value: depthRT.depthTexture }, uHasWin: { value: !!data.win }, uHasGround: { value: !!data.ground },
  uProj: { value: projMat }, uProjV: { value: projCam.matrixWorldInverse }, uProjPos: { value: projCam.position },
  uNF: { value: new THREE.Vector2(dn, df) }, uImg: { value: new THREE.Vector2(IW, IH) }, uBias: { value: 7.5 * mppD * 4096 / DW }, uCell: { value: Math.max(12, 55 * mppD) },
  uKeyW: { value: new THREE.Vector3() }, uFillW: { value: new THREE.Vector3() },
  uKeyDir: { value: new THREE.Vector3() }, uFillDir: { value: new THREE.Vector3() },
  uKeyCol: { value: new THREE.Vector3() }, uFillCol: { value: new THREE.Vector3() }, uAmb: { value: new THREE.Vector3() },
  tAlbD: { value: null }, tLmD: { value: null }, uDRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uDUse: { value: new THREE.Vector2(1, 1) }, uDOn: { value: false },
  uClip: { value: false }, uWin: { value: 0 }, uTick: { value: 0 }, uRain: { value: 0 }, uSat: { value: 1.1 }, uExpo: { value: 1.5 }, uContrast: { value: .38 },
  uCalm: { value: 0 },   // 0 overview .. 1 zoomed in: stop-motion boil, wobble and tilt-shift fade out so a close-up is calm and sharp
};
const tile = meta.world?.tile || meta.tile;
Object.assign(U, {
  uTile: { value: new THREE.Vector3(...(tile?.center || [0, 0]), 0) }, uTileR: { value: new THREE.Vector2(...(tile?.right || [1, 0])) },
  uTileF: { value: new THREE.Vector2(...(tile?.forward || [0, 1])) }, uTileH: { value: new THREE.Vector2(tile?.half_u || 1, tile?.half_v || 1) },
});
U.uClip.value = !!tile;
const KIND = { building: 0, ground: 1, water: 2, plinth: 3, tree: 4, table: 5 };
const kindOf = (o) => {
  const n = `${o.name} ${o.parent?.name || ''}`.toLowerCase();
  return /terr|ground|grond/.test(n) ? 'ground' : /water|sea|zee/.test(n) ? 'water' : /sokkel|plinth/.test(n) ? 'plinth'
    : /bom|tree|boom/.test(n) ? 'tree' : /tafel|table/.test(n) ? 'table' : 'building';
};
const VERT = `
attribute vec4 vcol;
varying vec3 vW; varying vec4 vC; varying vec2 vUv;
void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vC = vcol; vUv = uv; gl_Position = projectionMatrix * viewMatrix * w; }`;
const FRAG = `
precision highp float;
uniform sampler2D tAlb, tLm, tWin, tDepth, tGround, tAlbD, tLmD;
uniform vec4 uDRect;
uniform vec2 uDUse;
uniform bool uDOn;
uniform mat4 uProj, uProjV;
uniform vec3 uProjPos;
uniform vec2 uImg, uNF;
uniform bool uHasWin, uHasGround, uHasV, uGroundTile, uClip;
uniform vec2 uTileR, uTileF, uTileH;
uniform vec3 uTile;
uniform int uKind;
uniform vec3 uKeyW, uFillW, uKeyDir, uFillDir, uKeyCol, uFillCol, uAmb;
uniform float uWin, uTick, uRain, uSat, uExpo, uContrast, uBias, uCell, uCalm;
varying vec3 vW; varying vec4 vC; varying vec2 vUv;
${COMMON}
${TONE}
bool outside(){ vec2 d = vW.xy - uTile.xy;
  return abs(dot(d, uTileR)) > uTileH.x + .5 || abs(dot(d, uTileF)) > uTileH.y + .5; }
void main(){
  if (uClip && uKind != 5 && uKind != 3 && outside()) discard;   // proxy terrain beyond the cut edge of the clay tile
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 V = normalize(cameraPosition - vW);
  if (dot(n, V) < 0.) n = -n;
  float boil = mod(uTick, 3.);                         // 3 fixed boil variants in a cycle (hand-made feel)

  // projective texturing from the render camera
  vec4 pc = uProj * vec4(vW, 1.);
  vec2 uv = pc.xy / pc.w * .5 + .5;
  float vis = step(0., pc.w) * step(0., uv.x) * step(uv.x, 1.) * step(0., uv.y) * step(uv.y, 1.);
  float dz = texture(tDepth, uv).r;
  float zTex = uNF.x * uNF.y / (uNF.y - dz * (uNF.y - uNF.x));
  float zFrag = -(uProjV * vec4(vW, 1.)).z;
  float facing = dot(n, normalize(uProjPos - vW));
  vis *= step(zFrag, zTex + uBias / max(facing, .25));  // hidden from the render camera: no projected facade
  vis *= smoothstep(.05, .18, facing);                  // nearly edge-on: stretched texels, fade to clay
  if (uKind == 5 || uKind == 3) vis = 0.;              // table and cut sides: plain clay (the render's own plinth would smear)

  vec2 px = uv * uImg;
  vec2 wob = vec2(vnoise(px / 11. + boil * 17.), vnoise(px / 11. + boil * 17. + 31.)) - .5;
  vec2 uvw = uv + wob * 1.3 * (1. - uCalm) / uImg;     // ~0.6 px clay wobble (render px: zoomed in that would be a visible shimmer)
  vec3 albP = texture(tAlb, uvw).rgb;
  vec3 lm = texture(tLm, uvw).rgb;
  if (uDOn) {                                          // deep zoom: sharper tiles where they have arrived (alpha 1)
    vec2 r = (uvw - uDRect.xy) / (uDRect.zw - uDRect.xy);
    if (r.x >= 0. && r.y >= 0. && r.x <= 1. && r.y <= 1.) {
      vec2 auv = vec2(r.x * uDUse.x, 1. - (1. - r.y) * uDUse.y);
      vec4 da = texture(tAlbD, auv), dl = texture(tLmD, auv);
      if (da.a > .99) albP = da.rgb;
      if (dl.a > .99) lm = dl.rgb;
    }
  }
  albP *= 1. + (vnoise(px / 2.5 + boil * 7.3) - .5) * .07 * (1. - uCalm);
  lm /= .8;                                            // baked on 0.8-grey clay
  vec3 litP = uKeyCol * dot(uKeyW, lm) + uFillCol * dot(uFillW, lm) + uAmb;

  // fallback: plain clay in the object colour, lit live (what the render camera never saw)
  vec3 albF = uHasV ? vC.rgb : vec3(.5, .42, .36);
  if (uKind == 1) {
    vec2 d = vW.xy - uTile.xy;   // no terrain uv: ground_top is the tile raster (row 0 = back edge, column 0 = left)
    vec2 guv = uGroundTile ? vec2(dot(d, uTileR) / uTileH.x, -dot(d, uTileF) / uTileH.y) * .5 + .5 : vUv;
    albF = uHasGround ? texture(tGround, guv).rgb : vec3(.35, .33, .25);
  }
  else if (uKind == 2) albF = vec3(.13, .36, .57);
  else if (uKind == 3) {                               // cut clay side: even colour, faint knife strokes
    float a = dot(vW.xy, uTileR) + dot(vW.xy, uTileF);
    float k = vnoise(vec2(a / (uCell * .9), vW.z / (uCell * .12))) * .6 + vnoise(vec2(a / (uCell * .25), vW.z / (uCell * .05))) * .4;
    albF = vec3(.40, .28, .18) * (.9 + .18 * k);
  }
  else if (uKind == 5) albF = vec3(.62, .57, .50);
  vec3 litF = (uKeyCol * max(dot(n, uKeyDir), 0.) + uFillCol * max(dot(n, uFillDir), 0.) + uAmb) * .78;

  vec3 alb = mix(albF, albP, vis);
  vec3 lit = mix(litF, litP, vis);

  // rain: wet clay is darker and glossy on roofs and streets
  float up = smoothstep(.45, .9, n.z);
  alb *= 1. - uRain * (.22 + .14 * up);
  vec3 col = alb * lit;
  vec3 Hh = normalize(uKeyDir + V);
  float spec = pow(max(dot(n, Hh), 0.), 50.) * up;
  float fres = pow(1. - max(dot(n, V), 0.), 3.) * up;
  float wetSpot = .6 + .4 * vnoise(vW.xy / 3.);
  col += uRain * wetSpot * (uKeyCol * spec * .35 + (uAmb * 2.5 + uFillCol * .35) * fres * .45);
  if (uKind == 2 && uRain > 0.) {                     // rain rings on the water at real scale: up to ~2 m across, only seen up close
    float mpp = length(fwidth(vW.xy));                 // metres per screen pixel here
    vec2 q = vW.xy / 4.; vec2 c = floor(q), f = fract(q) - .5;
    float h = hash(c), t = fract(uTick / 6. + h);
    vec2 o = vec2(hash(c + 3.1), hash(c + 7.7)) - .5;
    float d = length(f - o * .5) * 4.;                 // metres from the drop
    float w = max(.07, mpp * .8);
    float ring = smoothstep(w, 0., abs(d - t * 1.1)) * (1. - t) * step(hash(c + floor(uTick / 6. + h)), .45);
    col += (uAmb * 3. + uFillCol * .5 + .02) * ring * uRain * .9 * smoothstep(.45, .15, mpp);
  }

  // night: lamp spill on facades + projected window panes (alpha feeds the bloom)
  float facade = (uKind == 0 ? 1. : 0.) * (1. - step(.3, abs(n.z)));
  col += alb * vec3(1., .6, .3) * facade * uWin * .08;
  float em = uHasWin ? texture(tWin, uvw).r * step(hash(floor(uvw * uImg / 8.)), .6) * vis * uWin : 0.;
  col += vec3(1., .62, .3) * em * .9;
  gl_FragColor = vec4(tone(col), clamp(em, 0., 1.));
}`;
const mats = {};
root.traverse((o) => {
  if (!o.isMesh) return;
  const k = kindOf(o), g = o.geometry, c = g.getAttribute('color');
  if (c) g.setAttribute('vcol', c);
  const key = `${k}${c ? 'v' : ''}${g.getAttribute('uv') ? 'u' : ''}`;
  o.material = mats[key] ||= new THREE.ShaderMaterial({ uniforms: { ...U, uKind: { value: KIND[k] }, uHasV: { value: !!c }, uGroundTile: { value: !g.getAttribute('uv') && !!tile } },
    vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide });
});
table.material = new THREE.ShaderMaterial({ uniforms: { ...U, uKind: { value: KIND.table }, uHasV: { value: false }, uGroundTile: { value: false } }, vertexShader: VERT, fragmentShader: FRAG });

// ---------- deep zoom: tile pyramid (meta.tiles) composed into one atlas per pass, only what is on screen ----------
// meta.tiles: template 'tiles/{pass}/{z}/{x}_{y}.webp' (or passes: {albedo: template, lightmap: template}), max_z, tile_size [w, h];
// level z = 2^z x 2^z tiles of the same render camera, x = column from the left, y = row from the top.
const TL = meta.tiles || (Q.has('tiles') ? meta.tiles_test : null);   // no 'tiles' in meta = no deep zoom (testdata: ?tiles=1)
const ATLAS = Math.min(small ? 3072 : 4096, renderer.capabilities.maxTextureSize);   // ponytail: 2 atlases of 3072² ≈ 100 MB GPU on phones; drop to 2048 if old iPhones crash
const deep = TL ? (() => {
  const passList = (Array.isArray(TL.passes) ? TL.passes : Object.keys(TL.passes || { albedo: 1, lightmap: 1 })).filter((p) => p === 'albedo' || p === 'lightmap');
  // template: meta.tiles.template / path ('tiles/{pass}/{z}/{x}_{y}.png (+ .webp)': the first word counts)
  const ts = TL.tile_size || TL.size || [2560, 1440];
  const [TW, TH] = Array.isArray(ts) ? ts : [ts, Math.round(ts * IH / IW)];
  const lv = TL.max_z ?? TL.z_max ?? TL.levels ?? 0;
  const maxZ = Array.isArray(lv) ? Math.max(...lv.map((l) => +(l.z ?? l))) : +lv;
  // which tiles exist: complete_levels have all, partial_levels list "x_y"; without that info every tile is assumed present
  const avail = (z, x, y) => data.tiles.has(`${passList[0]}/${z}/${x}_${y}`);   // listed in meta (fetched lazily)
  const best = (z, x, y) => { for (let k = 0; z - k >= 1; k++) if (avail(z - k, x >> k, y >> k)) return z - k; return 0; };   // missing tile: fall back to its parent
  // the atlas lives only on the GPU: each slot is painted in a small scratch canvas and uploaded on its own
  // (re-uploading a whole 3072² canvas took 40-80 ms per pass, the hitch while zooming), no 2D atlas canvases in RAM
  const layers = {}, gl = renderer.getContext(), scratch = document.createElement('canvas'), sctx = scratch.getContext('2d');
  for (const pass of passList) {
    const rt = new THREE.WebGLRenderTarget(ATLAS, ATLAS, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
      colorSpace: pass === 'albedo' || /srgb/i.test(meta.passes?.[Object.keys(meta.passes || {}).find((k) => k.startsWith('lightmap.'))] || '') ? THREE.SRGBColorSpace : THREE.NoColorSpace });
    rt.texture.anisotropy = 4;
    renderer.setRenderTarget(rt); renderer.clear(); renderer.setRenderTarget(null);   // allocates it (alpha 0 = no tile yet)
    layers[pass] = { t: rt.texture, drawn: [] };
  }
  const bindAtlas = (L) => renderer.state.bindTexture(gl.TEXTURE_2D, renderer.properties.get(L.t).__webglTexture);
  function put(L, x, y) {   // scratch -> atlas at canvas position (x, y) from the top, rows flipped like a CanvasTexture
    bindAtlas(L);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, L.t.colorSpace === THREE.NoColorSpace ? gl.NONE : gl.BROWSER_DEFAULT_WEBGL);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, ATLAS - y - scratch.height, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
  }
  // decoded tiles, at the size their atlas slot needs (a full 2560x1440 tile is 15 MB of RAM); budget in bytes, so the
  // tiles of the current region always fit (the atlas itself is at most 2 x ATLAS^2 x 4 bytes) and nothing thrashes
  const cache = new Map(), loading = new Set(), failed = new Set(), BUDGET = (small ? 160 : 480) * 2 ** 20;
  let cur = null, dirty = false, lastUp = 0, lastUv = null, bytes = 0;
  function fetchTile(pass, z, x, y, w) {
    const k = `${pass}/${z}/${x}_${y}`;
    w = Math.min(TW, Math.ceil(w));
    if ((cache.get(k)?.width ?? 0) >= w - 1 || loading.has(k) || failed.has(k)) return;
    if (!data.tiles.has(k)) { failed.add(k); return; }
    loading.add(k);
    const opt = w < TW ? { resizeWidth: w, resizeHeight: Math.round(w * TH / TW), resizeQuality: 'high' } : undefined;
    data.tiles.get(k).then((blob) => createImageBitmap(blob, opt).then((b) => {   // fetched on first use (network error: retried on the next redraw)
      const old = cache.get(k);
      if (old) { cache.delete(k); bytes -= old.width * old.height * 4; old.close?.(); }
      cache.set(k, b); bytes += b.width * b.height * 4;
      while (bytes > BUDGET && cache.size > 1) { const [ok, ob] = cache.entries().next().value; cache.delete(ok); bytes -= ob.width * ob.height * 4; ob.close?.(); }
      dirty = true;
    }, () => failed.add(k)), () => {}).finally(() => loading.delete(k));
  }
  // paint every slot with the sharpest tile that is loaded (an ancestor, cropped, until the real one arrives);
  // only slots whose source changed are uploaded. Returns true when something was uploaded.
  function redraw() {
    if (!cur) return false;
    const { z, x0, y0, rc, rr, sw: W, sh: H } = cur;
    if (scratch.width !== W || scratch.height !== H) Object.assign(scratch, { width: W, height: H });
    let changed = false;
    for (const pass of passList) {
      const L = layers[pass];
      for (let y = y0; y < y0 + rr; y++) for (let x = x0; x < x0 + rc; x++) {
        const zb = best(z, x, y);
        let src = null, sig = '';
        if (zb) {
          fetchTile(pass, zb, x >> (z - zb), y >> (z - zb), W * 2 ** (z - zb));
          for (let zz = zb; zz >= 1; zz--) {
            const k = z - zz, key = `${pass}/${zz}/${x >> k}_${y >> k}`, b = cache.get(key);
            if (!b || !avail(zz, x >> k, y >> k)) continue;
            cache.delete(key); cache.set(key, b);   // LRU touch
            const f = 2 ** k, fx = x - (x >> k << k), fy = y - (y >> k << k);
            src = [b, fx / f * b.width, fy / f * b.height, b.width / f, b.height / f]; sig = `${key}@${b.width}`;
            break;
          }
        }
        const slot = (y - y0) * rc + (x - x0);
        if (L.drawn[slot] === sig) continue;
        L.drawn[slot] = sig; changed = true;
        sctx.clearRect(0, 0, W, H);
        if (src) sctx.drawImage(...src, 0, 0, W, H);
        put(L, (x - x0) * W, (y - y0) * H);
      }
    }
    return changed;
  }
  const trees = []; root.traverse((o) => { if (o.isMesh && kindOf(o) === 'tree') trees.push(o); });
  const uvRT = new THREE.WebGLRenderTarget(32, 20), uvPx = new Uint8Array(32 * 20 * 4);
  const uvMat = new THREE.ShaderMaterial({ uniforms: { uProj: U.uProj }, side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'uniform mat4 uProj; varying vec3 vW; void main(){ vec4 p = uProj * vec4(vW, 1.); gl_FragColor = vec4(clamp(p.xy / p.w * .5 + .5, 0., 1.), 1., 1.); }' });
  function update(moving) {   // returns true when it kept the old region because the camera moves (call again later)
    let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
    // what the screen really shows, in render-image uv: a tiny uv render of the scene (mountains, roofs and all)
    const cv = clouds.visible;   // trees (1 M triangles, half the scene) stand on the ground they hide: not needed here
    world.overrideMaterial = uvMat; clouds.visible = false; for (const t of trees) t.visible = false;
    renderer.setRenderTarget(uvRT); renderer.render(world, camera); renderer.setRenderTarget(null);
    world.overrideMaterial = null; clouds.visible = cv; for (const t of trees) t.visible = true;
    renderer.readRenderTargetPixels(uvRT, 0, 0, 32, 20, uvPx);
    for (let i = 0; i < uvPx.length; i += 4) {
      if (uvPx[i + 2] < 128) continue;
      const u = uvPx[i] / 255, v = uvPx[i + 1] / 255;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    if (u1 < u0) return;
    lastUv = [u0, v0, u1, v1];
    u0 = Math.max(0, u0 - .01); v0 = Math.max(0, v0 - .01); u1 = Math.min(.9999, u1 + .01); v1 = Math.min(.9999, v1 + .01);
    const need = sw * DPR / Math.max(u1 - u0, 1e-3);   // image px across the whole render that the screen can show
    let reg = null;
    for (let z = 1; z <= maxZ; z++) {
      const n = 2 ** z, x0 = Math.floor(u0 * n), y0 = Math.floor((1 - v1) * n);
      const rc = Math.min(n - 1, Math.floor(u1 * n)) - x0 + 1, rr = Math.min(n - 1, Math.floor((1 - v0) * n)) - y0 + 1;
      if (rc < 1 || rr < 1) continue;
      const W = Math.min(TW, Math.floor(ATLAS / rc), Math.floor(ATLAS / rr * TW / TH)), H = Math.floor(W * TH / TW);   // tiles shrink to fit the atlas
      let any = false;
      for (let y = y0; y < y0 + rr && !any; y++) for (let x = x0; x < x0 + rc && !any; x++) any = avail(z, x, y);
      if (!any || W * n <= Math.max(IW * 1.05, (reg?.W || 0) * (reg?.n || 0) * 1.05)) continue;   // nothing sharper here
      reg = { z, n, x0, y0, rc, rr, W, H, sw: W, sh: H };
      if (W * n >= need * 1.25) break;   // a bit of oversampling: prefer the deeper level
    }
    // while the camera moves, keep the region as long as it covers the view and is nearly sharp enough: every switch
    // re-uploads all slots (~30 MB, the hitch while pinching); the best region follows once the camera stops
    if (moving && cur && reg && cur.x0 / cur.n <= u0 && (cur.x0 + cur.rc) / cur.n >= u1 && cur.y0 / cur.n <= 1 - v1 && (cur.y0 + cur.rr) / cur.n >= 1 - v0
      && cur.W * cur.n >= Math.min(need, reg.W * reg.n) * .75) return true;
    const key = reg && `${reg.z}/${reg.x0}/${reg.y0}/${reg.rc}/${reg.rr}/${reg.W}`;
    if (key !== cur?.key) {
      cur = reg && { ...reg, key };
      U.uDOn.value = !!cur;
      if (cur) {
        U.uDRect.value.set(cur.x0 / cur.n, 1 - (cur.y0 + cur.rr) / cur.n, (cur.x0 + cur.rc) / cur.n, 1 - cur.y0 / cur.n);
        U.uDUse.value.set(cur.rc * cur.W / ATLAS, cur.rr * cur.H / ATLAS);
        for (const L of Object.values(layers)) L.drawn = [];
        dirty = true; lastUp = 0;   // paint the new region in this frame, not 150 ms later
      }
    }
  }
  function upload(now) {   // paint changed slots at most every 150 ms while tiles arrive
    if (!dirty || now - lastUp < 150) return;
    dirty = false; lastUp = now;
    if (!redraw()) return;
    for (const L of Object.values(layers)) { bindAtlas(L); gl.generateMipmap(gl.TEXTURE_2D); }
    return true;
  }
  return { layers, update, upload, state: () => cur && { z: cur.z, x0: cur.x0, y0: cur.y0, rc: cur.rc, rr: cur.rr, slot: cur.W, cached: cache.size, cachedMB: Math.round(bytes / 2 ** 20), failed: failed.size, uv: lastUv?.map((v) => +v.toFixed(3)) } };
})() : null;
U.tAlbD.value = deep?.layers.albedo?.t || null; U.tLmD.value = deep?.layers.lightmap?.t || null;

// cut sides of the clay tile (the proxy has none): walls from the terrain edge down to the table
let hasPlinth = false;
root.traverse((o) => { if (o.isMesh && kindOf(o) === 'plinth') hasPlinth = true; });
if (tile && !hasPlinth) {
  const R2 = new THREE.Vector2(...tile.right), F2 = new THREE.Vector2(...tile.forward), C2 = new THREE.Vector2(...tile.center);
  const [hu, hv] = [tile.half_u, tile.half_v], STEP = Math.max(4, mppD * 6);
  // edges in tile coordinates: [u0, v0, u1, v1]
  const edges = [[-hu, -hv, hu, -hv], [hu, -hv, hu, hv], [hu, hv, -hu, hv], [-hu, hv, -hu, -hv]];
  const bins = edges.map(([u0, v0, u1, v1]) => ({ n: Math.ceil(Math.hypot(u1 - u0, v1 - v0) / STEP), z: [], c: [] }));
  const v3 = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || kindOf(o) !== 'ground') return;
    const pa = o.geometry.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      v3.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld);
      const d = new THREE.Vector2(v3.x, v3.y).sub(C2), u = d.dot(R2), v = d.dot(F2);
      edges.forEach(([u0, v0, u1, v1], e) => {
        const along = u0 === u1 ? (v - v0) / (v1 - v0) : (u - u0) / (u1 - u0), off = u0 === u1 ? Math.abs(u - u0) : Math.abs(v - v0);
        if (off > STEP * 1.5 || along < 0 || along > 1) return;
        const b = bins[e], k = Math.round(along * b.n);
        b.z[k] = (b.z[k] || 0) + v3.z; b.c[k] = (b.c[k] || 0) + 1;
      });
    }
  });
  const pos = [], idx = [];
  edges.forEach(([u0, v0, u1, v1], e) => {
    const b = bins[e]; let last = 0;
    for (let k = 0; k <= b.n; k++) {
      const z = b.c[k] ? Math.max(0, b.z[k] / b.c[k]) : last; last = z;
      const u = u0 + (u1 - u0) * k / b.n, v = v0 + (v1 - v0) * k / b.n;
      const x = C2.x + u * R2.x + v * F2.x, y = C2.y + u * R2.y + v * F2.y, o = pos.length / 3;
      pos.push(x, y, z - .3, x, y, tableZ);
      if (k) idx.push(o - 2, o - 1, o, o, o - 1, o + 1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const wall = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: { ...U, uKind: { value: KIND.plinth }, uHasV: { value: false }, uGroundTile: { value: false } },
    vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide }));
  wall.name = 'sokkel'; world.add(wall);
}

// one-off depth render from the render camera (same tile clip as the colour pass)
world.overrideMaterial = new THREE.ShaderMaterial({ uniforms: U, side: THREE.DoubleSide,
  vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
  fragmentShader: `uniform bool uClip; uniform vec2 uTileR, uTileF, uTileH; uniform vec3 uTile; varying vec3 vW;
    void main(){ vec2 d = vW.xy - uTile.xy;
      if (uClip && (abs(dot(d, uTileR)) > uTileH.x + 2. || abs(dot(d, uTileF)) > uTileH.y + 2.) && vW.z > ${(tableZ + 1).toFixed(1)}) discard;
      gl_FragColor = vec4(1.); }` });
renderer.setRenderTarget(depthRT); renderer.render(world, projCam); renderer.setRenderTarget(null);
world.overrideMaterial = null;
// only depthRT.depthTexture is read from now on: free the colour attachment (4096x2304, 36 MB of GPU memory).
// ponytail: raw GL delete, three still thinks it exists; depthRT must never be rendered to again (and isn't)
renderer.getContext().deleteTexture(renderer.properties.get(depthRT.texture).__webglTexture);

// ---------- clouds: cotton-wool tufts drifting over the diorama; some float in the foreground now and then.
// Clearly there when zoomed out, they fade away as you zoom in (uFade). Rain makes them greyer, not more.
const clouds = new THREE.Group();
world.add(clouds);
const cloudMat = new THREE.ShaderMaterial({
  uniforms: { uKeyDir: U.uKeyDir, uLight: { value: new THREE.Vector3(1, 1, 1) }, uTick: U.uTick, uFade: { value: 1 }, uGrey: { value: 0 } },
  vertexShader: `varying vec3 vW, vN; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `precision highp float; varying vec3 vW, vN; uniform vec3 uKeyDir, uLight; uniform float uTick, uFade, uGrey;
    ${COMMON}
    void main(){ vec3 n = normalize(vN);
      float fuzz = vnoise(vW.xy * .35 + vW.z * .3 + mod(uTick, 3.) * 13.) * .14 + vnoise(vW.xy * 2.1 + vW.z) * .06;   // felt/cotton fibres, boiling at 8 fps
      float l = clamp(.55 + .45 * n.z + .25 * dot(n, uKeyDir) - fuzz, 0., 1.);
      vec3 c = mix(mix(vec3(.42, .45, .52), vec3(.97, .96, .93), l), mix(vec3(.30, .32, .37), vec3(.70, .72, .76), l), uGrey) * uLight;
      gl_FragColor = vec4(pow(c, vec3(1. / 2.2)), .82 * uFade); }`,
  transparent: true, depthWrite: false, blending: THREE.CustomBlending,     // see-through a little; keep the bloom alpha of what is behind
  blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
});
{
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const sizeM = (tanY * target0.distanceTo(projCam.position)) * 2;   // image height in metres at the target
  for (let i = 0; i < 8; i++) {
    const front = i >= 5;                     // 3 of 8 drift low over the city, in front
    const parts = [];
    const n = 4 + Math.floor(rnd() * 3), r0 = sizeM * (.02 + rnd() * .012) * (front ? 1.25 : 1);
    for (let j = 0; j < n; j++) {
      const g = new THREE.IcosahedronGeometry(r0 * (.55 + rnd() * .5), 4);
      const p = g.attributes.position, ph = rnd() * 9;
      for (let k = 0; k < p.count; k++) {   // soft lumps, no spikes: pulled cotton wool
        const x = p.getX(k) / r0, y = p.getY(k) / r0, z = p.getZ(k) / r0;
        const f = 1 + .07 * Math.sin(x * 5 + ph) * Math.sin(y * 4.3 - ph) + .05 * Math.sin(z * 6 + x * 3);
        p.setXYZ(k, p.getX(k) * f, p.getY(k) * f, p.getZ(k) * f * .8);
      }
      g.computeVertexNormals();
      g.translate((j - n / 2) * r0 * .7, (rnd() - .5) * r0 * .8, (rnd() - .3) * r0 * .5);
      parts.push(g);
    }
    const m = new THREE.Mesh(mergeGeometries(parts), cloudMat);
    m.rotation.z = Math.atan2(projCam.matrixWorld.elements[1], projCam.matrixWorld.elements[0]);   // long side along the image x axis
    // u: start across the image; v: height in the image (front ones low = near the viewer); one crossing takes 2-5 minutes
    m.userData = front
      ? { u: rnd() * 1.6, v: .18 + (i - 5) * .12 + rnd() * .05, lift: sizeM * (.16 + rnd() * .06), speed: .0045 + rnd() * .002 }
      : { u: rnd() * 1.6, v: .5 + rnd() * .14, lift: sizeM * (.09 + rnd() * .06), speed: .003 + rnd() * .003 };
    clouds.add(m);
  }
}
function placeClouds(tick) {
  for (const m of clouds.children) {
    const d = m.userData, u = -.3 + ((d.u + tick * d.speed / FPS) % 1.6);   // slow drift across and beyond the frame, then around again
    m.position.copy(projRay(u, d.v, target0.z)); m.position.z += d.lift;
  }
}

// ---------- view camera: starts exactly in the render camera; pan / zoom / turn a little, soft springs back ----------
const camera = new THREE.PerspectiveCamera(30, 1, 10, 20000);
camera.up.set(0, 0, 1);
const fwd0 = target0.clone().sub(projCam.position);
const bearing0 = Math.atan2(fwd0.x, fwd0.y) / deg, pitch0 = Math.asin(-fwd0.z / dist0) / deg;
const LIM = { yaw: [-12, 12], pitch: [-5, 15], zoom: [1, deep ? 8 : small ? 4 : 2] };   // tile pyramid: zoom as deep as z3
const T = { p: target0.clone(), yaw: 0, pitch: 0, zoom: 1 };      // target state
const C = { p: target0.clone(), yaw: 0, pitch: 0, zoom: 1 };      // eased state
let sw = 1, sh = 1, cover = [tanX, tanY], liftNdc = 0;   // liftNdc: optional lens shift (0 now that the time slider is in the menu)
function pose(s, cam) {
  const b = (bearing0 + s.yaw) * deg, p = (pitch0 + s.pitch) * deg, d = dist0 / s.zoom;
  cam.position.set(s.p.x - Math.sin(b) * Math.cos(p) * d, s.p.y - Math.cos(b) * Math.cos(p) * d, s.p.z + Math.sin(p) * d);
  cam.lookAt(s.p);
  cam.aspect = sw / sh; cam.fov = 2 * Math.atan(cover[1]) / deg; cam.near = d * .08; cam.far = d * 4;
  cam.updateProjectionMatrix();
  cam.projectionMatrix.elements[9] = -liftNdc;     // lens shift: the city sits a little higher, clear of the time slider
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  cam.updateMatrixWorld(true);
  return cam;
}
function resize() {
  sw = innerWidth; sh = innerHeight;
  renderer.setSize(sw, sh, false);
  const a = sw / sh, ia = tanX / tanY;
  cover = a > ia ? [tanX, tanX / a] : [tanY * a, tanY];   // "cover" fit of the render frame
  sceneRT.setSize(Math.round(sw * DPR), Math.round(sh * DPR));
  pu.uScreen.value.set(sw * DPR, sh * DPR);
}
const clampV = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const rubber = (v, lim) => { const c = clampV(v, lim); return c + (v - c) * .3; };
function clampPivot(p, zoom) {   // keep the screen inside the render frame (where the projection has data)
  const fx = Math.min(1, cover[0] / tanX / zoom), fy = Math.min(1, cover[1] / tanY / zoom);
  const [u, v] = toProjUv(p);
  const cu = clampV(u, [fx / 2, 1 - fx / 2]), cv = clampV(v, [fy / 2, 1 - fy / 2]);
  return cu === u && cv === v ? p.clone() : projRay(cu, cv, p.z);
}
const rubberPivot = (p, zoom) => { const c = clampPivot(p, zoom); return c.add(p.clone().sub(c).multiplyScalar(.3)); };

const sceneRT = new THREE.WebGLRenderTarget(1, 1, { samples: small ? 0 : 4, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });

// ---------- post: bloom -> mild tilt-shift -> rain threads -> highlights -> vignette -> grain ----------
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postMat = new THREE.ShaderMaterial({
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  uniforms: {
    tScene: { value: sceneRT.texture }, uScreen: { value: new THREE.Vector2() }, uDpr: { value: DPR },
    uFocus: { value: .5 }, uDof: { value: small ? 1.0 : 1.5 }, uTick: { value: 0 }, uRain: { value: 0 }, uRainLight: { value: 1 }, uCalm: U.uCalm,
  },
  fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform vec2 uScreen;
uniform float uDpr, uFocus, uDof, uTick, uRain, uRainLight, uCalm;
${COMMON}
vec4 S(vec2 uv, float lod){ return textureLod(tScene, uv, lod); }
void main(){
  vec2 uv = vUv;
  vec3 bloom = vec3(1., .62, .32) * (S(uv, 3.5).a * .9 + S(uv, 5.5).a * .9);
  float blur = smoothstep(.26, .7, abs(uv.y - uFocus)) * uDof * (1. - uCalm);   // wide sharp band, mild falloff
  vec2 r = exp2(blur) * .8 / uScreen;
  vec3 col = S(uv, blur).rgb * .4 + (S(uv + r, blur).rgb + S(uv - r, blur).rgb + S(uv + vec2(-r.x, r.y), blur).rgb + S(uv + vec2(r.x, -r.y), blur).rgb) * .15;
  col += bloom;
  vec2 ca = (uv - .5) * 2.4 / uScreen.y * vec2(uScreen.y / uScreen.x, 1.);   // light chromatic aberration toward the edges
  float cl = blur + .5 * (1. - uCalm);
  col.r = mix(col.r, S(uv + ca, cl).r + bloom.r, .65);
  col.b = mix(col.b, S(uv - ca, cl).b + bloom.b, .65);

  // rain: thin short streaks (a few px), redrawn on the stop-motion clock; subtle
  if (uRain > .01) {
    vec2 p = uv * uScreen / uDpr;
    p.x += p.y * .12;
    vec2 cell = vec2(11., 46.);
    vec2 id = floor(p / cell), l = fract(p / cell) * cell;
    float tk = floor(uTick);
    float h1 = hash(id + tk * 1.37), h2 = hash(id * 1.7 + tk * .71), h3 = hash(id + tk * 2.3 + 5.);
    float on = step(h1, .3 * uRain);
    float x0 = 2. + h2 * (cell.x - 4.), y0 = h3 * (cell.y - 16.), len = 7. + 7. * h2;
    float line = smoothstep(.75, .1, abs(l.x - x0 + (l.y - y0) * .12)) * smoothstep(y0, y0 + 2., l.y) * smoothstep(y0 + len, y0 + len - 3., l.y);
    col = mix(col, vec3(.86, .91, 1.) * uRainLight, on * line * .32);
  }

  vec2 v = (uv - .5) * vec2(uScreen.x / uScreen.y, 1.);
  col *= mix(.72, 1., smoothstep(1.05, .35, length(v)));             // vignette
  col += (hash(floor(uv * uScreen) + uTick * 17.31) - .5) * .05 * (1. - .7 * uCalm);   // grain on the stop-motion clock, faint up close
  gl_FragColor = vec4(col, 1.);
}`,
});
const pu = postMat.uniforms;
const postScene = new THREE.Scene();
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));
addEventListener('resize', () => { resize(); needRender = pinsDirty = true; });
resize();

// ---------- highlights (highlights.json) as 3D anchors ----------
const list = (o) => Array.isArray(o) ? o.map((v) => [v.key || v.id || v.name, v]) : Object.entries(o || {});
const places = [...list(meta.plekken), ...list(meta.places), ...list(meta.landmarks), ...list(meta.offscreen)].map(([k, p]) => ({
  key: k || '', name: p.naam || p.name || '', lat: p.lat, lon: p.lon,
  x: p.x ?? p.world?.[0], y: p.y ?? p.world?.[1], z: p.z_render ?? p.world?.[2], zMarker: p.z_marker,
})).filter((p) => isFinite(p.x) && isFinite(p.y));
const geoFit = (() => {   // lat/lon -> world x/y: least-squares affine fit over the places in meta.json
  const pts = places.filter((p) => isFinite(p.lat) && isFinite(p.lon));
  if (pts.length < 3) return null;
  const lon0 = pts.reduce((a, p) => a + p.lon, 0) / pts.length, lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const A = new Array(9).fill(0), bx = [0, 0, 0], by = [0, 0, 0];
  for (const p of pts) {
    const r = [(p.lon - lon0) * 1e3, (p.lat - lat0) * 1e3, 1];
    for (let i = 0; i < 3; i++) { bx[i] += r[i] * p.x; by[i] += r[i] * p.y; for (let j = 0; j < 3; j++) A[i * 3 + j] += r[i] * r[j]; }
  }
  const inv = new THREE.Matrix3().fromArray(A).invert();
  if (!inv.elements.every(isFinite) || inv.determinant() === 0) return null;
  const cx = new THREE.Vector3(...bx).applyMatrix3(inv), cy = new THREE.Vector3(...by).applyMatrix3(inv);
  return (lat, lon) => { const a = (lon - lon0) * 1e3, b = (lat - lat0) * 1e3; return [cx.x * a + cx.y * b + cx.z, cy.x * a + cy.y * b + cy.z]; };
})();
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ø/g, 'o').replace(/å/g, 'a');
const findPlace = (n) => n && (places.find((p) => norm(p.key) === norm(n)) || places.find((p) => norm(p.name) === norm(n))
  || places.find((p) => p.name && norm(p.name).includes(norm(n))));
const ray = new THREE.Raycaster();
const groundZ = (x, y) => {
  ray.set(new THREE.Vector3(x, y, box.max.z + 50), new THREE.Vector3(0, 0, -1));
  return ray.intersectObject(root, true)[0]?.point.z;
};
const hlFile = await fetch('highlights.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({ items: [] }));
const highlights = [];
for (const it of hlFile.items || []) {
  const pl = findPlace(it.plek);
  const xy = pl ? [pl.x, pl.y] : geoFit && isFinite(it.lat) ? geoFit(it.lat, it.lon) : null;
  const gz = xy && groundZ(...xy);
  const [u, v, z] = gz != null ? toProjUv(new THREE.Vector3(xy[0], xy[1], gz)) : [-1, -1, 2];
  if (!(u > .01 && u < .99 && v > .01 && v < .99 && z < 1)) { console.info('plek niet in beeld, overgeslagen:', it.titel); continue; }
  highlights.push({ ...it, world: new THREE.Vector3(xy[0], xy[1], pl?.zMarker ?? Math.max(gz, pl?.z ?? -1e9) + 4) });
}
// ---------- categories (a light medical wink: Tess is a doctor) ----------
const CATS = { toerist: 'Standaardbehandeling', samen: 'Persoonlijk behandelplan' };
const catOf = (h) => (h.categorie in CATS ? h.categorie : 'toerist');
const nowMs = () => (Q.has('nu') ? Date.parse(Q.get('nu')) : Date.now());   // ?nu=2026-10-23T10:00 for tests
// clay markers from the UI kit (Blender renders, ui/UI-KIT.md): flag = standard treatment, pin with a cross = personal plan,
// cream head with a number = cluster. Image 56x62 with the ground point at (28, 56); the button is 46x54 with it at (23, 50).
const MARK = {
  toerist: '<img class="mk" src="ui/marker-vlag.webp" alt="" draggable="false">',
  samen: '<img class="mk" src="ui/marker-pin.webp" alt="" draggable="false">',
  cluster: (n, samen) => `<img class="mk" src="ui/marker-cluster-${samen ? 'samen' : 'toerist'}.webp" alt="" draggable="false"><b class="mk-n${samen ? ' samen' : ''}">${n}</b>`,
};
// ---------- 'toegediend': per place a done state, stored locally. Places the dossier also has (same origin, so the same
// localStorage) are read and written in the dossier's own format, so a tick on the map counts there and the other way round.
const DOS_KEY = 'bergen-dossier-v1', OWN_KEY = 'bergen-klei-gedaan';
const DOSSIER_ID = { bryggen: 'bryggen', fisketorget: 'vismarkt', vagal: 'vagal', hotdog: 'hotdog', klee: 'klee', floyen: 'floyen' };
const AFGEROND = !!window.KLEI_AFGEROND;   // set in intro.js: the visit is over, every place shows as done on every device
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
let doneT = new Map();   // highlight -> time it was ticked (ms); missing = not done
function readDone() {
  const dos = lsGet(DOS_KEY)?.items || {}, own = lsGet(OWN_KEY) || {};
  doneT = new Map();
  for (const h of highlights) {
    const d = DOSSIER_ID[h.plek], x = d ? dos[d] : null;
    const t = (d ? (x?.done ? +x.t || 1 : 0) : +own[h.plek] || 0) || +AFGEROND;
    if (t) doneT.set(h, t);
  }
}
function setDone(h, on) {
  const t = on ? nowMs() : 0, d = DOSSIER_ID[h.plek];
  if (d) {   // fresh read right before the write: never overwrite what the dossier saved meanwhile
    const S = lsGet(DOS_KEY) || { items: {}, weer: '' };
    S.items ||= {};
    S.items[d] = { done: false, note: '', booked: false, keuze: '', t: 0, ...S.items[d], done: on, t };
    lsSet(DOS_KEY, S);
  } else {
    const o = lsGet(OWN_KEY) || {};
    if (on) o[h.plek] = t; else delete o[h.plek];
    lsSet(OWN_KEY, o);
  }
  refreshDone();
}
const fmtDate = (t) => new Date(t).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', timeZone: 'Europe/Oslo' });
function refreshDone() {
  readDone();
  const n = highlights.length, k = doneT.size;
  $('progress-txt').textContent = AFGEROND ? 'Alle behandelingen toegediend: Bergen is genezen' : k === n ? `Alle ${n} toegediend: Bergen is genezen` : `${k} van ${n} behandelingen toegediend`;
  $('progress').querySelector('i').style.width = `${(100 * k / Math.max(n, 1)).toFixed(1)}%`;
  $('progress').classList.toggle('all', k === n && n > 0);
  if (selected >= 0) showDone(highlights[selected]);
  pinsDirty = true;
}
function showDone(h) {
  const t = doneT.get(h), card = $('card');
  card.classList.toggle('done', !!t);
  $('done').setAttribute('aria-pressed', String(!!t));
  $('done-lbl').textContent = t ? 'Toegediend' : 'Behandeling toegediend';
  $('done-sub').textContent = t ? 'Tik nogmaals om ongedaan te maken' : 'Afvinken als het gedaan is';
  $('done-stamp').hidden = !t;
  if (t) { $('done-date').textContent = t > 1 ? fmtDate(t) : AFGEROND ? 'okt 2026' : ''; $('done-date').dateTime = t > 1 ? new Date(t).toISOString().slice(0, 10) : AFGEROND ? '2026-10' : ''; }
}
$('done').onclick = () => { const h = highlights[selected]; if (h && !AFGEROND) setDone(h, !doneT.has(h)); };
$('done').hidden = AFGEROND;
const camRightH = new THREE.Vector3(Math.cos(bearing0 * deg), -Math.sin(bearing0 * deg), 0);
if (highlights[0] && cover[0] < tanX * .8) {   // narrow screen: start with the first place in the middle (like the flat viewer)
  T.p.addScaledVector(camRightH, highlights[0].world.clone().sub(T.p).dot(camRightH));
  T.p.copy(clampPivot(T.p, 1)); C.p.copy(T.p);
}
const screenOf = (w, cam) => { const v = w.clone().project(cam); return [(v.x * .5 + .5) * sw, (.5 - v.y * .5) * sh, v.z < 1]; };

// ---------- time of day: an October sun path for Bergen + two lights per mood ----------
// Sun: rises SE ~08:15, low over the south (max ~20 deg) ~13:15, sets SW ~18:15.
const sunAt = (c) => { const s = (c - 13.25) / 5; return [180 + 66 * clampV(s, [-1.4, 1.4]), 20 * Math.cos(s * Math.PI / 2)]; };
// key: [r, g, b, intensity]; fill = sky light; sat/expo/contrast = paint feel per mood
const PHASES = [
  { name: 'Ochtend',    clock: 9,     key: [1.0, .80, .62, 1.55], fill: [.52, .62, .88, .50], amb: [.09, .10, .14], win: 0,   sat: 1.22, expo: 1.12 },
  { name: 'Middag',     clock: 13.25, key: [1.0, .92, .80, 1.30], fill: [.50, .60, .85, .30], amb: [.06, .07, .10], win: 0,   sat: 1.32, expo: 0.98 },
  { name: 'Gouden uur', clock: 17.4,  key: [1.0, .58, .28, 1.7],  fill: [.45, .50, .80, .50], amb: [.08, .08, .14], win: .08, sat: 1.18, expo: 1.2 },
  { name: 'Schemer',    clock: 18.7,  key: [1.0, .45, .36, .55],  fill: [.36, .36, .78, .55], amb: [.06, .06, .13], win: .55, sat: 1.1,  expo: 1.45 },
  { name: 'Nacht',      clock: 22,    key: [.42, .54, 1.0, .30],  fill: [.16, .20, .50, .14], amb: [.015, .025, .07], win: 1, sat: 1.05, expo: 1.7 },
];
// clock (hours) -> mood: dark until 06:30, morning by 09:00, ..., dark again from 20:15 (Bergen in late October)
const KF = [[0, 4], [6.5, 4], [9, 0], [13.25, 1], [17.4, 2], [18.7, 3], [20.25, 4], [24, 4]];
const lerp = (a, b, t) => a + (b - a) * t;
const mixArr = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
function phaseAt(c) {
  let k = 0;
  while (k < KF.length - 2 && c > KF[k + 1][0]) k++;
  const [c0, i0] = KF[k], [c1, i1] = KF[k + 1], f = THREE.MathUtils.smoothstep(c, c0, c1);
  const a = PHASES[i0], b = PHASES[i1], o = { clock: c };
  for (const key of ['key', 'fill', 'amb']) o[key] = mixArr(a[key], b[key], f);
  for (const key of ['win', 'sat', 'expo']) o[key] = lerp(a[key], b[key], f);
  return o;
}
const phaseName = (c) => c < 7.5 || c >= 19.6 ? 'Nacht' : c < 11 ? 'Ochtend' : c < 15.5 ? 'Middag' : c < 18.1 ? 'Gouden uur' : 'Schemer';
const hhmm = (c) => { const m = Math.round(c * 60) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

// ---------- UI: menu with time + rain ----------
const menu = $('menu'), menuBtn = $('menu-btn');
const setMenu = (open) => { menu.classList.toggle('closed', !open); menuBtn.setAttribute('aria-expanded', String(open)); };
menuBtn.onclick = () => setMenu(menu.classList.contains('closed'));
$('menu-close').onclick = () => setMenu(false);
for (const b of document.querySelectorAll('#map-row [data-v]')) {   // v2/v3 choice: remembered, then reload with that render
  const v = b.dataset.v;
  b.setAttribute('aria-checked', String(v === mapVer && !isTest));
  if (v === 'v3' && !v3ok) { b.disabled = true; b.title = 'Nieuwe kaart is nog niet klaar'; }
  b.onclick = () => { if (v === mapVer) return; try { localStorage.setItem(MAP_KEY, v); } catch {} location.reload(); };
}
$('map-row').hidden = Q.has('data');
$('time-row').onclick = () => { const tb = $('timebox'); tb.hidden = !tb.hidden; $('time-row').setAttribute('aria-expanded', String(!tb.hidden)); };
const slider = $('slider');
function bergenClock() {   // the real time in Bergen, in hours
  const [h, m] = new Date(nowMs()).toLocaleTimeString('en-GB', { timeZone: 'Europe/Oslo', hour12: false }).split(':').map(Number);
  return (h % 24) + m / 60;
}
let clock = bergenClock(), auto = true;
if (Q.has('klok')) { clock = +Q.get('klok'); auto = false; }
else if (Q.has('t')) {   // old links: ?t= phase index 0..4
  const t = clampV(+Q.get('t'), [0, 4]), i = Math.min(3, Math.floor(t));
  clock = lerp(PHASES[i].clock, PHASES[i + 1].clock, t - i); auto = false;
}
function setAuto(on) {
  auto = on; $('auto').setAttribute('aria-checked', String(on));
  if (on) clock = bergenClock();
  updateLabel();
}
$('auto').onclick = () => setAuto(!auto);
slider.addEventListener('input', () => { auto = false; $('auto').setAttribute('aria-checked', 'false'); clock = +slider.value / 60; updateLabel(); });
setInterval(() => { if (auto) { clock = bergenClock(); updateLabel(); } }, 30000);
PHASES.forEach((p) => {
  const b = Object.assign(document.createElement('button'), { textContent: p.name });
  b.onclick = () => { auto = false; $('auto').setAttribute('aria-checked', 'false'); clock = p.clock; updateLabel(); };
  $('stops').append(b);
});
function updateLabel() {
  slider.value = Math.round(clock * 12) * 5;
  const name = phaseName(clock);
  $('phase').textContent = name;
  [...$('stops').children].forEach((b) => b.classList.toggle('on', b.textContent === name));
  $('clock').textContent = $('time-val').textContent = hhmm(clock);
  $('auto').setAttribute('aria-checked', String(auto));
}
updateLabel();

// rain (default: the real weather in Bergen from api.met.no, silently dry if that fails)
let rainOn = false, rain = 0, rainTouched = Q.has('regen');
const rainBtn = $('rain');
const setRain = (on) => { rainOn = on; rainBtn.setAttribute('aria-checked', String(on)); $('rain-val').textContent = rainTouched ? '' : 'volgt het weer'; };
rainBtn.onclick = () => { rainTouched = true; setRain(!rainOn); };
setRain(false);
if (Q.has('regen')) setRain(Q.get('regen') === '1');
else fetch('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=60.39&lon=5.32')
  .then((r) => r.ok ? r.json() : null)
  .then((j) => {
    const d = j?.properties?.timeseries?.[0]?.data;
    const wet = (d?.next_1_hours?.details?.precipitation_amount ?? 0) >= .1 || /rain|sleet|drizzle|shower/.test(d?.next_1_hours?.summary?.symbol_code || '');
    if (wet && !rainTouched) setRain(true);
  }).catch(() => {});

// ---------- camera flights: selecting a place flies in, back flies out ----------
const dragCam = new THREE.PerspectiveCamera();
dragCam.up.set(0, 0, 1);
const hitPlane = (x, y, cam, z) => {
  ray.setFromCamera(new THREE.Vector2(x / sw * 2 - 1, 1 - y / sh * 2), cam);
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
};
const snap = (s) => ({ p: s.p.clone(), yaw: s.yaw, pitch: s.pitch, zoom: s.zoom });
let flight = null;
const ease = (s) => s < .5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2;
function flyTo(to, dur) {
  const from = snap(C);
  const r = to.zoom / from.zoom, far = from.p.distanceTo(to.p) / (dist0 / Math.max(from.zoom, to.zoom));
  flight = { from, to, t0: performance.now(), dur: dur ?? clampV(650 + 450 * Math.abs(Math.log(r)) + 250 * Math.min(far, 2), [650, 1700]) };
}
function stepFlight(now) {
  const { from, to, t0, dur } = flight, s = Math.min(1, (now - t0) / dur), e = ease(s);
  T.zoom = from.zoom * (to.zoom / from.zoom) ** e;
  // zoom about the one point that stays put (the place glides in instead of swinging past)
  const w = Math.abs(to.zoom - from.zoom) > 1e-3 ? (1 - from.zoom / T.zoom) / (1 - from.zoom / to.zoom) : e;
  T.p.lerpVectors(from.p, to.p, w); T.yaw = lerp(from.yaw, to.yaw, e); T.pitch = lerp(from.pitch, to.pitch, e);
  C.p.copy(T.p); C.yaw = T.yaw; C.pitch = T.pitch; C.zoom = T.zoom;
  if (s >= 1) flight = null;
}
const cancelFlight = () => { if (flight) { flight = null; Object.assign(T, snap(C)); } };
function zoomAbout(x, y, zoom, dur = 380) {   // animated zoom keeping the ground under (x, y) in place
  const to = snap(T);
  to.zoom = clampV(zoom, LIM.zoom);
  pose(T, dragCam);
  const h = hitPlane(x, y, dragCam, T.p.z);
  if (h) to.p.lerp(h, 1 - T.zoom / to.zoom);
  to.p.copy(clampPivot(to.p, to.zoom));
  flyTo(to, dur);
}
function closeUp(h) {   // a close view from a little higher, with the place in the middle of what the card leaves free
  const card = $('card'), wide = sw >= 760;
  const to = { p: target0.clone(), yaw: clampV(T.yaw, LIM.yaw), pitch: Math.max(clampV(T.pitch, LIM.pitch), 6), zoom: clampV(Math.max(T.zoom, small ? 3.8 : 4.4), LIM.zoom) };
  const top = $('title').offsetTop + $('title').offsetHeight;
  const tx = wide ? card.offsetLeft / 2 + 8 : sw / 2, ty = wide ? (top + sh) / 2 : (top + card.offsetTop) / 2;
  to.p.set(h.world.x, h.world.y, target0.z);
  pose(to, dragCam);
  const H = hitPlane(tx, ty, dragCam, h.world.z);
  if (H) to.p.add(new THREE.Vector3(h.world.x - H.x, h.world.y - H.y, 0));
  to.p.copy(clampPivot(to.p, to.zoom));
  return to;
}

// ---------- UI: prescription card ----------
let selected = -1, home = null;
function fillCard(h) {
  $('card-title').textContent = h.titel || 'Plek';
  $('card-cat').textContent = CATS[catOf(h)];
  $('card-text').textContent = h.tekst || '';
  const weer = { regen: 'mag ook bij regen', zon: 'bij droog weer' }[h.weer];
  const rows = [['Sig.', h.dosering, true], ['Wanneer', h.wanneer], ['Waar', h.waar], ['Kosten', h.kosten], ['Weer', weer], ['Website', h.website]].filter((r) => r[1]);
  const link = (u) => Object.assign(document.createElement('a'), { href: u, target: '_blank', rel: 'noopener', textContent: u.replace(/^https?:\/\/(www\.)?|\/$/g, '') });
  $('card-dl').replaceChildren(...rows.flatMap(([k, v, hand]) => [
    Object.assign(document.createElement('dt'), { textContent: k }),
    k === 'Website' ? document.createElement('dd').appendChild(link(v)).parentNode
      : Object.assign(document.createElement('dd'), { textContent: v, className: hand ? 'hand' : '' })]));
  const img = $('card-img');
  img.hidden = !h.foto;
  if (h.foto) img.src = h.foto;
  const vis = highlights;
  $('count').textContent = `${vis.indexOf(h) + 1} van ${vis.length}`;
  $('prev').hidden = $('next').hidden = $('count').hidden = vis.length < 2;
}
function openCard(h, i, fly = true) {
  cancelFlight();
  if (selected < 0 && !home) home = snap(T);
  selected = i; pinsDirty = true;
  $('card').className = `paper open ${catOf(h)}`;
  fillCard(h); showDone(h);
  $('card').scrollTop = 0;
  setMenu(false); $('hint').classList.add('gone');
  if (fly) flyTo(closeUp(h));
}
function closeCard(back) {
  if (selected < 0) return;
  selected = -1; pinsDirty = true;
  $('card').classList.remove('open');
  if (back && home) { cancelFlight(); flyTo(home); }
  home = null;
}
$('close').onclick = $('back').onclick = () => closeCard(true);
const stepCard = (d) => {
  const vis = highlights;
  if (!vis.length) return;
  const h = vis[(vis.indexOf(highlights[selected]) + d + vis.length) % vis.length];
  openCard(h, highlights.indexOf(h));
};
$('prev').onclick = () => stepCard(-1);
$('next').onclick = () => stepCard(1);
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!menu.classList.contains('closed')) setMenu(false); else closeCard(true);
});

// ---------- markers: places close together on screen merge into one (with a count), split again when zooming in ----------
const pinsEl = Object.assign(document.createElement('div'), { id: 'pins' });
document.body.insertBefore(pinsEl, $('title'));
const pins = highlights.map(() => {
  const b = document.createElement('button');
  b.onclick = (e) => { if (e.detail === 0) openCluster(b.cluster); };   // keyboard; pointer taps on pins go through the gesture code (so a pan or pinch may start on a pin)
  pinsEl.append(b);
  return b;
});
function openCluster(c) {
  if (!c) return;
  if (c.m.length === 1 || T.zoom >= LIM.zoom[1] - .01) return openCard(c.m[0], highlights.indexOf(c.m[0]));   // one place, or cannot split further
  const p = c.m.reduce((a, h) => a.add(h.world), new THREE.Vector3()).divideScalar(c.m.length);
  const [x, y] = screenOf(p, camera);
  cancelFlight();
  zoomAbout(x, y, T.zoom * 2.4, 700);
}
let pinsDirty = true, needRender = true;
addEventListener('storage', (e) => { if (e.key === DOS_KEY || e.key === OWN_KEY || e.key === null) refreshDone(); });   // the dossier in another tab
addEventListener('pageshow', () => refreshDone());   // back from the dossier (bfcache)
{ const o = lsGet(OWN_KEY); if (o && 'heit' in o) { delete o.heit; lsSet(OWN_KEY, o); } }   // Heit is no longer a map place (secret recipe in the dossier)
refreshDone();
const SOLO = new Set(['bryggen']);   // the first stop: never inside a cluster, so one tap on the overview opens it
function layoutPins() {
  const cl = [], solo = [];
  for (const h of highlights) {
    const [x, y, front] = screenOf(h.world, camera);
    if (!front || x < -30 || y < -30 || x > sw + 30 || y > sh + 60) continue;
    if (SOLO.has(h.plek)) { solo.push({ x, y, m: [h] }); continue; }
    const c = cl.find((c) => Math.abs(c.x - x) < 50 && Math.abs(c.y - y) < 58);   // marker boxes (46 x 54 + badge) would touch: merge
    if (c) { c.m.push(h); c.x += (x - c.x) / c.m.length; c.y += (y - c.y) / c.m.length; } else cl.push({ x, y, m: [h] });
  }
  for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {   // centroids moved: merge clusters that now touch
    const a = cl[i], c = cl[j];
    if (Math.abs(a.x - c.x) >= 50 || Math.abs(a.y - c.y) >= 58) continue;
    const n = a.m.length + c.m.length;
    a.x = (a.x * a.m.length + c.x * c.m.length) / n; a.y = (a.y * a.m.length + c.y * c.m.length) / n; a.m.push(...c.m);
    cl.splice(j, 1); j = i;
  }
  // close in, 2 or 3 places that stay on top of each other (Vågal and the hotdog are ~100 m apart) fan out: each pin keeps
  // its foot on its own spot and leans away from the others, like pins stuck in at an angle
  const shown = [];
  for (const c of cl) {
    if (c.m.length < 2 || c.m.length > 3 || C.zoom < 2.5) { shown.push(c); continue; }
    const f = c.m.map((h) => { const [x, y] = screenOf(h.world, camera); return { x, y, m: [h] }; }).sort((a, b) => a.x - b.x);
    f.forEach((q, i) => { q.tilt = (i - (f.length - 1) / 2) * (f.length === 2 ? 60 : 36); shown.push(q); });
  }
  for (const s of solo) {   // a solo pin next to a marker: both lean away from each other instead of merging
    const q = shown.find((q) => Math.abs(q.x - s.x) < 50 && Math.abs(q.y - s.y) < 58);
    if (q) { s.tilt = s.x < q.x ? -30 : 30; q.tilt ??= -s.tilt; }
    shown.push(s);
  }
  pins.forEach((b, i) => {
    const c = shown[i];
    b.hidden = !c; b.cluster = c;
    if (!c) return;
    b.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)${c.tilt ? ` rotate(${c.tilt}deg)` : ''}`;
    b.classList.toggle('sel', c.m.includes(highlights[selected]));
    const one = c.m.length === 1 && c.m[0];
    const kind = one ? catOf(one) : `n${c.m.length}${c.m.every((h) => catOf(h) === 'samen') ? 's' : ''}`;
    if (b.dataset.kind !== kind) {
      b.dataset.kind = kind;
      b.innerHTML = one ? MARK[kind] : MARK.cluster(c.m.length, kind.endsWith('s'));
    }
    const k = c.m.filter((h) => doneT.has(h)).length, badge = !k ? '' : k === c.m.length ? '✓' : `${k}/${c.m.length}`;
    if ((b.dataset.done || '') !== badge) { if (badge) b.dataset.done = badge; else delete b.dataset.done; }
    const label = (one ? one.titel : `${c.m.length} plekken: ${c.m.map((h) => h.titel).join(', ')}`) + (badge ? `, toegediend: ${badge === '✓' ? 'ja' : badge}` : '');
    if (b.getAttribute('aria-label') !== label) { b.setAttribute('aria-label', label); b.title = label; }
  });
}

// ---------- hint: once, how to move (and turn) ----------
function showHint() {
  let seen = false;
  try { seen = localStorage.getItem('bergen-klei-hint') === '1'; localStorage.setItem('bergen-klei-hint', '1'); } catch {}
  if (seen && !Q.has('hint')) return;
  const el = $('hint');
  el.textContent = coarse ? 'Eén vinger schuift, knijp om te zoomen, draai met twee vingers. Dubbeltik zoomt in, tik met twee vingers zoomt uit.'
    : 'Slepen schuift, scrollen zoomt. Draaien: rechtermuisknop of shift ingedrukt en slepen.';
  el.classList.remove('gone');
  const t0 = performance.now(), hide = () => el.classList.add('gone');
  setTimeout(hide, 9000);
  addEventListener('pointerdown', function h() { if (performance.now() - t0 > 2500) { hide(); removeEventListener('pointerdown', h); } });
}

// ---------- input: 1 finger / drag = pan, pinch = zoom about the fingers, 2-finger twist / right- or shift-drag = turn,
// wheel = zoom about the cursor, double tap = zoom in there ----------
const pts = new Map();
let gesture = null, lastTap = null;
const interacting = () => pts.size > 0;
function startGesture(e) {
  const P = [...pts.values()];
  const base = { yaw: T.yaw, pitch: T.pitch, zoom: T.zoom, p: T.p.clone(), moved: false };
  pose(T, dragCam);
  if (P.length >= 2) {
    const [a, b] = P, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    gesture = { ...base, kind: 'two', d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), hit: hitPlane(mx, my, dragCam, T.p.z), moved: true };
  } else {
    const rot = e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey;
    gesture = { ...base, kind: rot ? 'rot' : 'pan', x: e.clientX, y: e.clientY, hit: hitPlane(e.clientX, e.clientY, dragCam, T.p.z) };
  }
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
function down(e) {
  if (e.currentTarget === pinsEl && !e.target.closest('button')) return;
  e.preventDefault();   // no text selection / iOS callout on a long press
  cancelFlight();
  if (!menu.classList.contains('closed')) setMenu(false);
  if (e.isPrimary && pts.size) resetPointers();   // a first finger while pointers are still listed: their up/cancel got lost
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  // iOS Safari keeps a touch on the element it started on (a pin) and ignores capture onto another element, so
  // move/up/cancel are handled on window (they bubble from canvas and pins alike); capture only helps a mouse leave the window
  try { e.target.setPointerCapture(e.pointerId); } catch {}
  startGesture(e);
  gesture.pin = pts.size === 1 && e.target.closest?.('#pins button');
  if (pts.size === 2) gesture.tap2 = performance.now();   // two-finger tap = zoom out (cleared when the fingers move)
}
function resetPointers() { pts.clear(); gesture = null; canvas.classList.remove('dragging'); }
canvas.addEventListener('pointerdown', down);
pinsEl.addEventListener('pointerdown', down);
const tmp = { p: new THREE.Vector3(), yaw: 0, pitch: 0, zoom: 1 };
addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId) || !gesture) return;
  const q = pts.get(e.pointerId);
  if (Math.hypot(e.clientX - q.x0, e.clientY - q.y0) > 10) gesture.tap2 = 0;
  q.x = e.clientX; q.y = e.clientY;
  const g = gesture;
  if (g.kind === 'two' && pts.size >= 2) {
    const [a, b] = [...pts.values()], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    T.zoom = rubber(g.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(g.d, 1), LIM.zoom);
    let da = Math.atan2(b.y - a.y, b.x - a.x) - g.ang;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    T.yaw = rubber(g.yaw - da / deg, LIM.yaw);
    if (g.hit) {   // the ground that was between the fingers stays between the fingers
      Object.assign(tmp, { yaw: T.yaw, pitch: T.pitch, zoom: T.zoom }); tmp.p.copy(g.p);
      const h = hitPlane(mx, my, pose(tmp, dragCam), g.p.z);
      if (h) T.p.copy(rubberPivot(g.p.clone().add(g.hit).sub(h), T.zoom));
    }
    return;
  }
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  if (!g.moved && Math.hypot(dx, dy) < 6) return;
  g.moved = true; canvas.classList.add('dragging');
  if (g.kind === 'rot') {
    T.yaw = rubber(g.yaw - dx * .08, LIM.yaw);
    T.pitch = rubber(g.pitch + dy * .06, LIM.pitch);
  } else if (g.hit) {
    const h = hitPlane(e.clientX, e.clientY, pose(Object.assign(tmp, { yaw: g.yaw, pitch: g.pitch, zoom: T.zoom, p: tmp.p.copy(g.p) }), dragCam), g.p.z);
    if (h) T.p.copy(rubberPivot(g.p.clone().add(g.hit).sub(h), T.zoom));
  }
});
function endPointer(e) {
  if (!pts.has(e.pointerId)) return;   // a finger on the card or menu: not ours
  const g = gesture;
  pts.delete(e.pointerId);
  if (g?.tap2 && e.type === 'pointerup' && pts.size === 0 && performance.now() - g.tap2 < 350) {   // two-finger tap: zoom out about the fingers
    zoomAbout(e.clientX, e.clientY, T.zoom / 2.2);
    canvas.classList.remove('dragging'); gesture = null; return;
  }
  if (g && !g.moved && e.type === 'pointerup' && pts.size === 0) {
    const now = performance.now();
    if (g.pin) { lastTap = null; openCluster(g.pin.cluster); }
    else if (lastTap && now - lastTap.t < 330 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {   // double tap / double click
      lastTap = null;
      zoomAbout(e.clientX, e.clientY, T.zoom >= LIM.zoom[1] - .01 ? 1 : T.zoom * 2.2);
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      closeCard(false);   // tap on the map: put the card away, stay here
    }
  }
  canvas.classList.remove('dragging');
  gesture = null;
  if (pts.size === 1) { const [p] = pts.values(); startGesture({ clientX: p.x, clientY: p.y, button: 0 }); gesture.moved = true; gesture.tap2 = g?.tap2; }
}
addEventListener('pointerup', endPointer);
addEventListener('pointercancel', endPointer);
addEventListener('blur', resetPointers);   // app switch / system gesture mid-touch: start clean
document.addEventListener('visibilitychange', resetPointers);
let wheelTimer = 0;
function wheel(e) {
  e.preventDefault();
  cancelFlight();
  const z0 = T.zoom;
  const h = hitPlane(e.clientX, e.clientY, pose(T, dragCam), T.p.z);   // zoom toward the cursor: this ground point stays put
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  T.zoom = rubber(T.zoom * Math.exp(-dy * (e.ctrlKey ? .01 : .0025)), LIM.zoom);   // ctrlKey: trackpad pinch
  if (h) T.p.copy(rubberPivot(T.p.clone().lerp(h, 1 - z0 / T.zoom), T.zoom));
  wheelTimer = performance.now();
}
canvas.addEventListener('wheel', wheel, { passive: false });
pinsEl.addEventListener('wheel', wheel, { passive: false });
for (const ev of ['gesturestart', 'gesturechange']) addEventListener(ev, (e) => e.preventDefault());   // Safari: no page zoom

// ---------- water hook (see the comment at the top and WATER-CONTRACT.md) ----------
const waterMeshes = [];
root.traverse((o) => { if (o.isMesh && kindOf(o) === 'water') waterMeshes.push(o); });
let water = null;
if (Q.get('water') !== '0') {
  try {
    const mod = await import('./water.js');
    water = await mod.createWater({ THREE, renderer, scene: world, camera, root, waterMeshes, uniforms: U, projector: projCam, depthTexture: depthRT.depthTexture,
      box, tableZ, tile, target0, metresPerTexel: mppD, small, FPS, shader: { COMMON, TONE } });
    if (water?.mesh) { world.add(water.mesh); if (!water.keepOriginal) waterMeshes.forEach((m) => { m.visible = false; }); }
  } catch (e) { console.info('water.js niet gebruikt, het oude water blijft:', e.message); water = null; }
}
function dropWater(e) {
  console.warn('water.js gaf een fout, terug naar het oude water:', e.message);
  try { if (water?.mesh) world.remove(water.mesh); water?.dispose?.(); } catch {}
  waterMeshes.forEach((m) => { m.visible = true; });
  water = null;
}
// lights hook: same ctx/state as water; ./lights.js exports createLights(ctx) -> { group, update(dt, state), dispose }; any error = no lights
let lights = null;
if (Q.get('lights') !== '0') {
  try {
    const mod = await import('./lights.js');
    lights = await mod.createLights({ THREE, renderer, scene: world, camera, root, waterMeshes, uniforms: U, projector: projCam, depthTexture: depthRT.depthTexture,
      box, tableZ, tile, target0, metresPerTexel: mppD, small, FPS, shader: { COMMON, TONE } });
    if (lights?.group) world.add(lights.group);
  } catch (e) { console.info('lights.js niet gebruikt:', e.message); lights = null; }
}
const ws = { time: 0, dt: 0, tick: 0, clock: 0, sunDir: new THREE.Vector3(), sunElevation: 0, day: 1, keyColor: U.uKeyCol.value, fillColor: U.uFillCol.value,
  ambient: U.uAmb.value, fillDir: U.uFillDir.value, rain: 0, camera, zoom: 1 };

// ---------- loop: renders only when something changed (camera, the 8 fps stop-motion clock, tiles, water) ----------
let day = 1, sunEl = 0;
function updateLight(tick) {
  const ph = phaseAt(clock);
  const [az, el] = sunAt(ph.clock);
  day = THREE.MathUtils.smoothstep(el, -3, 1); sunEl = el;
  const key = dirOf(az + Math.sin(tick * 2.1) * .4 * (1 - U.uCalm.value), Math.max(el, 4)).lerp(dirOf(200, 35), 1 - day).normalize();   // moon at night
  const fill = new THREE.Vector3(0, 0, 1).addScaledVector(key.clone().setZ(0), -.35).normalize();               // sky, opposite the sun
  rain += ((rainOn ? 1 : 0) - rain) * .35;
  const r = rain;
  U.uKeyW.value.copy(lmWeights(key)); U.uFillW.value.copy(lmWeights(fill));
  U.uKeyDir.value.copy(key); U.uFillDir.value.copy(fill);
  U.uKeyCol.value.set(...ph.key.slice(0, 3)).multiplyScalar(ph.key[3] * (1 - .62 * r)).lerp(new THREE.Vector3(.55, .6, .7).multiplyScalar(ph.key[3] * .38), r * .6);
  U.uFillCol.value.set(...ph.fill.slice(0, 3)).multiplyScalar(ph.fill[3] * (1 + .5 * r));
  U.uAmb.value.set(...ph.amb).multiplyScalar(1 + .6 * r).add(new THREE.Vector3(0, .004, .012).multiplyScalar(r));
  U.uWin.value = Math.min(1, ph.win + r * .25 * (1 - day) + r * .06);
  U.uSat.value = ph.sat * (1 - .2 * r); U.uExpo.value = ph.expo;
  U.uRain.value = pu.uRain.value = r;
  U.uTick.value = tick % 997;
  pu.uRainLight.value = .35 + .65 * day;
  cloudMat.uniforms.uLight.value.set(...ph.key.slice(0, 3)).multiplyScalar(.25 + .5 * day).addScalar(.15 + .25 * day).multiplyScalar(.85);
  cloudMat.uniforms.uGrey.value = r;
  placeClouds(tick);
}
let lastTick = -1, lastDeep = 0, deepLater = false, camMoved = 0, lastSig = '', lastT = performance.now(), loaded = false;
const stats = { frames: 0, renders: 0 };
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(.1, (now - lastT) / 1000); lastT = now; stats.frames++;
  const tick = Math.floor(now / 1000 * FPS);
  if (tick !== lastTick) { lastTick = tick; updateLight(tick); pu.uTick.value = tick % 997; needRender = true; }
  if (flight) stepFlight(now);
  else {
    if (!interacting() && now - wheelTimer > 250) {   // soft springs back inside the limits
      const sp = 1 - Math.exp(-dt * 7);
      T.yaw += (clampV(T.yaw, LIM.yaw) - T.yaw) * sp;
      T.pitch += (clampV(T.pitch, LIM.pitch) - T.pitch) * sp;
      T.zoom += (clampV(T.zoom, LIM.zoom) - T.zoom) * sp;
      T.p.lerp(clampPivot(T.p, T.zoom), sp);
    }
    const k = 1 - Math.exp(-dt * 16);
    C.yaw += (T.yaw - C.yaw) * k; C.pitch += (T.pitch - C.pitch) * k; C.zoom *= (T.zoom / C.zoom) ** k; C.p.lerp(T.p, k);
  }
  pose(C, camera);
  const sig = `${C.p.x.toFixed(2)},${C.p.y.toFixed(2)},${C.yaw.toFixed(3)},${C.pitch.toFixed(3)},${C.zoom.toFixed(4)}`;
  if (sig !== lastSig) { lastSig = sig; needRender = pinsDirty = true; camMoved = now; }
  cloudMat.uniforms.uFade.value = 1 - THREE.MathUtils.smoothstep(C.zoom, 1.05, 1.5);   // gone before they fill the screen as a haze
  U.uCalm.value = THREE.MathUtils.smoothstep(C.zoom, 1.3, 2.5);
  clouds.visible = cloudMat.uniforms.uFade.value > .01;
  if (deep) {
    if ((camMoved >= lastDeep || deepLater) && now - lastDeep > 300) { lastDeep = now; deepLater = deep.update(now - camMoved < 150); }
    if (deep.upload(now)) needRender = true;
  }
  if (pinsDirty) { pinsDirty = false; layoutPins(); }
  if (water) {
    Object.assign(ws, { time: now / 1000, dt, tick, clock, sunElevation: sunEl, day, rain, zoom: C.zoom }); ws.sunDir.copy(U.uKeyDir.value);
    try { if (water.update?.(dt, ws)) needRender = true; } catch (e) { dropWater(e); }
  }
  if (lights) {
    if (!water) { Object.assign(ws, { time: now / 1000, dt, tick, clock, sunElevation: sunEl, day, rain, zoom: C.zoom }); ws.sunDir.copy(U.uKeyDir.value); }
    try { if (lights.update?.(dt, ws)) needRender = true; }
    catch (e) { console.warn('lights.js gaf een fout, lampjes uit:', e.message); try { world.remove(lights.group); lights.dispose?.(); } catch {} lights = null; }
  }
  if (!needRender) return;
  needRender = false; stats.renders++;
  pu.uFocus.value = C.p.clone().project(camera).y * .5 + .5;
  renderer.setRenderTarget(sceneRT); renderer.render(world, camera);
  renderer.setRenderTarget(null); renderer.render(postScene, quadCam);
  if (!loaded) { loaded = true; $('load').classList.add('gone'); setTimeout(showHint, 900); window.kleiLoad.ready = true; dispatchEvent(new Event('klei:ready')); }
}
requestAnimationFrame(frame);
window.__viewer = { pins: () => pins.filter((b) => !b.hidden).map((b) => ({ n: b.cluster.m.length, t: b.cluster.m.map((h) => h.titel), x: b.cluster.x, y: b.cluster.y, kind: b.dataset.kind, done: b.dataset.done || '', tilt: b.cluster.tilt || 0 })),
  deep: () => deep?.state(), highlights, openCard, closeCard, data: data.base, get set() { return SET; }, T, C, LIM, setRain, toScreen: (h) => screenOf(h.world, camera),
  ground: (x, y) => { const h = hitPlane(x, y, camera, target0.z); return h ? [h.x, h.y] : [0, 0]; },
  stats, get flying() { return !!flight; }, get water() { return !!water; }, get lights() { return !!lights; }, get clock() { return clock; }, tiles: data.tiles.size };   // for tests

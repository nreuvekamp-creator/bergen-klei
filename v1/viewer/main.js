import * as THREE from 'three';
import { decode as decodePng } from 'fast-png';

const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const coarse = matchMedia('(pointer: coarse)').matches;
const FPS = 8;                                         // stop-motion rate for light, boil, grain (camera stays smooth)
const QUALITY = +(Q.get('q') || (coarse ? 0.5 : 0.75)); // light/AO/shadow pass resolution vs. render resolution
const DPR = Math.min(devicePixelRatio || 1, +(Q.get('dpr') || 1.5));
const MAX_HI = 16;

// ---------- data ----------
const loader = new THREE.TextureLoader();
const tex = (url, color) => loader.loadAsync(url).then((t) => {
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
});
const optional = (p) => p.catch(() => null);
// 16-bit PNGs (height, mask ids, lightmap) are decoded in JS: the browser would squash them to 8 bit
async function png(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  const p = decodePng(new Uint8Array(await r.arrayBuffer()));
  return { w: p.width, h: p.height, ch: p.channels ?? p.data.length / (p.width * p.height), max: 2 ** p.depth - 1, data: p.data };
}
// decoded PNG -> half-float texture (rows flipped so uv (0,0) is bottom-left like TextureLoader)
function floatTex(p, chans) {
  const out = new Uint16Array(p.w * p.h * chans), toHalf = THREE.DataUtils.toHalfFloat;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const i = (y * p.w + x) * p.ch, o = ((p.h - 1 - y) * p.w + x) * chans;
    for (let c = 0; c < chans; c++) out[o + c] = toHalf(c < p.ch ? p.data[i + c] / p.max : 1);
  }
  const t = new THREE.DataTexture(out, p.w, p.h, chans === 1 ? THREE.RedFormat : THREE.RGBAFormat, THREE.HalfFloatType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

async function loadSet(base) {
  const meta = await fetch(`${base}/meta.json`, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`${base}/meta.json ${r.status}`);
    return r.json();
  });
  // optional passes: only request what meta.passes lists (no 404s in the console)
  const has = (f) => !meta.passes || f in meta.passes;
  const opt = (f, load) => has(f) ? optional(load(`${base}/${f}`)) : null;
  const [alb, nrm, ao, hgt, lm, mask, win] = await Promise.all([
    tex(`${base}/albedo.png`, true), opt('normal.png', tex), opt('ao.png', tex),
    png(`${base}/height.png`), opt('lightmap.png', png), opt('mask.png', png), opt('windows.png', tex),
  ]);
  if (!lm && !nrm) throw new Error('lightmap.png en normal.png ontbreken allebei');
  return { base, meta, alb, nrm, ao, hgt: floatTex(hgt, 1), lm: lm && floatTex(lm, 4), maskPng: mask, win };
}

let data;
const wanted = Q.get('data') || '../renders';
try { data = await loadSet(wanted); } catch (e) {
  console.info('val terug op testdata:', e.message);
  data = await loadSet('testdata');
}
if (data.base === 'testdata') $('badge').hidden = false;

const { meta } = data;
const W = data.alb.image.width, H = data.alb.image.height;
const num = (...v) => v.find((x) => typeof x === 'number' && isFinite(x));
const cam = meta.camera || {};
const pitchDeg = num(+Q.get('pitch') || undefined, cam.pitch_down_deg, cam.pitch_deg, 35);
const P = pitchDeg * Math.PI / 180;
const camUp = new THREE.Vector3(0, Math.sin(P), Math.cos(P)), camFwd = new THREE.Vector3(0, Math.cos(P), -Math.sin(P));
// "camera frame" = x right, y away from the camera (horizontal), z up -> view space (x right, y up, z to viewer)
const toView = (s) => new THREE.Vector3(s.x, s.dot(camUp), -s.dot(camFwd));
const hMin = num(meta.height?.min, meta.height_min, 0);
const hMax = num(meta.height?.max, meta.height_max, 60);
if (meta.height_max === null) console.info('meta.json: height_min/max nog leeg, val terug op 0-60 m');
// metres per image pixel at the subject; a long-lens perspective camera is treated as ortho
const camDist = cam.position && cam.target ? Math.hypot(...cam.position.map((v, i) => v - cam.target[i])) : 0;
const mpp = num(+Q.get('mpp') || undefined, meta.meters_per_pixel, cam.ortho_scale ? cam.ortho_scale / Math.max(W, H) : undefined,
  camDist && cam.fov_x_deg ? 2 * camDist * Math.tan(cam.fov_x_deg * Math.PI / 360) / W : undefined, 0.1);
const pxScale = W / (meta.resolution?.[0] || W);   // meta pixel coordinates may be for a smaller render

// lightmap directions, in view space: meta.light_dirs.X.camera (Blender) or testdata's camera-frame dirs
const toVec = (v) => Array.isArray(v) ? new THREE.Vector3(...v) : v ? new THREE.Vector3(v.x, v.y, v.z) : null;
const lmDirs = ['R', 'G', 'B'].map((c, i) => {
  const blender = toVec(meta.light_dirs?.[c]?.camera);
  if (blender) return blender.normalize();
  const own = toVec(meta.lightmap?.dirs?.[c.toLowerCase()]) || [new THREE.Vector3(.8, 0, .6), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -.8, .6)][i];
  return toView(own.normalize());
});
const lmInv = new THREE.Matrix3().set(
  lmDirs[0].x, lmDirs[1].x, lmDirs[2].x,
  lmDirs[0].y, lmDirs[1].y, lmDirs[2].y,
  lmDirs[0].z, lmDirs[1].z, lmDirs[2].z).invert();
const lmWeights = (s) => { const w = toView(s).applyMatrix3(lmInv); return w.set(Math.max(w.x, 0), Math.max(w.y, 0), Math.max(w.z, 0)); };

// ---------- mask: 16-bit grey ids (Blender) or RGB id colours (testdata) ----------
const mp = data.maskPng;
const gray = !mp || mp.ch <= 2;
const MW = mp?.w || 1, MH = mp?.h || 1;
const maskKeys = new Uint32Array(MW * MH);
const maskRGBA = new Uint8Array(MW * MH * 4);
const keyRGB = (k) => gray ? [k >> 8, k & 255, 0] : [k >> 16, (k >> 8) & 255, k & 255];
if (mp) for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
  const i = (y * MW + x) * mp.ch;
  const k = gray ? mp.data[i] : (mp.data[i] << 16) | (mp.data[i + 1] << 8) | mp.data[i + 2];
  maskKeys[y * MW + x] = k;
  maskRGBA.set([...keyRGB(k), 255], ((MH - 1 - y) * MW + x) * 4);
}
const maskTex = new THREE.DataTexture(maskRGBA, MW, MH, THREE.RGBAFormat);
maskTex.minFilter = maskTex.magFilter = THREE.NearestFilter;
maskTex.needsUpdate = true;
const maskAt = (ix, iy) => maskKeys[Math.floor(iy * MH / H) * MW + Math.floor(ix * MW / W)] || 0;

const parseKey = (c) => {
  if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) return parseInt(c.slice(1), 16);
  if (Array.isArray(c)) { const v = c.every((x) => x <= 1) ? c.map((x) => Math.round(x * 255)) : c; return (v[0] << 16) | (v[1] << 8) | v[2]; }
  return null;
};
const buildings = Object.entries(meta.buildings || meta.mask_ids || {}).map(([id, b]) => ({
  id, ...b, name: b.naam || b.name || '', key: gray ? Number(id) : parseKey(b.color),
})).filter((b) => b.key);
{ // centroid per mask id (one scan), for highlight positions and the geo fit
  const acc = new Map();
  for (let p = 0; p < maskKeys.length; p++) {
    const k = maskKeys[p];
    if (!k) continue;
    const a = acc.get(k) || acc.set(k, [0, 0, 0]).get(k);
    a[0] += p % MW; a[1] += (p / MW) | 0; a[2]++;
  }
  for (const b of buildings) { const a = acc.get(b.key); b.px = a ? [(a[0] / a[2] + .5) * W / MW, (a[1] / a[2] + .5) * H / MH] : null; }
}
const list = (o) => Array.isArray(o) ? o : Object.values(o || {});
const pxOf = (p) => { const v = p.pixel || p.px; if (!v) return null; const xy = Array.isArray(v) ? v : [v.x, v.y]; return [xy[0] * pxScale, xy[1] * pxScale]; };
const places = [...list(meta.places), ...list(meta.landmarks), ...list(meta.offscreen)]
  .map((p) => ({ name: p.naam || p.name || '', lat: p.lat, lon: p.lon, building_id: p.building_id, px: pxOf(p) })).filter((p) => p.px);

// lat/lon -> image pixel: least-squares affine fit over everything in meta.json that has both
const geoFit = (() => {
  const pts = [...buildings, ...places].filter((p) => p.px && isFinite(p.lat) && isFinite(p.lon));
  if (pts.length < 3) return null;
  const A = new Array(9).fill(0), bx = [0, 0, 0], by = [0, 0, 0];
  const lon0 = pts.reduce((a, p) => a + p.lon, 0) / pts.length, lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  for (const p of pts) {
    const r = [(p.lon - lon0) * 1e3, (p.lat - lat0) * 1e3, 1];   // centred: raw degrees make the normal equations ill-conditioned
    for (let i = 0; i < 3; i++) { bx[i] += r[i] * p.px[0]; by[i] += r[i] * p.px[1]; for (let j = 0; j < 3; j++) A[i * 3 + j] += r[i] * r[j]; }
  }
  const inv = new THREE.Matrix3().fromArray(A).invert();    // symmetric, so row/column order does not matter
  if (!inv.elements.every(isFinite) || inv.determinant() === 0) return null;
  const cx = new THREE.Vector3(...bx).applyMatrix3(inv), cy = new THREE.Vector3(...by).applyMatrix3(inv);
  return (lat, lon) => { const a = (lon - lon0) * 1e3, b = (lat - lat0) * 1e3; return [cx.x * a + cx.y * b + cx.z, cy.x * a + cy.y * b + cy.z]; };
})();

// ---------- highlights (highlights.json) ----------
const hlFile = await fetch('highlights.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({ items: [] }));
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const byName = (arr, n) => n && (arr.find((x) => norm(x.name) === norm(n)) || arr.find((x) => x.name && norm(x.name).includes(norm(n))));
const highlights = [];
for (const it of hlFile.items || []) {
  let b = it.mask_id != null ? buildings.find((x) => x.id === String(it.mask_id))
    : buildings.find((x) => it.plek && norm(x.name) === norm(it.plek));
  const pl = !b && byName(places, it.plek);
  if (!b && pl && pl.building_id != null) b = buildings.find((x) => x.id === String(pl.building_id));
  if (b && !b.px) b = null;   // building not visible in this mask
  const px = b?.px || pl?.px || (geoFit && isFinite(it.lat) ? geoFit(it.lat, it.lon) : it.pixel);
  const inImg = px && px[0] >= 0 && px[0] < W && px[1] >= 0 && px[1] < H;
  if (!inImg) { console.info('highlight niet in beeld, overgeslagen:', it.titel); continue; }   // only places inside the diorama
  highlights.push({ ...it, kind: b ? 'mask' : 'pixel', key: b?.key, px, inImg });
}
highlights.splice(MAX_HI);

// ---------- time of day: two directional lights per mood (key + fill) + ambient ----------
// az: 0 = light from the camera side, 90 = from the right; el = elevation. Colours already include intensity.
const PHASES = [
  { name: 'Ochtend',    clock: 8,    key: [20, 18, 1.0, .80, .60, 1.5], fill: [60, 70, .45, .58, .90, .55], amb: [.12, .14, .19], win: 0 },
  { name: 'Middag',     clock: 13,   key: [35, 55, 1.0, .95, .86, 1.35], fill: [0, 80, .50, .62, .90, .32], amb: [.10, .12, .16], win: 0 },
  { name: 'Gouden uur', clock: 19.5, key: [80, 11, 1.0, .58, .27, 2.1], fill: [10, 60, .45, .50, .80, .55], amb: [.10, .10, .17], win: .06 },
  { name: 'Schemer',    clock: 21.5, key: [88, 3, 1.0, .42, .33, 1.0],  fill: [20, 60, .35, .33, .75, .55], amb: [.07, .07, .14], win: .55 },
  { name: 'Nacht',      clock: 24,   key: [30, 50, .40, .52, 1.0, .30], fill: [70, 40, .16, .20, .50, .12], amb: [.015, .025, .07], win: 1 },
];
const lerp = (a, b, t) => a + (b - a) * t;
const mixArr = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
function phaseAt(t) {
  const i = Math.min(Math.floor(t), PHASES.length - 2), f = THREE.MathUtils.smoothstep(t - i, 0, 1);
  const a = PHASES[i], b = PHASES[i + 1];
  return { key: mixArr(a.key, b.key, f), fill: mixArr(a.fill, b.fill, f), amb: mixArr(a.amb, b.amb, f), win: lerp(a.win, b.win, f), clock: lerp(a.clock, b.clock, t - i) };
}
const dirOf = (az, el) => { const a = az * Math.PI / 180, e = el * Math.PI / 180; return new THREE.Vector3(Math.sin(a) * Math.cos(e), -Math.cos(a) * Math.cos(e), Math.sin(e)); };

// ---------- GL ----------
const canvas = $('c');
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }); }
catch (e) { $('err').hidden = false; $('err').textContent = 'WebGL is niet beschikbaar op dit apparaat.'; throw e; }
renderer.setPixelRatio(DPR);
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = (mat) => { const s = new THREE.Scene(); s.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)); return s; };
const winUniforms = () => ({
  tNrm: { value: data.nrm }, tWinTex: { value: data.win }, uHasNrm: { value: !!data.nrm }, uHasWinTex: { value: !!data.win },
  uImg: { value: new THREE.Vector2(W, H) }, uMpp: { value: mpp }, uWin: { value: 0 }, uUpV: { value: toView(new THREE.Vector3(0, 0, 1)) },
});
const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }';
const WIN = `
// fixed rectangular windows: only on camera-facing vertical facades, pane fully inside one building id
float facadeAt(vec2 uv){
  if (!uHasNrm) return 1.;
  vec3 n = normalize(texture(tNrm, uv).xyz * 2. - 1.);
  return step(abs(dot(n, uUpV)), .3) * step(.35, n.z);
}
bool sameId(vec2 uv, vec3 m){ return distance(texture(tMask, uv).rgb, m) < .001; }
float windowAt(vec2 uv){
  vec3 m = texture(tMask, uv).rgb;
  if (m.r + m.g + m.b < .5 / 255. || m.r > 249.5 / 255.) return 0.;   // no building (ids >= 65001 = terrain/water/trees)
  vec2 px = uv * uImg;
  if (uHasWinTex) return texture(tWinTex, uv).r * step(hash(floor(px / 8.) + m.rg * 97.), .6);
  vec2 cs = max(vec2(1.6, 2.4) / uMpp, vec2(5., 6.));                // window cell in render px (never sub-pixel)
  vec2 c = floor(px / cs), l = fract(px / cs);
  vec2 a = (c + vec2(.26, .2)) * cs / uImg, b = (c + vec2(.74, .74)) * cs / uImg;
  if (!sameId(a, m) || !sameId(b, m) || !sameId(vec2(a.x, b.y), m) || !sameId(vec2(b.x, a.y), m)) return 0.;
  if (facadeAt(a) * facadeAt(b) * facadeAt(uv) < .5) return 0.;
  float on = step(hash(c + m.rg * 97.), .42);                         // fixed per window: on or off, no flicker
  float e = .9 / cs.x;
  return on * smoothstep(.26, .26 + e, l.x) * smoothstep(.74, .74 - e, l.x) * smoothstep(.2, .2 + e, l.y) * smoothstep(.74, .74 - e, l.y);
}`;
const COMMON = `
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }`;

const litW = Math.round(Math.min(W * QUALITY, 1600)), litH = Math.round(litW * H / W);
const litRT = new THREE.WebGLRenderTarget(litW, litH, {
  generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
});

// Pass A (image space, low res, only on stop-motion ticks): lightmap/normal lighting, heightmap AO + soft shadow, night windows.
const lightMat = new THREE.ShaderMaterial({
  vertexShader: VERT,
  uniforms: {
    tAlb: { value: data.alb }, tLm: { value: data.lm }, tH: { value: data.hgt },
    tAO: { value: data.ao }, tMask: { value: maskTex }, ...winUniforms(),
    uHasLm: { value: !!data.lm }, uHasAO: { value: !!data.ao },
    uHRange: { value: hMax - hMin },
    uKeyW: { value: new THREE.Vector3() }, uFillW: { value: new THREE.Vector3() },
    uKeyV: { value: new THREE.Vector3() }, uFillV: { value: new THREE.Vector3() },
    uKeyCol: { value: new THREE.Vector3() }, uFillCol: { value: new THREE.Vector3() }, uAmb: { value: new THREE.Vector3() },
    uShadowStep: { value: new THREE.Vector2() }, uShadowDz: { value: 0 }, uTick: { value: 0 },
  },
  fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tAlb, tLm, tH, tAO;
uniform sampler2D tNrm, tMask, tWinTex;
uniform bool uHasNrm, uHasWinTex;
uniform vec2 uImg;
uniform float uMpp, uWin;
uniform vec3 uUpV;

uniform bool uHasLm, uHasAO;
uniform vec2 uShadowStep;
uniform vec3 uKeyW, uFillW, uKeyV, uFillV, uKeyCol, uFillCol, uAmb;
uniform float uHRange, uShadowDz, uTick;
${COMMON}
${WIN}
float Hm(vec2 uv){ return texture(tH, uv).r * uHRange; }
vec3 aces(vec3 x){ return clamp(x * (2.51 * x + .03) / (x * (2.43 * x + .59) + .14), 0., 1.); }
void main(){
  float boil = mod(uTick, 3.);                       // 3 fixed boil variants in a cycle (hand-made feel)
  vec2 px = vUv * uImg;
  vec2 wob = vec2(vnoise(px / 11. + boil * 17.), vnoise(px / 11. + boil * 17. + 31.)) - .5;
  vec2 uv = vUv + wob * 1.3 / uImg;                  // ~0.6 px clay wobble
  vec3 alb = texture(tAlb, uv).rgb * (1. + (vnoise(px / 2.5 + boil * 7.3) - .5) * .07);
  float h0 = Hm(uv);

  // AO from the heightmap: higher neighbours occlude (2 rings x 8)
  float occ = 0.;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * .785 + boil * .26;
    vec2 d = vec2(cos(a), sin(a)) / uImg / uMpp;
    occ += clamp((Hm(uv + d * 1.2) - h0) / 1.2, 0., 1.) + .7 * clamp((Hm(uv + d * 4.) - h0) / 4., 0., 1.);
  }
  float ao = 1. - clamp(occ / 11., 0., .65);
  if (!uHasLm && uHasAO) ao *= texture(tAO, uv).r;

  vec3 lm = vec3(0.); vec3 n = vec3(0., 0., 1.);
  float k, f, wall;
  if (uHasLm) { lm = texture(tLm, uv).rgb / .8;   // baked on 0.8-grey clay
    k = dot(uKeyW, lm); f = dot(uFillW, lm); wall = smoothstep(.08, .3, max(lm.r, lm.b) - lm.g); }
  else { n = normalize(texture(tNrm, uv).xyz * 2. - 1.); k = max(dot(n, uKeyV), 0.) * ao; f = max(dot(n, uFillV), 0.); wall = 1. - smoothstep(.35, .65, n.y); }

  // soft screen-space shadow: march toward the key light over the heightfield
  float sh = 1.;
  if (uShadowDz > 0.) {
    float t = .5;
    for (int i = 0; i < 26; i++) {
      vec2 p = uv + uShadowStep * t;
      if (p.x < 0. || p.y < 0. || p.x > 1. || p.y > 1.) break;
      float d = Hm(p) - (h0 + uShadowDz * t) - .5;
      if (d > 0. && d < 18.) sh = min(sh, clamp(1. - d / (.14 * t), 0., 1.));
      t *= 1.17;
    }
  }

  vec3 col = alb * (uKeyCol * k * sh + uFillCol * f + uAmb * ao);

  // night: lamp spill on facades + soft windows (pass B adds the crisp panes); alpha feeds the bloom
  vec3 m = texture(tMask, vUv).rgb;
  float bld = step(.5 / 255., m.r + m.g + m.b) * step(m.r, 249.5 / 255.);
  col += alb * vec3(1., .6, .3) * bld * facadeAt(uv) * uWin * .08;
  float em = windowAt(vUv) * uWin;
  col += vec3(1., .62, .3) * em * .9;
  col = mix(vec3(dot(col, vec3(.2126, .7152, .0722))), col, 1.12);   // a touch more saturated, like painted clay
  col = pow(aces(col * 1.05), vec3(1. / 2.2));
  gl_FragColor = vec4(col, clamp(em, 0., 1.));
}`,
});
const lightScene = quad(lightMat);

// Pass B (screen, every frame): smooth pan/zoom -> bloom -> tilt-shift DOF -> chromatic aberration -> highlights -> vignette -> grain
const css = getComputedStyle(document.documentElement);
const cssColor = (v) => new THREE.Color(css.getPropertyValue(v).trim());
const postMat = new THREE.ShaderMaterial({
  vertexShader: VERT,
  uniforms: {
    tLit: { value: litRT.texture }, tMask: { value: maskTex }, ...winUniforms(),
    uCenter: { value: new THREE.Vector2(.5, .5) }, uSpan: { value: new THREE.Vector2(1, 1) },
    uScreen: { value: new THREE.Vector2() }, uLit: { value: new THREE.Vector2(litW, litH) },
    uFocus: { value: .5 }, uDof: { value: 1 }, uTick: { value: 0 }, uTime: { value: 0 }, uSel: { value: -1 },
    uHiCol: { value: Array.from({ length: MAX_HI }, () => new THREE.Vector3()) },
    uHiPos: { value: Array.from({ length: MAX_HI }, () => new THREE.Vector4()) }, uHiN: { value: 0 },
    uAccent: { value: cssColor('--accent') }, uAccent2: { value: cssColor('--accent-samen') }, uPaper: { value: cssColor('--paper') },
  },
  fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tLit;
uniform sampler2D tNrm, tMask, tWinTex;
uniform bool uHasNrm, uHasWinTex;
uniform vec2 uImg;
uniform float uMpp, uWin;
uniform vec3 uUpV;

uniform vec2 uCenter, uSpan, uScreen, uLit;
uniform float uFocus, uDof, uTick, uTime;
uniform int uSel, uHiN;
uniform vec3 uHiCol[${MAX_HI}], uAccent, uAccent2, uPaper;
uniform vec4 uHiPos[${MAX_HI}];   // xy = image uv, z = 0 mask / 1 spot, w = category (0 toerist, 1 samen, -1 filtered out)
${COMMON}
${WIN}
vec4 lit(vec2 uv, float lod){ return textureLod(tLit, uv, lod); }
void main(){
  vec2 uv = uCenter + (vUv - .5) * uSpan;
  float base = max(log2(uSpan.x * uLit.x / uScreen.x), 0.);   // mip that matches screen density
  // bloom first (window glow lives in alpha)
  vec3 bloom = vec3(1., .62, .32) * (lit(uv, base + 2.5).a * .9 + lit(uv, base + 4.5).a * .9);
  // tilt-shift DOF: sharp band around the focus line, blur grows above/below
  float dist = abs(uv.y - uFocus);
  float blur = smoothstep(.2, .7, dist);   // wide sharp band, soft falloff
  float lod = base + uDof * 2.2 * blur;
  vec2 r = exp2(lod) * .8 / uLit;
  vec3 col = lit(uv, lod).rgb * .4 + (lit(uv + vec2(r.x, r.y), lod).rgb + lit(uv - vec2(r.x, r.y), lod).rgb
           + lit(uv + vec2(-r.x, r.y), lod).rgb + lit(uv + vec2(r.x, -r.y), lod).rgb) * .15;
  col += bloom;
  col = mix(col, vec3(1., .74, .45), windowAt(uv) * uWin * .55 * (1. - blur));   // crisp warm panes in the sharp band
  // light chromatic aberration toward the edges (~1 px)
  vec2 ca = (vUv - .5) * 2.4 / uScreen * uSpan * uScreen / uScreen.y;
  col.r = mix(col.r, lit(uv + ca, lod + .5).r + bloom.r, .65);
  col.b = mix(col.b, lit(uv - ca, lod + .5).b + bloom.b, .65);

  // highlights: pulsing rim around masked buildings, ring around pixel spots
  vec2 e = 2. * uSpan / uScreen;
  vec3 m0 = texture(tMask, uv).rgb, m1 = texture(tMask, uv + vec2(e.x, 0)).rgb, m2 = texture(tMask, uv - vec2(e.x, 0)).rgb,
       m3 = texture(tMask, uv + vec2(0, e.y)).rgb, m4 = texture(tMask, uv - vec2(0, e.y)).rgb;
  vec2 e2 = e * 3.5;   // wider taps for a soft outer halo
  vec3 h1 = texture(tMask, uv + e2).rgb, h2 = texture(tMask, uv - e2).rgb, h3 = texture(tMask, uv + vec2(e2.x, -e2.y)).rgb, h4 = texture(tMask, uv + vec2(-e2.x, e2.y)).rgb;
  float glow = 0.; vec3 gcol = vec3(0.);
  for (int i = 0; i < ${MAX_HI}; i++) {
    if (i >= uHiN) break;
    if (uHiPos[i].w < 0.) continue;
    float g = 0.;
    float pulse = .5 + .5 * sin(uTime * 2.2 + float(i) * 1.3);
    float sel = i == uSel ? 1. : 0.;
    vec3 c = uHiCol[i];
    if (uHiPos[i].z < .5) {
      float in0 = step(distance(m0, c), .002);
      float edge = in0 * (1. - step(distance(m1, c), .002) * step(distance(m2, c), .002) * step(distance(m3, c), .002) * step(distance(m4, c), .002));
      float halo = (1. - in0) * .25 * (step(distance(h1, c), .002) + step(distance(h2, c), .002) + step(distance(h3, c), .002) + step(distance(h4, c), .002));
      g = halo * (.35 + .35 * pulse + .3 * sel) + edge * (.45 + .45 * pulse + .4 * sel) + in0 * (.05 + .05 * pulse + .12 * sel);
    } else {
      float d = length((uv - uHiPos[i].xy) / uSpan * uScreen);
      float rr = 15. + 4. * pulse;
      g = smoothstep(2.2, 0., abs(d - rr)) * (.6 + .3 * pulse + .4 * sel) + smoothstep(6., 2., d) * .9 + smoothstep(rr + 14., 0., d) * .08;
    }
    glow += g; gcol += g * (uHiPos[i].w > .5 ? uAccent2 : uAccent);
  }
  if (glow > 0.) col = mix(col, gcol / glow, clamp(glow, 0., 1.) * .85) + gcol * .15;

  float inside = step(0., uv.x) * step(uv.x, 1.) * step(0., uv.y) * step(uv.y, 1.);
  col = mix(uPaper, col, inside);
  vec2 v = (vUv - .5) * vec2(uScreen.x / uScreen.y, 1.);
  col *= mix(.7, 1., smoothstep(1.05, .35, length(v)));            // vignette
  col += (hash(floor(vUv * uScreen) + uTick * 17.31) - .5) * .055;   // grain on the stop-motion clock
  gl_FragColor = vec4(col, 1.);
}`,
});
const postScene = quad(postMat);
highlights.forEach((h, i) => {
  if (h.kind === 'mask') postMat.uniforms.uHiCol.value[i].set(...keyRGB(h.key).map((c) => c / 255));
  if (h.px) postMat.uniforms.uHiPos.value[i].set(h.px[0] / W, 1 - h.px[1] / H, h.kind === 'mask' ? 0 : 1, 0);
});
// categories: subtle colour difference + filter chips
const CATS = { toerist: 'Toeristisch', samen: 'Samen' };
const catOf = (h) => (h.categorie in CATS ? h.categorie : 'toerist');
const showCat = { toerist: true, samen: true };
const visible = (h) => showCat[catOf(h)];
function syncHighlights() {
  highlights.forEach((h, i) => { postMat.uniforms.uHiPos.value[i].w = visible(h) ? (catOf(h) === 'samen' ? 1 : 0) : -1; });
}
for (const [cat, label] of Object.entries(CATS)) {
  const b = Object.assign(document.createElement('button'), { className: `chip ${cat}`, textContent: label });
  b.setAttribute('aria-pressed', 'true');
  b.onclick = () => {
    showCat[cat] = !showCat[cat];
    b.setAttribute('aria-pressed', String(showCat[cat]));
    syncHighlights();
    if (selected >= 0 && !visible(highlights[selected])) closeCard();
  };
  $('legend').append(b);
}
syncHighlights();
postMat.uniforms.uHiN.value = highlights.length;

// ---------- view (smooth pan/zoom; image uv, y up) ----------
const view = { cx: .5, cy: .5, s: 1, tcx: .5, tcy: .5, ts: 1, focus: .55, tfocus: .55 };
{ // start with the buildings in focus (mean of mask centroids), else the middle
  const ys = buildings.filter((b) => b.px).map((b) => b.px[1]);
  if (ys.length) view.focus = view.tfocus = 1 - ys.reduce((a, y) => a + y, 0) / ys.length / H;
}
let sw = 1, sh = 1;
if (highlights[0]) { view.cx = view.tcx = highlights[0].px[0] / W; view.cy = view.tcy = 1 - highlights[0].px[1] / H; }   // start on the first place (matters on narrow screens)
function span(s) {
  const ia = W / H, sa = sw / sh;   // "cover" fit
  return sa > ia ? [1 / s, ia / sa / s] : [sa / ia / s, 1 / s];
}
function clampCenter(cx, cy, s) {
  const [ax, ay] = span(s);
  return [THREE.MathUtils.clamp(cx, ax / 2, 1 - ax / 2), THREE.MathUtils.clamp(cy, ay / 2, 1 - ay / 2)];
}
function resize() {
  sw = innerWidth; sh = innerHeight;
  renderer.setSize(sw, sh, false);
  postMat.uniforms.uScreen.value.set(sw * DPR, sh * DPR);
}
addEventListener('resize', resize);
resize();
const screenToImg = (x, y) => {
  const [ax, ay] = span(view.s);
  return [view.cx + (x / sw - .5) * ax, view.cy + (.5 - y / sh) * ay];
};

// ---------- UI: time ----------
const slider = $('slider');
// default: follow the real time in Bergen (unless ?t= is given or the slider is touched)
function bergenT() {
  const [h, m] = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/Oslo', hour12: false }).split(':').map(Number);
  const c = h + m / 60;
  if (c < 6) return 4;
  if (c < 8) return 0;
  for (let i = 0; i < PHASES.length - 1; i++) if (c <= PHASES[i + 1].clock) return i + (c - PHASES[i].clock) / (PHASES[i + 1].clock - PHASES[i].clock);
  return 4;
}
let touched = Q.has('t');
slider.value = Q.get('t') ?? bergenT();
slider.addEventListener('input', () => { touched = true; });
setInterval(() => { if (!touched) { slider.value = bergenT(); updateLabel(); } }, 60000);
PHASES.forEach((p, i) => {
  const b = Object.assign(document.createElement('button'), { textContent: p.name });
  b.onclick = () => { touched = true; slider.value = i; updateLabel(); };
  $('stops').append(b);
});
function updateLabel() {
  const t = +slider.value, i = Math.round(t);
  $('phase').textContent = PHASES[i].name;
  [...$('stops').children].forEach((b, k) => b.classList.toggle('on', k === i));
  const c = phaseAt(t).clock % 24;
  $('clock').textContent = `${String(Math.floor(c)).padStart(2, '0')}:${String(Math.floor((c % 1) * 60 / 5) * 5).padStart(2, '0')}`;
}
slider.addEventListener('input', updateLabel);
updateLabel();

// ---------- UI: card ----------
let selected = -1;
function openCard(h, i) {
  selected = i;
  $('card-title').textContent = h.titel || h.name || 'Plek';
  $('card-text').textContent = h.tekst || '';
  const weer = { regen: 'ook bij regen', zon: 'bij droog weer' }[h.weer];
  $('card-meta').textContent = [h.kosten, weer].filter(Boolean).join(', ');
  $('card-meta').hidden = !$('card-meta').textContent;
  const cat = $('card-cat');
  cat.hidden = i < 0;
  cat.className = `chip static ${catOf(h)}`;
  cat.textContent = CATS[catOf(h)];
  const list = highlights.filter(visible);
  $('card-nav').hidden = i < 0 || list.length < 2;
  $('count').textContent = `${list.indexOf(h) + 1} van ${list.length}`;
  const img = $('card-img');
  img.hidden = !h.foto;
  if (h.foto) img.src = h.foto;
  $('card').classList.add('open');
  if (h.px && h.inImg !== false) {
    view.ts = sw < 700 ? 1.3 : 1.8;
    [view.tcx, view.tcy] = clampCenter(h.px[0] / W, 1 - h.px[1] / H - span(view.ts)[1] * .15, view.ts);  // keep spot above the card
    view.tfocus = 1 - h.px[1] / H;
  }
}
function closeCard() {
  selected = -1;
  $('card').classList.remove('open');
  view.ts = 1;
  [view.tcx, view.tcy] = clampCenter(view.tcx, view.tcy, 1);
}
$('close').onclick = closeCard;
const step = (d) => {
  const list = highlights.filter(visible);
  if (!list.length) return;
  const h = list[(list.indexOf(highlights[selected]) + d + list.length) % list.length];
  openCard(h, highlights.indexOf(h));
};
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
addEventListener('keydown', (e) => e.key === 'Escape' && closeCard());

function pick(x, y) {
  const [u, v] = screenToImg(x, y);
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  view.tfocus = v;
  const ix = u * W, iy = (1 - v) * H;
  const tapR = 30 * (span(view.s)[0] * W / sw);       // ~30 screen px in image px
  let hit = highlights.findIndex((h) => visible(h) && h.kind === 'pixel' && h.inImg && Math.hypot(h.px[0] - ix, h.px[1] - iy) < tapR);
  const key = maskAt(ix, iy);
  if (hit < 0 && key) hit = highlights.findIndex((h) => visible(h) && h.kind === 'mask' && h.key === key);
  if (hit >= 0) return openCard(highlights[hit], hit);
  const b = key && buildings.find((x) => x.key === key);
  if (b?.name) return openCard({ titel: b.name.split(';')[0], tekst: '', px: [ix, iy] }, -1);
  closeCard();
}

// pointer: drag = pan (smooth), tap = focus + pick
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: view.tcx, cy: view.tcy, moved: false }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  drag.moved = true; canvas.classList.add('dragging');
  const [ax, ay] = span(view.ts);
  [view.tcx, view.tcy] = clampCenter(drag.cx - dx / sw * ax, drag.cy + dy / sh * ay, view.ts);
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) pick(e.clientX, e.clientY);
  drag = null; canvas.classList.remove('dragging');
});
canvas.addEventListener('pointercancel', () => { drag = null; canvas.classList.remove('dragging'); });

// ---------- loop ----------
const lu = lightMat.uniforms;
function updateLight(tick) {
  const ph = phaseAt(+slider.value);
  const key = dirOf(ph.key[0], ph.key[1]), fill = dirOf(ph.fill[0], ph.fill[1]);
  key.x += Math.sin(tick * 2.1) * .006;                       // tiny per-frame light jitter (hand-placed lamp)
  key.normalize();
  lu.uKeyW.value.copy(lmWeights(key)); lu.uFillW.value.copy(lmWeights(fill));
  lu.uKeyV.value.copy(toView(key)); lu.uFillV.value.copy(toView(fill));
  lu.uKeyCol.value.set(ph.key[2], ph.key[3], ph.key[4]).multiplyScalar(ph.key[5]);
  lu.uFillCol.value.set(ph.fill[2], ph.fill[3], ph.fill[4]).multiplyScalar(ph.fill[5]);
  lu.uAmb.value.set(...ph.amb);
  // screen-space shadow step: uv per metre travelled toward the key light, plus metres of height gained
  lu.uShadowStep.value.set(key.x / mpp / W, key.dot(camUp) / mpp / H);
  lu.uShadowDz.value = key.z;
  lu.uWin.value = postMat.uniforms.uWin.value = ph.win;
  lu.uTick.value = tick;
}
let lastTick = -1;
const pu = postMat.uniforms;
function frame(now) {
  const tick = Math.floor(now / 1000 * FPS);
  if (tick !== lastTick) {
    lastTick = tick;
    updateLight(tick);
    renderer.setRenderTarget(litRT);
    renderer.render(lightScene, quadCam);
    renderer.setRenderTarget(null);
    pu.uTick.value = tick % 997;
  }
  const k = 0.14;   // smooth easing for camera and focus
  view.s += (view.ts - view.s) * k;
  view.cx += (view.tcx - view.cx) * k; view.cy += (view.tcy - view.cy) * k;
  [view.cx, view.cy] = clampCenter(view.cx, view.cy, view.s);
  view.focus += (view.tfocus - view.focus) * k;
  const [ax, ay] = span(view.s);
  pu.uCenter.value.set(view.cx, view.cy); pu.uSpan.value.set(ax, ay);
  pu.uFocus.value = view.focus; pu.uTime.value = now / 1000; pu.uSel.value = selected;
  renderer.render(postScene, quadCam);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__viewer = { highlights, openCard, closeCard, data: data.base, litSize: [litW, litH],
  toScreen: (px) => { const [ax, ay] = span(view.s); return [((px[0] / W - view.cx) / ax + .5) * sw, (.5 - (1 - px[1] / H - view.cy) / ay) * sh]; } };   // for tests

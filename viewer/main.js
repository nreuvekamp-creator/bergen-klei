import * as THREE from 'three';

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

async function loadSet(base) {
  const meta = await fetch(`${base}/meta.json`, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`${base}/meta.json ${r.status}`);
    return r.json();
  });
  const [alb, lm, nrm, hgt, ao, mask] = await Promise.all([
    tex(`${base}/albedo.png`, true), optional(tex(`${base}/lightmap.png`)), optional(tex(`${base}/normal.png`)),
    tex(`${base}/height.png`), optional(tex(`${base}/ao.png`)), tex(`${base}/mask.png`),
  ]);
  if (!lm && !nrm) throw new Error('lightmap.png en normal.png ontbreken allebei');
  return { base, meta, alb, lm, nrm, hgt, ao, mask };
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
const rotX = Array.isArray(cam.rotation_euler) ? cam.rotation_euler[0] : undefined;
const pitchDeg = num(+Q.get('pitch') || undefined, cam.pitch_deg, rotX !== undefined ? 90 - (Math.abs(rotX) < 7 ? rotX * 180 / Math.PI : rotX) : undefined, 35);
const P = pitchDeg * Math.PI / 180;
const hMin = num(meta.height?.min, meta.height_min, meta.hoogte?.min, 0);
const hMax = num(meta.height?.max, meta.height_max, meta.hoogte?.max, 60);
// ponytail: perspective cameras are treated as ortho with this scale; fine for a long-lens diorama shot.
const mpp = num(+Q.get('mpp') || undefined, meta.meters_per_pixel, cam.ortho_scale ? cam.ortho_scale / Math.max(W, H) : undefined, 0.1);

const toVec = (v) => Array.isArray(v) ? new THREE.Vector3(...v) : v ? new THREE.Vector3(v.x, v.y, v.z) : null;
const lmDirsRaw = meta.lightmap?.dirs || meta.lightmap_dirs || meta.lightmap || {};
const lmDirs = ['r', 'g', 'b'].map((c, i) => (toVec(lmDirsRaw[c] || lmDirsRaw[c.toUpperCase()]) ||
  [new THREE.Vector3(0.8, 0, 0.6), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -0.8, 0.6)][i]).normalize());
const lmInv = new THREE.Matrix3().set(
  lmDirs[0].x, lmDirs[1].x, lmDirs[2].x,
  lmDirs[0].y, lmDirs[1].y, lmDirs[2].y,
  lmDirs[0].z, lmDirs[1].z, lmDirs[2].z).invert();

// mask colours: "#rrggbb", [r,g,b] (0-1 or 0-255), or a hex key
const parseRGB = (c) => {
  if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c)) { const h = c.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
  if (Array.isArray(c)) return c.every((x) => x <= 1) ? c.slice(0, 3).map((x) => Math.round(x * 255)) : c.slice(0, 3).map(Math.round);
  return null;
};
const buildings = Object.entries(meta.buildings || meta.mask_ids || meta.mask || meta.ids || {}).map(([id, b]) => ({
  id, ...b, name: b.naam || b.name || '', rgb: parseRGB(b.color ?? b.kleur ?? b.mask_color ?? id),
})).filter((b) => b.rgb);
const pxOf = (p) => p.pixel || p.px || (p.x !== undefined ? [p.x, p.y] : null);
const places = (meta.places || meta.plekken || meta.landmarks || []).map((p) => ({ name: p.naam || p.name || p.titel, px: pxOf(p) })).filter((p) => p.px);

// mask pixels on a canvas, for picking and highlight centroids
const maskCtx = Object.assign(document.createElement('canvas'), { width: W, height: H }).getContext('2d', { willReadFrequently: true });
maskCtx.drawImage(data.mask.image, 0, 0, W, H);
const sameRGB = (a, b) => a && b && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 6;
const maskAt = (x, y) => [...maskCtx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data.slice(0, 3)];

// ---------- highlights (highlights.json) ----------
{ // centroid per mask colour (one full scan), used for highlight positions and the geo fit
  const d = maskCtx.getImageData(0, 0, W, H).data, acc = new Map();
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    if (!key) continue;
    const a = acc.get(key) || acc.set(key, [0, 0, 0]).get(key);
    a[0] += p % W; a[1] += (p / W) | 0; a[2]++;
  }
  for (const b of buildings) {
    const a = acc.get((b.rgb[0] << 16) | (b.rgb[1] << 8) | b.rgb[2]);
    b.px = a ? [a[0] / a[2], a[1] / a[2]] : null;
  }
}
// lat/lon -> image pixel: least-squares affine fit over everything in meta.json that has both
const geoFit = (() => {
  const pts = [...buildings, ...(meta.places || meta.plekken || meta.landmarks || []).map((p) => ({ ...p, px: pxOf(p) }))]
    .filter((p) => p.px && isFinite(p.lat) && isFinite(p.lon));
  if (pts.length < 3) return null;
  const A = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0).elements, bx = [0, 0, 0], by = [0, 0, 0];
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

const hlFile = await fetch('highlights.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({ items: [] }));
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const byName = (list, n) => n && (list.find((x) => norm(x.name) === norm(n)) || list.find((x) => x.name && norm(x.name).includes(norm(n))));
const highlights = [];
for (const it of hlFile.items || []) {
  const b = it.mask_id != null ? buildings.find((x) => x.id === String(it.mask_id))
    : buildings.find((x) => it.plek && norm(x.name) === norm(it.plek));
  const pl = !b && byName(places, it.plek);
  const px = b?.px || pl?.px || (geoFit && isFinite(it.lat) ? geoFit(it.lat, it.lon) : it.pixel);
  if (!px) { console.info('highlight zonder positie:', it.titel); continue; }
  const inImg = px[0] >= 0 && px[0] < W && px[1] >= 0 && px[1] < H;
  highlights.push({ ...it, kind: b ? 'mask' : 'pixel', rgb: b?.rgb, px, inImg });
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
const camUp = new THREE.Vector3(0, Math.sin(P), Math.cos(P)), camFwd = new THREE.Vector3(0, Math.cos(P), -Math.sin(P));
const toView = (s) => new THREE.Vector3(s.x, s.dot(camUp), -s.dot(camFwd));     // camera frame -> view space (normal.png)
const lmWeights = (s) => { const w = s.clone().applyMatrix3(lmInv); return w.set(Math.max(w.x, 0), Math.max(w.y, 0), Math.max(w.z, 0)); };

// ---------- GL ----------
const canvas = $('c');
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }); }
catch (e) { $('err').hidden = false; $('err').textContent = 'WebGL is niet beschikbaar op dit apparaat.'; throw e; }
renderer.setPixelRatio(DPR);
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = (mat) => { const s = new THREE.Scene(); s.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)); return s; };
const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }';
const COMMON = `
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }`;

for (const t of [data.mask]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; }
const litW = Math.round(Math.min(W * QUALITY, 1600)), litH = Math.round(litW * H / W);
const litRT = new THREE.WebGLRenderTarget(litW, litH, {
  generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
});

// Pass A (image space, low res, only on stop-motion ticks): lightmap/normal lighting, heightmap AO + soft shadow, night windows.
const lightMat = new THREE.ShaderMaterial({
  vertexShader: VERT,
  uniforms: {
    tAlb: { value: data.alb }, tLm: { value: data.lm }, tNrm: { value: data.nrm }, tH: { value: data.hgt },
    tAO: { value: data.ao }, tMask: { value: data.mask },
    uHasLm: { value: !!data.lm }, uHasAO: { value: !!data.ao },
    uImg: { value: new THREE.Vector2(W, H) }, uHRange: { value: hMax - hMin }, uMpp: { value: mpp },
    uKeyW: { value: new THREE.Vector3() }, uFillW: { value: new THREE.Vector3() },
    uKeyV: { value: new THREE.Vector3() }, uFillV: { value: new THREE.Vector3() },
    uKeyCol: { value: new THREE.Vector3() }, uFillCol: { value: new THREE.Vector3() }, uAmb: { value: new THREE.Vector3() },
    uShadowStep: { value: new THREE.Vector2() }, uShadowDz: { value: 0 }, uWin: { value: 0 }, uTick: { value: 0 },
  },
  fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tAlb, tLm, tNrm, tH, tAO, tMask;
uniform bool uHasLm, uHasAO;
uniform vec2 uImg, uShadowStep;
uniform vec3 uKeyW, uFillW, uKeyV, uFillV, uKeyCol, uFillCol, uAmb;
uniform float uHRange, uMpp, uShadowDz, uWin, uTick;
${COMMON}
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
  if (uHasLm) { lm = texture(tLm, uv).rgb; k = dot(uKeyW, lm); f = dot(uFillW, lm); wall = smoothstep(.08, .3, max(lm.r, lm.b) - lm.g); }
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

  // night: random warm windows on building walls (mask + cell noise), slight flicker per tick
  vec3 m = texture(tMask, vUv).rgb;
  float bld = step(.02, m.r + m.g + m.b);
  vec2 cell = px * uMpp / vec2(1.4, 2.1);
  vec2 id = floor(cell) + m.rg * 97.;
  vec2 l = fract(cell);
  float pane = smoothstep(.25, .33, l.x) * smoothstep(.75, .67, l.x) * smoothstep(.2, .3, l.y) * smoothstep(.72, .62, l.y);
  float on = step(hash(id), .36) * (.8 + .2 * hash(id + uTick));
  float em = pane * on * bld * wall * uWin;
  col += alb * vec3(1., .6, .3) * bld * uWin * .1;  // lamp spill on facades
  col += vec3(1., .6, .28) * em * 1.4;
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
    tLit: { value: litRT.texture }, tMask: { value: data.mask },
    uCenter: { value: new THREE.Vector2(.5, .5) }, uSpan: { value: new THREE.Vector2(1, 1) },
    uScreen: { value: new THREE.Vector2() }, uImg: { value: new THREE.Vector2(W, H) }, uLit: { value: new THREE.Vector2(litW, litH) },
    uFocus: { value: .5 }, uDof: { value: 1 }, uTick: { value: 0 }, uTime: { value: 0 }, uSel: { value: -1 },
    uHiCol: { value: Array.from({ length: MAX_HI }, () => new THREE.Vector3()) },
    uHiPos: { value: Array.from({ length: MAX_HI }, () => new THREE.Vector4()) }, uHiN: { value: 0 },
    uAccent: { value: cssColor('--accent') }, uAccent2: { value: cssColor('--accent-samen') }, uPaper: { value: cssColor('--paper') },
  },
  fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tLit, tMask;
uniform vec2 uCenter, uSpan, uScreen, uImg, uLit;
uniform float uFocus, uDof, uTick, uTime;
uniform int uSel, uHiN;
uniform vec3 uHiCol[${MAX_HI}], uAccent, uAccent2, uPaper;
uniform vec4 uHiPos[${MAX_HI}];   // xy = image uv, z = 0 mask / 1 spot, w = category (0 toerist, 1 samen, -1 filtered out)
${COMMON}
vec4 lit(vec2 uv, float lod){ return textureLod(tLit, uv, lod); }
void main(){
  vec2 uv = uCenter + (vUv - .5) * uSpan;
  float base = max(log2(uSpan.x * uLit.x / uScreen.x), 0.);   // mip that matches screen density
  // bloom first (window glow lives in alpha)
  vec3 bloom = vec3(1., .62, .32) * (lit(uv, base + 2.5).a * .9 + lit(uv, base + 4.5).a * .9);
  // tilt-shift DOF: sharp band around the focus line, blur grows above/below
  float dist = abs(uv.y - uFocus);
  float lod = base + uDof * 3.6 * smoothstep(.06, .42, dist);
  vec2 r = exp2(lod) * .8 / uLit;
  vec3 col = lit(uv, lod).rgb * .4 + (lit(uv + vec2(r.x, r.y), lod).rgb + lit(uv - vec2(r.x, r.y), lod).rgb
           + lit(uv + vec2(-r.x, r.y), lod).rgb + lit(uv + vec2(r.x, -r.y), lod).rgb) * .15;
  col += bloom;
  // light chromatic aberration toward the edges (~1 px)
  vec2 ca = (vUv - .5) * 2.4 / uScreen * uSpan * uScreen / uScreen.y;
  col.r = mix(col.r, lit(uv + ca, lod + .5).r + bloom.r, .65);
  col.b = mix(col.b, lit(uv - ca, lod + .5).b + bloom.b, .65);

  // highlights: pulsing rim around masked buildings, ring around pixel spots
  vec2 e = 2. * uSpan / uScreen;
  vec3 m0 = texture(tMask, uv).rgb, m1 = texture(tMask, uv + vec2(e.x, 0)).rgb, m2 = texture(tMask, uv - vec2(e.x, 0)).rgb,
       m3 = texture(tMask, uv + vec2(0, e.y)).rgb, m4 = texture(tMask, uv - vec2(0, e.y)).rgb;
  float glow = 0.; vec3 gcol = vec3(0.);
  for (int i = 0; i < ${MAX_HI}; i++) {
    if (i >= uHiN) break;
    if (uHiPos[i].w < 0.) continue;
    float g = 0.;
    float pulse = .5 + .5 * sin(uTime * 2.2 + float(i) * 1.3);
    float sel = i == uSel ? 1. : 0.;
    vec3 c = uHiCol[i];
    if (uHiPos[i].z < .5) {
      float in0 = step(distance(m0, c), .02);
      float edge = in0 * (1. - step(distance(m1, c), .02) * step(distance(m2, c), .02) * step(distance(m3, c), .02) * step(distance(m4, c), .02));
      g = edge * (.45 + .45 * pulse + .4 * sel) + in0 * (.05 + .05 * pulse + .12 * sel);
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
  if (h.kind === 'mask') postMat.uniforms.uHiCol.value[i].set(...h.rgb.map((c) => c / 255));
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
slider.value = Q.get('t') ?? 2;
PHASES.forEach((p, i) => {
  const b = Object.assign(document.createElement('button'), { textContent: p.name });
  b.onclick = () => { slider.value = i; updateLabel(); };
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
  const rgb = maskAt(ix, iy);
  if (hit < 0) hit = highlights.findIndex((h) => visible(h) && h.kind === 'mask' && sameRGB(h.rgb, rgb));
  if (hit >= 0) return openCard(highlights[hit], hit);
  const b = rgb.some((c) => c > 4) && buildings.find((x) => sameRGB(x.rgb, rgb));
  if (b?.name) return openCard({ titel: b.name, tekst: b.osm_id ? `OpenStreetMap-gebouw ${b.osm_id}.` : '', px: [ix, iy] }, -1);
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
  lu.uWin.value = ph.win;
  lu.uTick.value = tick;
}
// edge arrows for highlights outside the visible part of the image (or outside the diorama altogether)
const arrows = highlights.map((h, i) => {
  const el = Object.assign(document.createElement('button'), { className: `arrow ${catOf(h)}`, hidden: true });
  el.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 10 L6 2 L10 10 Z"/></svg><span></span>';
  el.lastChild.textContent = h.titel;
  el.onclick = () => openCard(h, i);
  $('arrows').append(el);
  return el;
});
function placeArrows(ax, ay) {
  const open = selected >= 0 || $('card').classList.contains('open');
  const top = $('title').getBoundingClientRect().bottom + 10, bottom = sh - ($('time').offsetHeight + 28), left = 16, right = sw - 16;
  const shown = [];
  highlights.forEach((h, i) => {
    const x = ((h.px[0] / W - view.cx) / ax + .5) * sw, y = (.5 - (1 - h.px[1] / H - view.cy) / ay) * sh;
    const el = arrows[i];
    el.hidden = open || !visible(h) || (x > left && x < right && y > top && y < bottom);
    if (el.hidden) return;
    const mx = sw / 2, my = (top + bottom) / 2, dx = x - mx, dy = y - my;
    const tx = (dx > 0 ? right - mx : left - mx) / dx, ty = (dy > 0 ? bottom - my : top - my) / dy;
    const t = Math.min(isFinite(tx) ? tx : Infinity, isFinite(ty) ? ty : Infinity);
    const w = el.offsetWidth, hh = el.offsetHeight;
    const edge = tx < ty ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
    shown.push({ el, w, hh, edge, ang: Math.atan2(dy, dx) * 180 / Math.PI + 90,
      x: THREE.MathUtils.clamp(mx + dx * t - w / 2, left, right - w), y: THREE.MathUtils.clamp(my + dy * t - hh / 2, top, bottom - hh) });
  });
  // keep labels on the same edge from overlapping: spread along that edge
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const row = shown.filter((a) => a.edge === edge), horiz = edge === 'top' || edge === 'bottom';
    row.sort((a, b) => horiz ? a.x - b.x : a.y - b.y);
    for (let k = 1; k < row.length; k++) {
      if (horiz) row[k].x = Math.max(row[k].x, row[k - 1].x + row[k - 1].w + 6);
      else row[k].y = Math.max(row[k].y, row[k - 1].y + row[k - 1].hh + 6);
    }
    const last = row[row.length - 1];   // shift the row back if it ran off the end
    const over = last ? (horiz ? last.x + last.w - right : last.y + last.hh - bottom) : 0;
    if (over > 0) row.forEach((a) => { if (horiz) a.x = Math.max(left, a.x - over); else a.y = Math.max(top, a.y - over); });
  }
  for (const a of shown) {
    a.el.style.transform = `translate(${a.x}px, ${a.y}px)`;
    a.el.firstChild.style.transform = `rotate(${a.ang}deg)`;
  }
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
  placeArrows(ax, ay);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__viewer = { highlights, openCard, closeCard, data: data.base, litSize: [litW, litH],
  toScreen: (px) => { const [ax, ay] = span(view.s); return [((px[0] / W - view.cx) / ax + .5) * sw, (.5 - (1 - px[1] / H - view.cy) / ay) * sh]; } };   // for tests

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { decode as decodePng } from 'fast-png';

// Camera projection (DuneCrawl-style): the Blender passes are projected from the render camera onto a low-poly
// proxy (scene.glb), so panning/zooming/turning a little gives real parallax. See research-projectie/PROJECTIE.md.
const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const coarse = matchMedia('(pointer: coarse)').matches;
const small = coarse || Math.min(innerWidth, innerHeight) < 700;
const FPS = 8;                                          // stop-motion rate for light, boil, grain, rain, clouds (camera stays smooth)
const DPR = Math.min(devicePixelRatio || 1, +(Q.get('dpr') || 1.5));
const MAX_HI = 16;
let SET = Q.get('set') || 'lo';                          // start with lo everywhere; desktop swaps in hi once it has arrived
const DRACO = 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/draco/gltf/';
const deg = Math.PI / 180;

// ---------- data ----------
const loader = new THREE.TextureLoader();
const tex = (url, color) => loader.loadAsync(url).then((t) => {
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  return t;
});
const optional = (p) => p.catch(() => null);
// 16-bit PNG lightmaps are decoded in JS (the browser would squash them to 8 bit)
async function png(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  const p = decodePng(new Uint8Array(await r.arrayBuffer()));
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

// Data layout (renders-centrum and testdata): meta.json, scene.glb, ground_top.png, hi/ and lo/ with albedo, lightmap, windows.
// File names come from meta.passes when it lists them, so only existing files are requested (no 404s).
async function loadSet(base) {
  const meta = await fetch(`${base}/meta.json`, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`${base}/meta.json ${r.status}`);
    return r.json();
  });
  const names = Object.keys(meta.passes || {});
  const file = (n, ext = '.png') => names.find((k) => k.startsWith(n + '.')) || n + ext;
  const has = (n) => !meta.passes || names.some((k) => k.startsWith(n + '.'));
  const lmDesc = meta.passes?.[file('lightmap')] || '';
  const passes = (set) => {   // albedo, lightmap, windows (+ ground_top on hi) of one resolution set
    const dir = `${base}/${set}`, lmUrl = `${dir}/${file('lightmap')}`;
    return Promise.all([
      tex(`${dir}/${file('albedo')}`, true),
      /16-bit/i.test(lmDesc) ? png(lmUrl).then((p) => floatTex(p, 4)) : tex(lmUrl, /srgb/i.test(lmDesc)),
      has('windows') ? optional(tex(`${dir}/${file('windows')}`)) : null,
      has('ground_top') && set === 'hi' ? optional(tex(`${base}/${file('ground_top')}`, true)) : null,   // ponytail: phones skip it (MBs) and show plain clay in revealed strips
    ]).then(([alb, lm, win, ground]) => { if (ground) ground.flipY = false; return { alb, lm, win, ground }; });   // ground: glTF uv (top-left origin)
  };
  const gltfLoader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath(DRACO));
  const [first, gltf] = await Promise.all([passes(SET), gltfLoader.loadAsync(`${base}/${file('scene', '.glb')}`)]);
  return { base, meta, ...first, gltf, passes };
}

let data;
const wanted = Q.get('data') || '../renders-centrum';
try { data = await loadSet(wanted); } catch (e) {
  console.info('val terug op de Bryggen-testset:', e.message);
  data = await loadSet('testdata');
}
const isTest = data.base === 'testdata';
$('badge').hidden = !isTest;
if (isTest) $('sub').textContent = 'Bryggen in klei';
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
const DW = Math.min(renderer.capabilities.maxTextureSize, 4096), DH = Math.round(DW * IH / IW);
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
  uNF: { value: new THREE.Vector2(dn, df) }, uImg: { value: new THREE.Vector2(IW, IH) }, uBias: { value: 7.5 * mppD }, uCell: { value: Math.max(12, 55 * mppD) },
  uKeyW: { value: new THREE.Vector3() }, uFillW: { value: new THREE.Vector3() },
  uKeyDir: { value: new THREE.Vector3() }, uFillDir: { value: new THREE.Vector3() },
  uKeyCol: { value: new THREE.Vector3() }, uFillCol: { value: new THREE.Vector3() }, uAmb: { value: new THREE.Vector3() },
  tAlbD: { value: null }, tLmD: { value: null }, uDRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uDUse: { value: new THREE.Vector2(1, 1) }, uDOn: { value: false },
  uClip: { value: false }, uWin: { value: 0 }, uTick: { value: 0 }, uRain: { value: 0 }, uSat: { value: 1.1 }, uExpo: { value: 1.5 }, uContrast: { value: .38 },
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
uniform float uWin, uTick, uRain, uSat, uExpo, uContrast, uBias, uCell;
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
  vec2 uvw = uv + wob * 1.3 / uImg;                    // ~0.6 px clay wobble
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
  albP *= 1. + (vnoise(px / 2.5 + boil * 7.3) - .5) * .07;
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
  if (uKind == 2 && uRain > 0.) {                     // rain rings on the water, on the stop-motion clock
    vec2 q = vW.xy / uCell; vec2 c = floor(q), f = fract(q) - .5;
    float h = hash(c), t = fract(uTick / 10. + h);
    vec2 o = vec2(hash(c + 3.1), hash(c + 7.7)) - .5;
    float d = length(f - o * .5);
    float ring = smoothstep(.045, 0., abs(d - t * .4)) * (1. - t) * step(hash(c + floor(uTick / 10. + h)), .3);
    col += (uAmb * 3. + uFillCol * .5 + .02) * ring * uRain * 1.4;
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
  const tpl = (pass) => ((TL.passes && !Array.isArray(TL.passes) && typeof TL.passes[pass] === 'string') ? TL.passes[pass]
    : TL.template || TL.path || TL.url || 'tiles/{pass}/{z}/{x}_{y}.png').split(' ')[0];
  const url = (pass, z, x, y) => `${data.base}/${tpl(pass).replace('{pass}', pass).replace('{z}', z).replace('{x}', x).replace('{y}', y)}`;
  const ts = TL.tile_size || TL.size || [2560, 1440];
  const [TW, TH] = Array.isArray(ts) ? ts : [ts, Math.round(ts * IH / IW)];
  const lv = TL.max_z ?? TL.z_max ?? TL.levels ?? 0;
  const maxZ = Array.isArray(lv) ? Math.max(...lv.map((l) => +(l.z ?? l))) : +lv;
  // which tiles exist: complete_levels have all, partial_levels list "x_y"; without that info every tile is assumed present
  const avail = (z, x, y) => {
    if (!TL.complete_levels && !TL.partial_levels) return true;
    return (TL.complete_levels || []).includes(z) || !!TL.partial_levels?.[z]?.includes(`${x}_${y}`);
  };
  const hiW = small ? 0 : meta.resolution?.hi?.[0] || meta.sets?.hi?.[0] || 0;   // desktop swaps in hi soon: tiles must beat that
  const best = (z, x, y) => { for (let k = 0; z - k >= 1; k++) if (avail(z - k, x >> k, y >> k)) return z - k; return 0; };   // missing tile: fall back to its parent
  const layers = {};
  for (const pass of passList) {
    const cv = Object.assign(document.createElement('canvas'), { width: ATLAS, height: ATLAS });
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = pass === 'albedo' || /srgb/i.test(meta.passes?.[Object.keys(meta.passes || {}).find((k) => k.startsWith('lightmap.'))] || '') ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
    layers[pass] = { ctx: cv.getContext('2d'), t };
  }
  const cache = new Map(), loading = new Set(), failed = new Set(), LRU = small ? 16 : 40;
  let cur = null, dirty = false, lastUp = 0, lastUv = null;
  function fetchTile(pass, z, x, y) {
    const k = `${pass}/${z}/${x}_${y}`;
    if (cache.has(k) || loading.has(k) || failed.has(k)) return;
    loading.add(k);
    fetch(url(pass, z, x, y)).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); }).then(createImageBitmap).then((b) => {
      cache.set(k, b);
      while (cache.size > LRU) { const [ok, ob] = cache.entries().next().value; cache.delete(ok); ob.close?.(); }
      redraw();
    }).catch(() => failed.add(k)).finally(() => loading.delete(k));
  }
  // paint every slot with the sharpest tile that is loaded (an ancestor, cropped, until the real one arrives)
  function redraw() {
    if (!cur) return;
    const { z, x0, y0, rc, rr, sw: W, sh: H } = cur;
    for (const pass of passList) {
      const ctx = layers[pass].ctx;
      ctx.clearRect(0, 0, ATLAS, ATLAS);
      for (let y = y0; y < y0 + rr; y++) for (let x = x0; x < x0 + rc; x++) {
        const zb = best(z, x, y);
        if (!zb) continue;
        fetchTile(pass, zb, x >> (z - zb), y >> (z - zb));
        for (let zz = zb; zz >= 1; zz--) {
          const k = z - zz, key = `${pass}/${zz}/${x >> k}_${y >> k}`, b = cache.get(key);
          if (!b || !avail(zz, x >> k, y >> k)) continue;
          cache.delete(key); cache.set(key, b);   // LRU touch
          const f = 2 ** k, fx = x - (x >> k << k), fy = y - (y >> k << k);
          ctx.drawImage(b, fx / f * b.width, fy / f * b.height, b.width / f, b.height / f, (x - x0) * W, (y - y0) * H, W, H);
          break;
        }
      }
    }
    dirty = true;
  }
  const uvRT = new THREE.WebGLRenderTarget(32, 20), uvPx = new Uint8Array(32 * 20 * 4);
  const uvMat = new THREE.ShaderMaterial({ uniforms: { uProj: U.uProj }, side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'uniform mat4 uProj; varying vec3 vW; void main(){ vec4 p = uProj * vec4(vW, 1.); gl_FragColor = vec4(clamp(p.xy / p.w * .5 + .5, 0., 1.), 1., 1.); }' });
  function update() {
    let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
    // what the screen really shows, in render-image uv: a tiny uv render of the scene (mountains, roofs and all)
    const cv = clouds.visible;
    world.overrideMaterial = uvMat; clouds.visible = false;
    renderer.setRenderTarget(uvRT); renderer.render(world, camera); renderer.setRenderTarget(null);
    world.overrideMaterial = null; clouds.visible = cv;
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
      if (!any || W * n <= Math.max(Math.max(IW, hiW) * 1.05, (reg?.W || 0) * (reg?.n || 0) * 1.05)) continue;   // nothing sharper here
      reg = { z, n, x0, y0, rc, rr, W, H, sw: W, sh: H };
      if (W * n >= need * 1.25) break;   // a bit of oversampling: prefer the deeper level
    }
    const key = reg && `${reg.z}/${reg.x0}/${reg.y0}/${reg.rc}/${reg.rr}/${reg.W}`;
    if (key !== cur?.key) {
      cur = reg && { ...reg, key };
      U.uDOn.value = !!cur;
      if (cur) {
        U.uDRect.value.set(cur.x0 / cur.n, 1 - (cur.y0 + cur.rr) / cur.n, (cur.x0 + cur.rc) / cur.n, 1 - cur.y0 / cur.n);
        U.uDUse.value.set(cur.rc * cur.W / ATLAS, cur.rr * cur.H / ATLAS);
        redraw();
      }
    }
  }
  function upload(now) {   // re-upload the atlas at most every 150 ms while tiles arrive
    if (!dirty || now - lastUp < 150) return;
    dirty = false; lastUp = now;
    for (const l of Object.values(layers)) l.t.needsUpdate = true;
  }
  return { layers, update, upload, state: () => cur && { z: cur.z, x0: cur.x0, y0: cur.y0, rc: cur.rc, rr: cur.rr, slot: cur.W, cached: cache.size, failed: failed.size, uv: lastUv?.map((v) => +v.toFixed(3)) } };
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

// ---------- rain clouds: cotton-wool tufts hanging over the back of the diorama ----------
const clouds = new THREE.Group();
world.add(clouds);
const cloudMat = new THREE.ShaderMaterial({
  uniforms: { uKeyDir: U.uKeyDir, uLight: { value: new THREE.Vector3(1, 1, 1) }, uTick: U.uTick },
  vertexShader: `varying vec3 vW, vN; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `precision highp float; varying vec3 vW, vN; uniform vec3 uKeyDir, uLight; uniform float uTick;
    ${COMMON}
    void main(){ vec3 n = normalize(vN);
      float fuzz = vnoise(vW.xy * .35 + vW.z * .3 + mod(uTick, 3.) * 13.) * .14 + vnoise(vW.xy * 2.1 + vW.z) * .06;   // felt/cotton fibres, boiling at 8 fps
      float l = clamp(.55 + .45 * n.z + .25 * dot(n, uKeyDir) - fuzz, 0., 1.);
      vec3 c = mix(vec3(.42, .45, .52), vec3(.97, .96, .93), l) * uLight;
      gl_FragColor = vec4(pow(c, vec3(1. / 2.2)), .8); }`,
  transparent: true, depthWrite: false, blending: THREE.CustomBlending,     // see-through a little; keep the bloom alpha of what is behind
  blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
});
const uiRects = () => ['title', 'time', 'card'].map((id) => $(id)).filter((e) => e.id !== 'card' || e.classList.contains('open')).map((e) => e.getBoundingClientRect());
{
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const sizeM = (tanY * target0.distanceTo(projCam.position)) * 2;   // image height in metres at the target
  for (let i = 0; i < 6; i++) {
    const parts = [];
    const n = 4 + Math.floor(rnd() * 3), r0 = sizeM * (.02 + rnd() * .012);
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
    m.userData = { u: (i + rnd() * .6) / 6, v: .5 + rnd() * .14, lift: sizeM * (.09 + rnd() * .06), speed: .003 + rnd() * .003, r: r0 * 2.2, s: 0 };
    clouds.add(m);
  }
}
function placeClouds(tick, amount) {
  clouds.visible = amount > .01;
  if (!clouds.visible) return;
  for (const m of clouds.children) {
    const d = m.userData, u = .12 + ((d.u + tick * d.speed / FPS) % 1) * .8;   // slow drift, wraps inside the diorama
    m.position.copy(projRay(u, d.v, target0.z)); m.position.z += d.lift;
    // never over the UI: shrink away when the tuft would touch the title, the time panel or an open card
    const [x, y, front] = screenOf(m.position, camera), rpx = Math.hypot(...screenOf(m.position.clone().addScaledVector(camRightH, d.r), camera).slice(0, 2).map((v, i) => v - [x, y][i]));
    const hit = !front || uiRects().some((r) => x + rpx > r.left && x - rpx < r.right && y + rpx > r.top && y - rpx < r.bottom);
    d.s += ((hit ? 0 : 1) - d.s) * .5;
    m.scale.setScalar(Math.max(.001, (.2 + .8 * amount) * d.s));
  }
}

// ---------- view camera: starts exactly in the render camera; pan / zoom / turn a little, soft springs back ----------
const camera = new THREE.PerspectiveCamera(30, 1, 10, 20000);
camera.up.set(0, 0, 1);
const fwd0 = target0.clone().sub(projCam.position);
const bearing0 = Math.atan2(fwd0.x, fwd0.y) / deg, pitch0 = Math.asin(-fwd0.z / dist0) / deg;
const LIM = { yaw: [-12, 12], pitch: [-5, 15], zoom: [1, (small ? 4 : 2) * (deep ? 2 : 1)] };   // tile pyramid: twice as deep
const T = { p: target0.clone(), yaw: 0, pitch: 0, zoom: 1 };      // target state
const C = { p: target0.clone(), yaw: 0, pitch: 0, zoom: 1 };      // eased state
let sw = 1, sh = 1, cover = [tanX, tanY], liftNdc = 0;
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
  liftNdc = Math.min(.14, 2 * ($('time').offsetHeight * .45) / sh);
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
    uFocus: { value: .5 }, uDof: { value: small ? 1.0 : 1.5 }, uTick: { value: 0 }, uTime: { value: 0 }, uSel: { value: -1 }, uRain: { value: 0 }, uRainLight: { value: 1 },
    uHiPos: { value: Array.from({ length: MAX_HI }, () => new THREE.Vector4()) }, uHiN: { value: 0 },
    uAccent: { value: cssColor('--accent') }, uAccent2: { value: cssColor('--accent-samen') },
  },
  fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform vec2 uScreen;
uniform float uDpr, uFocus, uDof, uTick, uTime, uRain, uRainLight;
uniform int uSel, uHiN;
uniform vec3 uAccent, uAccent2;
uniform vec4 uHiPos[${MAX_HI}];   // one per marker: xy = screen uv, z = number of places in it, w = category (0 toerist, 1 samen)
${COMMON}
vec4 S(vec2 uv, float lod){ return textureLod(tScene, uv, lod); }
void main(){
  vec2 uv = vUv;
  vec3 bloom = vec3(1., .62, .32) * (S(uv, 3.5).a * .9 + S(uv, 5.5).a * .9);
  float blur = smoothstep(.26, .7, abs(uv.y - uFocus)) * uDof;   // wide sharp band, mild falloff
  vec2 r = exp2(blur) * .8 / uScreen;
  vec3 col = S(uv, blur).rgb * .4 + (S(uv + r, blur).rgb + S(uv - r, blur).rgb + S(uv + vec2(-r.x, r.y), blur).rgb + S(uv + vec2(r.x, -r.y), blur).rgb) * .15;
  col += bloom;
  vec2 ca = (uv - .5) * 2.4 / uScreen.y * vec2(uScreen.y / uScreen.x, 1.);   // light chromatic aberration toward the edges
  col.r = mix(col.r, S(uv + ca, blur + .5).r + bloom.r, .65);
  col.b = mix(col.b, S(uv - ca, blur + .5).b + bloom.b, .65);

  // rain: fishing-line threads with a glass bead, re-drawn on the stop-motion clock
  if (uRain > .01) {
    vec2 p = uv * uScreen / uDpr;
    p.x += p.y * .16;
    vec2 cell = vec2(24., 74.);
    vec2 id = floor(p / cell), l = fract(p / cell) * cell;
    float tk = floor(uTick);
    float h1 = hash(id + tk * 1.37), h2 = hash(id * 1.7 + tk * .71), h3 = hash(id + tk * 2.3 + 5.);
    float on = step(h1, .32 * uRain);
    float x0 = 4. + h2 * (cell.x - 8.), y0 = h3 * cell.y * .35, len = cell.y * (.3 + .3 * h2);
    float line = smoothstep(1., .15, abs(l.x - x0)) * step(y0, l.y) * step(l.y, y0 + len) * smoothstep(y0, y0 + len, l.y);
    float bead = smoothstep(2.3, 1.1, length(vec2(l.x - x0, l.y - y0)));
    vec3 glass = vec3(.84, .9, 1.) * uRainLight;
    col = mix(col, glass, on * (line * .38 + bead * .6));
    col += glass * on * bead * smoothstep(1.1, 0., length(vec2(l.x - x0 + .6, l.y - y0 - .6))) * .5;   // tiny glint
  }

  // highlights: pulsing ring + dot at each 3D anchor
  float glow = 0.; vec3 gcol = vec3(0.);
  for (int i = 0; i < ${MAX_HI}; i++) {
    if (i >= uHiN) break;
    if (uHiPos[i].w < 0. || uHiPos[i].z < .5) continue;
    float cnt = uHiPos[i].z;   // places merged into this marker
    float pulse = .5 + .5 * sin(uTime * 2.2 + float(i) * 1.3);
    float sel = i == uSel ? 1. : 0.;
    float d = length((uv - uHiPos[i].xy) * uScreen / uDpr);
    float rr = 13. + 4. * pulse + 4. * sel + 3. * min(cnt - 1., 3.);
    float g = smoothstep(2.2, 0., abs(d - rr)) * (.6 + .3 * pulse + .4 * sel) + smoothstep(6., 2.5, d) * .95 + smoothstep(rr + 16., 0., d) * .1;
    glow += g; gcol += g * (uHiPos[i].w > .5 ? uAccent2 : uAccent);
  }
  if (glow > 0.) col = mix(col, gcol / glow, clamp(glow, 0., 1.) * .85) + gcol * .12;

  vec2 v = (uv - .5) * vec2(uScreen.x / uScreen.y, 1.);
  col *= mix(.72, 1., smoothstep(1.05, .35, length(v)));             // vignette
  col += (hash(floor(uv * uScreen) + uTick * 17.31) - .5) * .05;      // grain on the stop-motion clock
  gl_FragColor = vec4(col, 1.);
}`,
});
const pu = postMat.uniforms;
const postScene = new THREE.Scene();
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));
addEventListener('resize', () => { resize(); });
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
highlights.splice(MAX_HI);
pu.uHiN.value = highlights.length;
const CATS = { toerist: 'Toeristisch', samen: 'Samen' };
const catOf = (h) => (h.categorie in CATS ? h.categorie : 'toerist');
const showCat = { toerist: true, samen: true };
const visible = (h) => showCat[catOf(h)];
for (const [cat, label] of Object.entries(CATS)) {
  const b = Object.assign(document.createElement('button'), { className: `chip ${cat}`, textContent: label });
  b.setAttribute('aria-pressed', 'true');
  b.onclick = () => {
    showCat[cat] = !showCat[cat];
    b.setAttribute('aria-pressed', String(showCat[cat]));
    if (selected >= 0 && !visible(highlights[selected])) closeCard();
  };
  $('legend').append(b);
}
const camRightH = new THREE.Vector3(Math.cos(bearing0 * deg), -Math.sin(bearing0 * deg), 0);
const camFwdH = new THREE.Vector3(Math.sin(bearing0 * deg), Math.cos(bearing0 * deg), 0);
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
const lerp = (a, b, t) => a + (b - a) * t;
const mixArr = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
function phaseAt(t) {
  const i = Math.min(Math.floor(t), PHASES.length - 2), f = THREE.MathUtils.smoothstep(t - i, 0, 1);
  const a = PHASES[i], b = PHASES[i + 1];
  const o = { clock: lerp(a.clock, b.clock, t - i) };
  for (const k of ['key', 'fill', 'amb']) o[k] = mixArr(a[k], b[k], f);
  for (const k of ['win', 'sat', 'expo']) o[k] = lerp(a[k], b[k], f);
  return o;
}

// ---------- UI: time ----------
const slider = $('slider');
function bergenT() {   // follow the real time in Bergen (unless ?t= is given or the slider is touched)
  const [h, m] = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/Oslo', hour12: false }).split(':').map(Number);
  const c = h + m / 60;
  if (c < 6) return 4;
  if (c < PHASES[0].clock) return 0;
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

// ---------- UI: rain (default: the real weather in Bergen from api.met.no, silently dry if that fails) ----------
let rainOn = false, rain = 0, rainTouched = Q.has('regen');
const rainBtn = $('rain');
const setRain = (on) => { rainOn = on; rainBtn.setAttribute('aria-pressed', String(on)); };
rainBtn.onclick = () => { rainTouched = true; setRain(!rainOn); };
if (Q.has('regen')) setRain(Q.get('regen') === '1');
else fetch('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=60.39&lon=5.32')
  .then((r) => r.ok ? r.json() : null)
  .then((j) => {
    const d = j?.properties?.timeseries?.[0]?.data;
    const wet = (d?.next_1_hours?.details?.precipitation_amount ?? 0) >= .1 || /rain|sleet|drizzle|shower/.test(d?.next_1_hours?.summary?.symbol_code || '');
    if (wet && !rainTouched) setRain(true);
  }).catch(() => {});

// ---------- UI: card ----------
let selected = -1;
function openCard(h, i) {
  deepArmed = true;
  selected = i;
  $('card-title').textContent = h.titel || 'Plek';
  $('card-text').textContent = h.tekst || '';
  const weer = { regen: 'ook bij regen', zon: 'bij droog weer' }[h.weer];
  $('card-meta').textContent = [h.kosten, weer].filter(Boolean).join(', ');
  $('card-meta').hidden = !$('card-meta').textContent;
  const cat = $('card-cat');
  cat.hidden = false;
  cat.className = `chip static ${catOf(h)}`;
  cat.textContent = CATS[catOf(h)];
  const vis = highlights.filter(visible);
  $('card-nav').hidden = vis.length < 2;
  $('count').textContent = `${vis.indexOf(h) + 1} van ${vis.length}`;
  const img = $('card-img');
  img.hidden = !h.foto;
  if (h.foto) img.src = h.foto;
  $('card').classList.add('open');
  // fly over: zoom in a little, place the spot in the upper part of the screen (above the card)
  T.zoom = clampV(sw < 700 ? 1.6 : 1.5, LIM.zoom);
  const visDepth = 2 * dist0 / T.zoom * cover[1] / Math.sin(pitch0 * deg);
  const p = h.world.clone(); p.z = target0.z;
  T.p.copy(clampPivot(p.addScaledVector(camFwdH, -visDepth * (sw < 700 ? .2 : .12)), T.zoom));
}
function closeCard() {
  selected = -1;
  $('card').classList.remove('open');
}
$('close').onclick = closeCard;
const stepCard = (d) => {
  const vis = highlights.filter(visible);
  if (!vis.length) return;
  const h = vis[(vis.indexOf(highlights[selected]) + d + vis.length) % vis.length];
  openCard(h, highlights.indexOf(h));
};
$('prev').onclick = () => stepCard(-1);
$('next').onclick = () => stepCard(1);
addEventListener('keydown', (e) => e.key === 'Escape' && closeCard());

function pick(x, y) {
  let best = -1, bd = 32;
  highlights.forEach((h, i) => {
    if (!visible(h)) return;
    const [sx, sy, front] = screenOf(h.world, camera);
    const d = Math.hypot(sx - x, sy - y);
    if (front && d < bd) { bd = d; best = i; }
  });
  if (best >= 0) openCard(highlights[best], best); else closeCard();
}

// ---------- markers: places close together on screen merge into one (with a count), split again when zooming in ----------
const pinsEl = Object.assign(document.createElement('div'), { id: 'pins' });
document.body.insertBefore(pinsEl, $('title'));
const pins = Array.from({ length: MAX_HI }, () => {
  const b = document.createElement('button');
  b.innerHTML = '<span class="n"></span>';
  b.onclick = () => openCluster(b.cluster);
  pinsEl.append(b);
  return b;
});
function openCluster(c) {
  if (!c) return;
  if (c.m.length === 1) return openCard(c.m[0], highlights.indexOf(c.m[0]));
  if (T.zoom >= LIM.zoom[1] - .01) return openCard(c.m[0], highlights.indexOf(c.m[0]));   // cannot split further
  const p = c.m.reduce((a, h) => a.add(h.world), new THREE.Vector3()).divideScalar(c.m.length); p.z = target0.z;
  T.zoom = Math.min(LIM.zoom[1], T.zoom * 2.2);
  T.p.copy(clampPivot(p, T.zoom));
}
function layoutPins() {
  const cl = [];
  for (const h of highlights) {
    if (!visible(h)) continue;
    const [x, y, front] = screenOf(h.world, camera);
    if (!front || x < -30 || y < -30 || x > sw + 30 || y > sh + 30) continue;
    const c = cl.find((c) => Math.hypot(c.x - x, c.y - y) < 50);
    if (c) { c.m.push(h); c.x += (x - c.x) / c.m.length; c.y += (y - c.y) / c.m.length; } else cl.push({ x, y, m: [h] });
  }
  pu.uHiN.value = cl.length; pu.uSel.value = -1;
  pins.forEach((b, i) => {
    const c = cl[i];
    b.hidden = !c; b.cluster = c;
    if (!c) return;
    pu.uHiPos.value[i].set(c.x / sw, 1 - c.y / sh, c.m.length, c.m.every((h) => catOf(h) === 'samen') ? 1 : 0);
    if (c.m.includes(highlights[selected])) pu.uSel.value = i;
    b.style.transform = `translate(${c.x}px, ${c.y}px)`;
    const label = c.m.length > 1 ? `${c.m.length} plekken: ${c.m.map((h) => h.titel).join(', ')}` : c.m[0].titel;
    if (b.getAttribute('aria-label') !== label) {
      b.setAttribute('aria-label', label); b.title = label;
      b.firstChild.textContent = c.m.length > 1 ? c.m.length : '';
    }
  });
}

// ---------- input: drag = pan, right/shift-drag or two-finger twist/tilt = turn, wheel/pinch = zoom ----------
const dragCam = new THREE.PerspectiveCamera();
dragCam.up.set(0, 0, 1);
const hitPlane = (x, y, cam, z) => {
  ray.setFromCamera(new THREE.Vector2(x / sw * 2 - 1, 1 - y / sh * 2), cam);
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
};
const pts = new Map();
let gesture = null;
const interacting = () => pts.size > 0;
function startGesture(e) {
  const P = [...pts.values()];
  const base = { yaw: T.yaw, pitch: T.pitch, zoom: T.zoom, p: T.p.clone(), moved: false };
  if (P.length >= 2) {
    const [a, b] = P;
    gesture = { ...base, kind: 'two', d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), my: (a.y + b.y) / 2, moved: true };
  } else {
    const rot = e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey;
    pose(T, dragCam);
    gesture = { ...base, kind: rot ? 'rot' : 'pan', x: e.clientX, y: e.clientY, hit: hitPlane(e.clientX, e.clientY, dragCam, T.p.z) };
  }
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  startGesture(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId) || !gesture) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = gesture;
  if (g.kind === 'two' && pts.size >= 2) {
    const [a, b] = [...pts.values()];
    T.zoom = rubber(g.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(g.d, 1), LIM.zoom);
    let da = Math.atan2(b.y - a.y, b.x - a.x) - g.ang;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    T.yaw = rubber(g.yaw - da / deg, LIM.yaw);
    T.pitch = rubber(g.pitch + ((a.y + b.y) / 2 - g.my) * .08, LIM.pitch);
    return;
  }
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  if (!g.moved && Math.hypot(dx, dy) < 6) return;
  g.moved = true; canvas.classList.add('dragging');
  if (g.kind === 'rot') {
    T.yaw = rubber(g.yaw - dx * .08, LIM.yaw);
    T.pitch = rubber(g.pitch + dy * .06, LIM.pitch);
  } else if (g.hit) {
    const h = hitPlane(e.clientX, e.clientY, dragCam, g.p.z);
    if (h) T.p.copy(rubberPivot(g.p.clone().add(g.hit).sub(h), T.zoom));
  }
});
function endPointer(e) {
  const g = gesture;
  pts.delete(e.pointerId);
  if (g && !g.moved && e.type === 'pointerup' && pts.size === 0) pick(e.clientX, e.clientY);
  canvas.classList.remove('dragging');
  gesture = null;
  if (pts.size === 1) { const [p] = pts.values(); startGesture({ clientX: p.x, clientY: p.y, button: 0 }); gesture.moved = true; }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
let wheelTimer = 0;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const z0 = T.zoom;
  T.zoom = rubber(T.zoom * Math.exp(-e.deltaY * .0015), LIM.zoom);
  pose(T, dragCam);
  const h = hitPlane(e.clientX, e.clientY, dragCam, T.p.z);   // zoom toward the cursor
  if (h) T.p.copy(rubberPivot(T.p.clone().lerp(h, 1 - z0 / T.zoom), T.zoom));
  wheelTimer = performance.now();
}, { passive: false });

// ---------- loop ----------
function updateLight(tick) {
  const ph = phaseAt(+slider.value);
  const [az, el] = sunAt(ph.clock);
  const day = THREE.MathUtils.smoothstep(el, -3, 1);
  const key = dirOf(az + Math.sin(tick * 2.1) * .4, Math.max(el, 4)).lerp(dirOf(200, 35), 1 - day).normalize();   // moon at night
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
  placeClouds(tick, r);
}
let lastTick = -1, lastDeep = 0;
let deepArmed = false;   // tiles only after the first interaction: keeps the first load small
for (const ev of ['pointerdown', 'wheel', 'keydown']) addEventListener(ev, () => { deepArmed = true; }, { once: true, passive: true });
function frame(now) {
  const tick = Math.floor(now / 1000 * FPS);
  if (tick !== lastTick) { lastTick = tick; updateLight(tick); pu.uTick.value = tick % 997; }
  if (!interacting() && now - wheelTimer > 250) {   // soft springs back inside the limits
    T.yaw += (clampV(T.yaw, LIM.yaw) - T.yaw) * .12;
    T.pitch += (clampV(T.pitch, LIM.pitch) - T.pitch) * .12;
    T.zoom += (clampV(T.zoom, LIM.zoom) - T.zoom) * .12;
    T.p.lerp(clampPivot(T.p, T.zoom), .12);
  }
  const k = .16;
  C.yaw += (T.yaw - C.yaw) * k; C.pitch += (T.pitch - C.pitch) * k; C.zoom += (T.zoom - C.zoom) * k; C.p.lerp(T.p, k);
  pose(C, camera);
  if (deep && deepArmed) { if (now - lastDeep > 300) { lastDeep = now; deep.update(); } deep.upload(now); }
  layoutPins();
  pu.uFocus.value = C.p.clone().project(camera).y * .5 + .5;
  pu.uTime.value = now / 1000;
  renderer.setRenderTarget(sceneRT); renderer.render(world, camera);
  renderer.setRenderTarget(null); renderer.render(postScene, quadCam);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if (!small && !Q.has('set')) data.passes('hi').then((p) => {   // progressive: sharp hi set replaces lo when it is in
  for (const t of [U.tAlb.value, U.tLm.value, U.tWin.value]) t?.dispose();
  U.tAlb.value = p.alb; U.tLm.value = p.lm; U.tWin.value = p.win; U.uHasWin.value = !!p.win;
  if (p.ground) { U.tGround.value = p.ground; U.uHasGround.value = true; }
  IW = p.alb.image.width; IH = p.alb.image.height; U.uImg.value.set(IW, IH);
  SET = 'hi';
}).catch((e) => console.info('hi-set niet geladen, blijft lo:', e.message));
window.__viewer = { pins: () => pins.filter((b) => !b.hidden).map((b) => ({ n: b.cluster.m.length, t: b.cluster.m.map((h) => h.titel), x: b.cluster.x, y: b.cluster.y })), deep: () => deep?.state(), highlights, openCard, closeCard, data: data.base, get set() { return SET; }, T, C, LIM, setRain, toScreen: (h) => screenOf(h.world, camera) };   // for tests

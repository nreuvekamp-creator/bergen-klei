// Living sea for the clay diorama: dark teal resin with swell that travels in from the fjord into Vågen and
// Puddefjorden, shore foam, swash + wet sand, caustics, fish, rain rings and warm window reflections at night.
// One shader pass over a copy of the water meshes + the strip of terrain along the shore. Contract: WATER-CONTRACT.md.
// Field (water/field.png, tile raster like ground_top.png): R = shore distance + 40 m, GB = swell phase (cos, sin) x amp.
// Built by water-lab/scripts/make_field.py; lagen en keuzes in water-lab/WATER.md.
import * as THREE from 'three';

const FIELD = new URL('./water/field.png', import.meta.url).href;

const FRAG = (COMMON, TONE) => `
precision highp float;
uniform sampler2D tField, tWin;
uniform mat4 uProj;
uniform vec2 uTileR, uTileF, uTileH, uTileC, uFieldPx;
uniform vec3 uKeyDir, uKeyCol, uFillCol, uAmb;
uniform float uTime, uTick, uRain, uWin, uDay, uSat, uExpo, uContrast;
uniform bool uHasWin;
varying vec3 vW; varying float vSea;
${COMMON}
${TONE}
vec2 hash2(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
vec2 worley(vec2 p, float t){        // (F1, F2) of moving cells
  vec2 i = floor(p), f = fract(p); float d1 = 8., d2 = 8.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y), o = hash2(i + g);
    o = .5 + .42 * sin(t + 6.2831 * o);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(d1, d2);
}
vec3 field(vec2 p){                  // x = shore distance (m, + in water), yz = swell (cos, sin) x amp
  vec2 d = p - uTileC;
  vec3 f = texture(tField, vec2(dot(d, uTileR) / uTileH.x, dot(d, uTileF) / uTileH.y) * .5 + .5).rgb;
  return vec3(f.r * 255. - 40., f.gb * 2. - 1.);
}
float lineAA(float x, float w, float aa){ return smoothstep(w + aa, w, abs(x)); }

void main(){
  vec2 q = vW.xy - uTileC;
  if (abs(dot(q, uTileR)) > uTileH.x || abs(dot(q, uTileF)) > uTileH.y) discard;
  float fp = max(length(fwidth(vW.xy)), .05);   // metres per pixel: fades detail that would only shimmer
  float t = uTime;
  float boil = mod(uTick, 3.);                    // 8 fps hand-made wobble on foam edges
  vec3 F = field(vW.xy);
  float sdf = F.x;
  if (vSea > .5) { if (sdf < -2.) discard; sdf = max(sdf, .5); }   // sea plane: water up to the painted shore
  float amp = length(F.yz);                       // 0 = lake / calm, ~1 open fjord
  float ph = atan(F.z, F.y);
  // gradient of the swell phase from two extra taps (smooth, not per pixel quad)
  vec3 Fx = field(vW.xy + vec2(uFieldPx.x, 0.)), Fy = field(vW.xy + vec2(0., uFieldPx.y));
  vec2 gph = vec2(atan(Fx.z, Fx.y) - ph, atan(Fy.z, Fy.y) - ph);
  gph = (gph - 6.2831 * floor(gph / 6.2831 + .5)) / uFieldPx;           // unwrap, rad per metre
  float swAmp = smoothstep(.02, .25, amp);

  // ---------- land side: swash that climbs the quay/beach and wet sand left behind (same clock as the swell) ----------
  float wn = vnoise(vW.xy / 45.) - .5;
  float clock = fract((ph - t * 1.25) / 6.2831 + wn * .35);              // 0 = swell crest reaches this bit of shore
  float R = (3. + 5. * swAmp) * (.7 + .6 * vnoise(vW.xy / 70. + 3.));    // run-up reach (m), sheltered quays get less
  float rise = smoothstep(0., .22, clock), fall = 1. - smoothstep(.22, 1., clock);
  float reach = R * (clock < .22 ? rise : fall);
  float x = -sdf;                                                          // metres up the shore
  vec2 lw = worley(vW.xy / 2.2 + boil * 1.7, t * .7);
  if (sdf < 0.) {
    if (x > R + 1.5 || swAmp < .01) {                                      // dry: only a damp band right at the waterline
      float damp = smoothstep(4., .5, x) * (.3 + .25 * uRain);
      if (damp < .01) discard;
      gl_FragColor = vec4(vec3(0.), damp);
      return;
    }
    float pin = .22 * x / max(R, .1), pout = .22 + .78 * (1. - x / max(R, .1));   // when the swash covers / leaves x
    float since = clock < pin ? clock + 1. - pout : clock - pout;
    float wet = clock > pin && clock < pout ? 1. : exp(-max(since, 0.) * 2.2);
    wet = max(wet * smoothstep(R + 1.5, R * .6, x), smoothstep(2.5, 0., x) * .6);
    float cover = smoothstep(.0, .6, reach - x + (lw.x - .5) * .8);
    vec3 lit = uKeyCol * max(uKeyDir.z, .15) * .8 + uFillCol * .6 + uAmb;
    vec3 film = vec3(.055, .14, .15) * lit;                                // thin water over sand: see-through teal
    float lace = smoothstep(.1, .02, lw.y - lw.x) * smoothstep(1.2, 0., abs(reach - x)) * smoothstep(.05, .2, reach);
    vec3 col = tone(film + vec3(.8, .82, .8) * lit * lace);
    float a = max(cover * .55, lace * .9);
    gl_FragColor = vec4(mix(vec3(.05, .04, .03), col, a / max(a + wet * .3, 1e-3)), max(a, wet * .3));
    return;
  }

  // ---------- surface: depth colour of the resin ----------
  float depthT = 1. - exp(-sdf / 55.);
  vec3 shallow = vec3(.10, .21, .19), deep = vec3(.02, .066, .08);
  vec3 base = mix(shallow, deep, depthT);
  // swell: travelling crests (fundamental + 2nd harmonic), noise-warped so the fronts never repeat exactly
  float warp = (vnoise(vW.xy / 160. + t * .03) - .5) * 2.4;
  float a1 = ph - t * 1.25 + warp, a2 = 2. * ph - t * 2.5 + warp * 1.7 + 1.3;
  float h = sin(a1) * .7 + sin(a2) * .3;
  vec2 gh = (cos(a1) * .7 + cos(a2) * .6) * gph * swAmp * (.35 + .65 * smoothstep(0., 40., sdf));
  // wind ripples (two scales), gone when they'd be sub-pixel
  float rip = smoothstep(3., .8, fp);
  vec2 r1 = vec2(vnoise(vW.xy / 9. + vec2(t * .25, 0.)), vnoise(vW.xy / 9. + vec2(5.3, t * .2))) - .5;
  vec2 r2 = vec2(vnoise(vW.xy / 3.1 - t * .4), vnoise(vW.xy / 3.1 + 9.1 + t * .35)) - .5;
  vec2 slope = gh * 5. + (r1 * .35 + r2 * .25 * smoothstep(1.2, .4, fp)) * rip * (1. + uRain * 1.5);
  vec3 N = normalize(vec3(-slope, 1.));
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = uKeyDir;
  // light on the body: mostly sky/ambient, a little key; troughs facing away read as soft wave shadows
  vec3 lit = uKeyCol * (.25 + .75 * max(dot(N, L), 0.)) * .55 + uFillCol * .9 + uAmb * 1.4;
  vec3 col = base * lit;
  col *= 1. + h * .06 * swAmp;                                             // crests a touch lighter, troughs darker

  // caustics on the shallow bottom (two drifting worley webs, red/blue a hair apart)
  float shal = smoothstep(50., 3., sdf) * smoothstep(2.5, .6, fp);
  if (shal > .01) {
    vec2 cp = vW.xy / 6.;
    vec2 c1 = worley(cp + t * .05, t * .9), c2 = worley(cp * 1.3 - t * .04 + 7., t * 1.1);
    float web = smoothstep(.16, .0, c1.y - c1.x) * smoothstep(.22, .0, c2.y - c2.x);
    vec2 c3 = worley(cp + t * .05 + .03, t * .9);
    float webR = smoothstep(.16, .0, c3.y - c3.x) * smoothstep(.22, .0, c2.y - c2.x);
    col += vec3(webR, web, web * .9) * shal * uKeyCol * .22 * (.3 + .7 * uDay);
  }

  // ---------- fish: small schools under the surface, away from the shore ----------
  float fishV = smoothstep(4., 1.8, fp) * smoothstep(12., 26., sdf);
  if (fishV > .01) {
    float FC = 90.;
    vec2 fc = floor(vW.xy / FC);
    float hs = hash(fc + 17.);
    if (hs < .45) {
      float sp = .12 + .1 * hash(fc + 3.);
      vec2 ctr = (fc + .5) * FC + FC * .2 * vec2(sin(t * sp + hs * 40.), sin(t * sp * .8 + hs * 17.));
      vec2 vel = vec2(cos(t * sp + hs * 40.), .8 * cos(t * sp * .8 + hs * 17.));
      vec2 dir = normalize(vel + 1e-4), side = vec2(-dir.y, dir.x);
      float fish = 0.;
      for (int i = 0; i < 7; i++) {
        vec2 o = (hash2(fc + float(i) * 3.1) - .5) * vec2(26., 14.);
        vec2 p = ctr + dir * o.x + side * o.y + side * sin(t * 2. + float(i)) * .6 - vW.xy;
        float al = -dot(p, dir), sd = dot(p, side);                       // along the fish (head at +), sideways
        float wig = sin(t * 9. + float(i) * 2.) * .35 * smoothstep(0., -2., al);
        float body = length(vec2(al / 2.8, (sd - wig) / .85));
        float tail = step(-4.3, al) * step(al, -2.1) * step(abs(sd - wig * 1.6), (-2.1 - al) * .7 + .05);
        fish = max(fish, max(smoothstep(1., .75, body), tail));
      }
      col = mix(col, base * lit * 2.3 + vec3(.012, .02, .02), fish * .75 * fishV);   // painted fish just under the resin
    }
  }

  // ---------- reflections: sky (fresnel), sun glints and sparkle dashes ----------
  float fres = .02 + .98 * pow(1. - max(dot(N, V), 0.), 5.);
  vec3 sky = uFillCol * 1.1 + uAmb * 3.;
  col = mix(col, sky, fres * .55 * (1. - .45 * uRain));
  vec3 Hh = normalize(L + V);
  float sp = pow(max(dot(N, Hh), 0.), 260.);
  col += uKeyCol * sp * 1.2 * (1. - uRain * .7);
  float wide = pow(max(dot(N, Hh), 0.), 30.);
  vec2 sc = vW.xy / 5.;
  vec2 sid = floor(sc + vec2(0., floor(uTick) * .37));
  float dash = step(.975 - wide * .3, hash(sid + floor(uTick / 3.)));
  vec2 sf = fract(sc) - .5;
  dash *= lineAA(sf.y, .04, .05) * step(abs(sf.x), .3) * smoothstep(2.5, .7, fp);
  col += uKeyCol * dash * (.25 + wide) * .9 * (1. - uRain);

  // ---------- foam ----------
  // drifting streaks: short white crescents riding the swell crests in open water, lacy trail behind
  float open = smoothstep(25., 70., sdf) * swAmp;
  float crest = fract((a1 + 3.1416) / 6.2831);                             // 0..1 through one swell, crest near .25
  float seg = smoothstep(.72, .84, vnoise(vW.xy / 55. + vec2(t * .02, 0.)) + .15 * vnoise(vW.xy / 12.));
  float aa = fwidth(crest) * 1.2;
  float streak = lineAA(crest - .25, .008, aa + .004) * seg * open * smoothstep(2.2, .9, fp);
  float trail = smoothstep(.25, .45, crest) * smoothstep(.6, .3, crest) * seg * open;
  if (trail > .01 && fp < 1.4) { vec2 tw = worley(vW.xy / 2.6 + boil * 2.3, t * .5); trail *= smoothstep(.12, .03, tw.y - tw.x) * .55 * smoothstep(1.4, .6, fp); }
  else trail = 0.;
  // shore lines: thin white lines running in toward the shore, three layers that overlap and break up
  float sh = 0.;
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    float s2 = sdf + (vnoise(vW.xy / (34. + fk * 15.) + fk * 7.) - .5) * 12.;
    float per = 14. + fk * 6.;
    float u = fract(s2 / per + t * (.16 + fk * .05) + fk * .31);
    float m = smoothstep(.5, .7, vnoise(vW.xy / (22. + fk * 9.) + vec2(t * .04, fk * 4. - t * .02)));
    sh = max(sh, lineAA(u - .5, .02, fwidth(u) + .01) * m * smoothstep(22., 6., s2) * smoothstep(1.5, 4., s2) * (.5 + .5 * u));
  }
  sh *= .7 * max(swAmp, .25) * smoothstep(2.5, .8, fp);
  // bubbling foam where the swash breaks: worley lace hugging the waterline, pulsing with the swell clock
  float brk = smoothstep(5. + 4. * swAmp, 0., sdf + (1. - rise * fall) * 2.) * max(swAmp, .2);
  float lace = smoothstep(.13, .03, lw.y - lw.x) * brk;
  float edge = smoothstep(1.4, 0., sdf) * .9;                              // a thin white rim on every waterline
  float foam = clamp(max(max(streak, trail), max(sh, max(lace, edge * max(swAmp, .35)))), 0., 1.);
  vec3 foamCol = vec3(.86, .88, .84) * (uKeyCol * max(L.z, .2) * .9 + uFillCol * .7 + uAmb * 2.);
  col = mix(col, foamCol, foam * .92);

  // ---------- rain: small rings (only up close, real scale ~1-2 m) and a rougher, duller surface ----------
  if (uRain > .01) {
    float ringV = smoothstep(.7, .2, fp);
    vec2 rq = vW.xy / 2.;
    for (int k = 0; k < 2; k++) {
      vec2 rc = floor(rq + float(k) * .5), rf = fract(rq + float(k) * .5) - .5;
      float rh = hash(rc + float(k) * 9.), tt = fract(t * .9 + rh);
      vec2 ro = (hash2(rc + 4.) - .5) * .5;
      float d = length(rf - ro);
      float ring = lineAA(d - tt * .45, .012, .02) * (1. - tt) * step(hash(rc + floor(t * .9 + rh) * 1.7), .45);
      col += sky * ring * uRain * ringV * 1.2;
    }
    col = mix(col, col * .8 + sky * .08, uRain * .5);
  }

  // ---------- night: warm window light reflected off the water near the quays ----------
  if (uWin > .01) {
    vec3 Rv = reflect(-V, N);
    float glow = 0.;
    if (uHasWin && Rv.z > .05) {
      for (int k = 0; k < 4; k++) {                                         // mirrored facade points 4..22 m up
        float hgt = 4. + float(k) * 6.;
        vec4 pc = uProj * vec4(vW + Rv * (hgt / Rv.z), 1.);
        vec2 uv = pc.xy / pc.w * .5 + .5;
        glow += textureLod(tWin, uv, 3.5).r;
      }
    }
    float nearQ = exp(-sdf / 28.);
    float shim = .6 + .8 * vnoise(vec2(vW.x * .4, vW.y * .4 + t * 1.5) + slope * 6.);   // broken up by the ripples
    col += vec3(1., .58, .25) * (glow * 2.2 * shim + nearQ * .09 * smoothstep(.35, .8, vnoise(vW.xy / 22.))) * uWin * nearQ;
  }
  gl_FragColor = vec4(tone(col), 1.);
}`;

const VERT = `
attribute float sea;
varying vec3 vW; varying float vSea;
void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vSea = sea; gl_Position = projectionMatrix * viewMatrix * w; }`;

export async function createWater(ctx) {
  const U = ctx.uniforms || {};
  const tile = ctx.tile || ctx.meta?.world?.tile;
  const isSea = (o) => ctx.waterMeshes ? ctx.waterMeshes.includes(o) : /zee|sea|water/i.test(`${o.name} ${o.parent?.name || ''}`);
  const isGround = (o) => /terr|ground|grond/i.test(`${o.name} ${o.parent?.name || ''}`);

  // field: texture for the shader + pixels on the CPU to keep only the terrain triangles along the water
  const img = await new THREE.ImageLoader().loadAsync(FIELD);
  const tField = new THREE.Texture(img);
  tField.minFilter = THREE.LinearFilter; tField.generateMipmaps = false; tField.needsUpdate = true;
  const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  const c2 = cv.getContext('2d', { willReadFrequently: true });
  c2.drawImage(img, 0, 0);
  const px = c2.getImageData(0, 0, img.width, img.height).data;
  const [cx, cy] = tile.center, [rx, ry] = tile.right, [fx, fy] = tile.forward;
  const sdfAt = (x, y) => {   // nearest field pixel (row 0 = back edge)
    const u = ((x - cx) * rx + (y - cy) * ry) / tile.half_u, v = ((x - cx) * fx + (y - cy) * fy) / tile.half_v;
    if (Math.abs(u) > 1 || Math.abs(v) > 1) return -99;
    const i = Math.round((u * .5 + .5) * (img.width - 1)), j = Math.round((.5 - v * .5) * (img.height - 1));
    return px[(j * img.width + i) * 4] - 40;
  };

  const group = new THREE.Group();
  group.name = 'levende-zee';
  const shared = (k, v) => U[k] || { value: v };
  const uniforms = {
    tField: { value: tField }, uFieldPx: { value: new THREE.Vector2(2 * tile.half_u / img.width, 2 * tile.half_v / img.height) },
    uTileC: { value: new THREE.Vector2(cx, cy) }, uTileR: { value: new THREE.Vector2(rx, ry) }, uTileF: { value: new THREE.Vector2(fx, fy) },
    uTileH: { value: new THREE.Vector2(tile.half_u, tile.half_v) },
    tWin: shared('tWin', null), uHasWin: shared('uHasWin', false), uProj: shared('uProj', new THREE.Matrix4()),
    uWin: shared('uWin', 0), uSat: shared('uSat', 1.1), uExpo: shared('uExpo', 1.5), uContrast: shared('uContrast', .38),
    uKeyDir: { value: new THREE.Vector3(0, -.5, .8).normalize() }, uKeyCol: { value: new THREE.Vector3(1, .92, .8) },
    uFillCol: { value: new THREE.Vector3(.15, .18, .26) }, uAmb: { value: new THREE.Vector3(.06, .07, .1) },
    uTime: { value: 0 }, uTick: { value: 0 }, uRain: { value: 0 }, uDay: { value: 1 },
  };
  const COMMON = ctx.shader?.COMMON || `
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }`;
  const TONE = ctx.shader?.TONE || `
vec3 tone(vec3 c){ c = 1. - exp(-c * uExpo); c = pow(c, vec3(1. / 2.2)); c = mix(c, c * c * (3. - 2. * c), uContrast);
  return clamp(mix(vec3(dot(c, vec3(.2126, .7152, .0722))), c, uSat), 0., 1.); }`;
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG(COMMON, TONE), side: THREE.DoubleSide,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    blending: THREE.CustomBlending,   // keep the bloom alpha of what is underneath
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });

  const seaMat = material.clone(); seaMat.uniforms = uniforms; seaMat.polygonOffset = false;   // shared uniforms; the sea plane must not poke through low quays
  ctx.root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  ctx.root.traverse((o) => {
    if (!o.isMesh || !(isSea(o) || isGround(o))) return;
    const src = o.geometry, pos = src.attributes.position, sea = isSea(o);
    const wp = new Float32Array(pos.count * 3), keep = new Uint8Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      wp.set([v.x, v.y, v.z], i * 3);
      keep[i] = sea || sdfAt(v.x, v.y) > -30 ? 1 : 0;   // terrain: only the strip along the water (+ lakes)
    }
    const index = src.index ? src.index.array : Array.from({ length: pos.count }, (_, i) => i);
    const idx = [];
    for (let i = 0; i < index.length; i += 3) {
      const [a, b, c] = [index[i], index[i + 1], index[i + 2]];
      if (keep[a] || keep[b] || keep[c]) idx.push(a, b, c);
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(wp, 3));
    g.setAttribute('sea', new THREE.BufferAttribute(new Float32Array(pos.count).fill(sea ? 1 : 0), 1));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, sea ? seaMat : material);
    m.name = sea ? 'zee' : 'kuststrook';
    m.renderOrder = 2; m.frustumCulled = false;
    group.add(m);
  });

  let time = 0;
  return {
    mesh: group,
    update(dt, state = {}) {
      time += Math.min(dt ?? state.dt ?? 0, .1);
      uniforms.uTime.value = state.time ?? time;
      uniforms.uTick.value = state.tick ?? U.uTick?.value ?? Math.floor(time * 8);
      uniforms.uRain.value = state.rain ?? U.uRain?.value ?? 0;
      uniforms.uDay.value = state.day ?? 1;
      uniforms.uKeyDir.value.copy(state.sunDir || U.uKeyDir?.value || uniforms.uKeyDir.value);
      uniforms.uKeyCol.value.copy(state.keyColor || U.uKeyCol?.value || uniforms.uKeyCol.value);
      uniforms.uFillCol.value.copy(state.fillColor || U.uFillCol?.value || uniforms.uFillCol.value);
      uniforms.uAmb.value.copy(state.ambient || U.uAmb?.value || uniforms.uAmb.value);
      // smooth only on desktop when zoomed in; overview and iPad run on the 8 fps stop-motion clock (battery)
      return !ctx.small && (state.zoom ?? 1) > 1.3;
    },
    dispose() { tField.dispose(); material.dispose(); seaMat.dispose(); group.traverse((o) => o.geometry?.dispose()); },
  };
}

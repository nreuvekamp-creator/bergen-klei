// Ulriken-top 's nachts: de Lysdansen (kleurwisselende LED-spots op de TV-mast) + rode luchtvaartlichten + zachte gloed.
// Hook (main.js): createLights(ctx) -> { group, update(dt, state), dispose }; ctx/state zie WATER-CONTRACT.md.
// Posities in wereldmeters uit meta.json.lights.ulriken (renders-centrum), anders uit ./lights/ulriken.json (publish.sh stript meta).
// Bronnen en aannames: renders-centrum-patch/ULRIKEN.md. Stop-motion: kleuren wisselen op de 8 fps-klok (state.tick).

async function loadSpec() {
  const base = new URLSearchParams(location.search).get('data') || '../renders-centrum';
  try {
    const m = await fetch(`${base}/meta.json`, { cache: 'no-cache' }).then((r) => r.json());
    if (m?.lights?.ulriken?.points?.length) return m.lights.ulriken;
  } catch {}
  return (await fetch(new URL('./lights/ulriken.json', import.meta.url)).then((r) => r.json())).ulriken;
}

export async function createLights(ctx) {
  const parts = (await Promise.all([createUlriken(ctx), createPaths(ctx).catch((e) => { console.info('lovstien.json niet gebruikt:', e.message); return null; })])).filter(Boolean);
  const group = new ctx.THREE.Group(); group.name = 'lights'; parts.forEach((p) => group.add(p.group));
  return {
    group,
    update(dt, s) { let r = false; for (const p of parts) r = p.update(dt, s) || r; return r; },
    dispose() { parts.forEach((p) => p.dispose()); },
  };
}

// nacht-factor: vol bij nacht, zwak bij schemer, uit overdag (zelfde curve als de Ulriken-mast)
const nightK = (s) => Math.pow(Math.min(1, Math.max(0, (.62 - s.day) / .62)), 1.4);

// Løvstien + Fløyen: warme lantaarns langs de verlichte paden, gloed op de Fløyen-top, lichtjes langs Fløibanen,
// en overdag een licht grindlint over Løvstien. Posities uit ./lights/lovstien.json (centrum/patch/scripts/lights_lovstien.py).
// Bronnen en aannames: renders-centrum-patch/LOVSTIEN.md. Eén Points-draw voor de lampjes, één voor het lint.
async function createPaths(ctx) {
  const { THREE, renderer, camera } = ctx;
  const spec = (await fetch(new URL('./lights/lovstien.json', import.meta.url)).then((r) => r.json())).lovstien;
  const funi = spec.lamps.floibanen;
  // per lamp: kern (kind 0) + zachte grondgloed (kind 1, op de grond) + verre halo (kind 4, alleen uitgezoomd);
  // Fløibanen kind 2; top-gloed kind 3. emph: Løvstien nadrukkelijker dan de Fløyen-paden (daar willen ze wandelen)
  const rows = [];
  const lamp = (p, e) => { rows.push([p, 0, 5, e]); rows.push([[p[0], p[1], p[2] - spec.lamp_height_m + 1], 1, 34, e]); rows.push([p, 4, 5, e]); };
  spec.lamps.lovstien.forEach((p) => lamp(p, 1.5)); spec.lamps.floyen.forEach((p) => lamp(p, 1));
  for (const p of funi) rows.push([p, 2, 4, 1]);
  for (const g of spec.glows) rows.push([g.world, 3, g.radius_m * 3, 1]);
  const n = rows.length, pos = new Float32Array(n * 3), size = new Float32Array(n), kind = new Float32Array(n), emph = new Float32Array(n);
  rows.forEach(([p, k, sz, e], i) => { pos.set(p, i * 3); kind[i] = k; size[i] = sz; emph[i] = e; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('kind', new THREE.BufferAttribute(kind, 1));
  geo.setAttribute('emph', new THREE.BufferAttribute(emph, 1));
  const warm = new THREE.Color(spec.lamp_color).convertSRGBToLinear();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 }, uK: { value: 0 }, uTick: { value: 0 }, uCol: { value: warm }, uPx: { value: 1 } },
    vertexShader: /* glsl */`
      attribute float size, kind, emph;
      uniform float uScale, uTick, uPx;
      varying float vK, vA, vE;
      float h1(float x){ return fract(sin(x) * 43758.5453); }
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.);
        mv.xyz += normalize(-mv.xyz) * (kind > 2.5 && kind < 3.5 ? 30. : 6.);   // iets naar de camera: de grove terrein-proxy mag een lampje op het pad niet verbergen
        gl_Position = projectionMatrix * mv;
        float px = size * uScale / -mv.z;
        float e = emph > 1. ? 1. : 0.;
        // minima in CSS-pixels (uPx = drawing-buffer-pixels per CSS-pixel): uitgezoomd blijft het een zichtbaar lichtsnoer
        if (kind < .5)      { gl_PointSize = clamp(px, (3. + e) * uPx, 24. * uPx); vA = 1.; }
        else if (kind < 1.5){ gl_PointSize = min(px, 160.); vA = .7 * smoothstep(4., 20., px); }
        else if (kind < 2.5){ gl_PointSize = clamp(px, 2.6 * uPx, 16. * uPx); vA = 1.; }
        else if (kind < 3.5){ gl_PointSize = clamp(px, 18. * uPx, 150.); vA = 1.; }
        else                { gl_PointSize = (8. + 2. * e) * uPx; vA = 1. - smoothstep(4. * uPx, 9. * uPx, px); }   // verre halo, weg zodra de kern zelf groot genoeg is
        vA *= .9 + .1 * h1(position.x * 1.3 + position.y + uTick);   // klei-flakker op de 8 fps-klok
        vK = kind; vE = emph;
      }`,
    fragmentShader: /* glsl */`
      uniform float uK; uniform vec3 uCol;
      varying float vK, vA, vE;
      void main() {
        float d = length(gl_PointCoord - .5) * 2.;
        if (d > 1. || vA < .01) discard;
        bool ground = vK > .5 && vK < 1.5, top = vK > 2.5 && vK < 3.5, far = vK > 3.5;
        float halo = pow(1. - d, ground ? 2.2 : top ? 2.6 : far ? 2. : 1.6);
        float core = (vK < .5 || (vK > 1.5 && vK < 2.5)) ? smoothstep(.55, .0, d) : 0.;
        float gain = vK < .5 ? 2. : ground ? .5 : top ? .35 : far ? .55 : 1.3;
        float b = vK < .5 || far ? vE : 1.;
        vec3 c = (top ? vec3(1., .78, .42) : uCol) * (halo * gain + core * 3.2) * b * vA * uK;   // top-gloed: geler, niet roze op de daken
        gl_FragColor = vec4(c, clamp((halo * (ground ? .15 : far ? .25 : .7) + core) * vA * uK, 0., 1.));   // alpha = bloom-masker
      }`,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = -1;   // vóór de wolken (transparant, renderOrder 0): een wolk dekt de lampjes af

  // grindlint over Løvstien (overdag zichtbaar, 's nachts mee-donker); schrijft alpha niet (geen bloom)
  const R = spec.ribbon.lovstien, rgeo = new THREE.BufferGeometry();
  rgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(R.flat()), 3));
  const U = ctx.uniforms;
  const rmat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 }, uGravel: { value: new THREE.Color(spec.ribbon.color).convertSRGBToLinear() }, uW: { value: spec.ribbon.width_m },
      uKeyCol: U.uKeyCol, uFillCol: U.uFillCol, uAmb: U.uAmb, uKeyDir: U.uKeyDir, uExpo: U.uExpo, uSat: U.uSat, uContrast: U.uContrast },
    vertexShader: /* glsl */`
      uniform float uScale, uW; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.);
        mv.xyz += normalize(-mv.xyz) * 8.;   // boven de grove terrein-proxy uit, anders streepjes
        gl_Position = projectionMatrix * mv;
        float px = uW * uScale / -mv.z;
        gl_PointSize = min(px, 48.);
        vA = smoothstep(.9, 2.2, px);                       // uitgezoomd geen waas: pas als het pad een paar pixels breed is
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uGravel, uKeyCol, uFillCol, uAmb, uKeyDir; uniform float uExpo, uSat, uContrast;
      varying float vA;
      ${ctx.shader.TONE}
      void main() {
        float d = length(gl_PointCoord - .5) * 2.;
        if (d > 1. || vA < .01) discard;
        vec3 lit = uGravel * (uKeyCol * max(uKeyDir.z, 0.) + uFillCol * .6 + uAmb) * 1.25;
        gl_FragColor = vec4(tone(lit), vA * smoothstep(1., .6, d) * .9);
      }`,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,   // framebuffer-alpha (bloom-masker) ongemoeid
  });
  const ribbon = new THREE.Points(rgeo, rmat); ribbon.frustumCulled = false; ribbon.renderOrder = -2;

  const group = new THREE.Group(); group.name = 'lovstien-floyen'; group.add(ribbon, pts);
  const size2 = new THREE.Vector2();
  return {
    group,
    update(dt, s) {
      renderer.getDrawingBufferSize(size2);
      const sc = size2.y / (2 * Math.tan(camera.fov * Math.PI / 360));
      rmat.uniforms.uScale.value = mat.uniforms.uScale.value = sc;
      mat.uniforms.uPx.value = renderer.getPixelRatio();
      const k = nightK(s);
      pts.visible = k > .01;
      mat.uniforms.uK.value = k; mat.uniforms.uTick.value = s.tick % 64;
      return false;                                        // main.js tekent op camerabeweging en de stop-motion-klok
    },
    dispose() { geo.dispose(); mat.dispose(); rgeo.dispose(); rmat.dispose(); },
  };
}

async function createUlriken(ctx) {
  const { THREE, renderer, camera } = ctx;
  const spec = await loadSpec();
  const A = spec.animation; const prog = A.lysdans.program;
  const P = spec.points;
  const n = P.length + 1;                                  // + 1 grote gloed om de mast
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  P.forEach((p, i) => {
    pos.set(p.world, i * 3);
    size[i] = p.kind === 'lysdans' ? 11 : p.kind === 'obstruction_flash' ? 9 : 5;   // meters (gloeibolletje)
  });
  pos.set(spec.mast.glow_center, P.length * 3); size[P.length] = spec.mast.glow_radius_m * 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const kindA = new Float32Array(n); kindA[P.length] = 1;  // 1 = brede gloed (zachter profiel)
  geo.setAttribute('wide', new THREE.BufferAttribute(kindA, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 }, uK: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 color; attribute float size; attribute float wide;
      uniform float uScale;
      varying vec3 vC; varying float vW;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.);
        mv.xyz += normalize(-mv.xyz) * (8. + 30. * wide);   // iets naar de camera: de mast-proxy in scene.glb mag het lampje niet verbergen
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(size * uScale / -mv.z, wide > .5 ? 34. : 4., wide > .5 ? 260. : 56.);
        vC = color; vW = wide;
      }`,
    fragmentShader: /* glsl */`
      uniform float uK;
      varying vec3 vC; varying float vW;
      void main() {
        float d = length(gl_PointCoord - .5) * 2.;
        if (d > 1.) discard;
        float halo = pow(1. - d, vW > .5 ? 1.6 : 1.6);
        float core = vW > .5 ? 0. : smoothstep(.42, .0, d);
        vec3 c = vC * (halo * (vW > .5 ? .8 : 1.4) + core * 2.6) * uK;
        gl_FragColor = vec4(c, clamp((halo * (vW > .5 ? .3 : .9) + core) * uK, 0., 1.));   // alpha = bloom-masker
      }`,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = -1;   // vóór de wolken (transparant, renderOrder 0): een wolk dekt de lampjes af
  const group = new THREE.Group(); group.name = 'ulriken-lights'; group.add(pts); group.visible = false;

  const hex = (h) => new THREE.Color(h).convertSRGBToLinear();
  const progC = prog.map((s) => ({ ...s, c: s.colors.map(hex) }));
  const total = prog.reduce((a, s) => a + s.seconds, 0);
  const red = hex(A.obstruction_flash.color), off = new THREE.Color(0, 0, 0);
  const tmp = new THREE.Color(), glow = new THREE.Color(), size2 = new THREE.Vector2();
  let lastTick = -1;

  function paint(tick) {
    const t = tick / A.fps;                                // stop-motion tijd
    let tt = t % total, k = 0;
    while (tt >= progC[k].seconds) { tt -= progC[k].seconds; k++; }
    const ph = progC[k], climb = Math.min(1, tt / A.lysdans.climb_seconds);
    glow.setRGB(0, 0, 0); let nOn = 0;
    P.forEach((p, i) => {
      if (p.kind === 'lysdans') {
        const on = p.h <= climb + 1e-3;
        if (!on) tmp.copy(off);
        else if (ph.c.length > 1) tmp.copy(ph.c[Math.floor((p.h * ph.c.length + t * .5) % ph.c.length)]);   // regenboog schuift omhoog
        else tmp.copy(ph.c[0]).multiplyScalar(.85 + .15 * Math.sin(t * 3 + p.h * 9));                       // klei-flakker
        if (on) { glow.add(tmp); nOn++; }
      } else if (p.kind === 'obstruction_flash') {
        tmp.copy((t % A.obstruction_flash.period_s) < A.obstruction_flash.on_s ? red : off).multiplyScalar(1.6);
      } else tmp.copy(red).multiplyScalar(.7);
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
    });
    if (nOn) glow.multiplyScalar(1 / nOn);
    col.set([glow.r, glow.g, glow.b], P.length * 3);
    geo.attributes.color.needsUpdate = true;
  }

  return {
    group,
    update(dt, s) {
      // nacht vol, schemer zwak, dag uit
      const k = nightK(s);
      group.visible = k > .01;
      if (!group.visible) return false;
      mat.uniforms.uK.value = k;
      renderer.getDrawingBufferSize(size2);
      mat.uniforms.uScale.value = size2.y / (2 * Math.tan(camera.fov * Math.PI / 360));
      if (s.tick !== lastTick) { lastTick = s.tick; paint(s.tick); }
      return false;                                        // main.js tekent toch al op elke stop-motion-tik
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

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
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = 10;
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
      const k = Math.pow(Math.min(1, Math.max(0, (.62 - s.day) / .62)), 1.4);
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

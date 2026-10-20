// Fontein in Lille Lungegårdsvann (Smålungeren): 21 dysen (1 middenstraal + 20 schuin naar buiten) als glazen/hars-druppels
// die op de 8 fps-klok omhoog spuiten en terugvallen, plus kringen en schuim op het water. 's Nachts aangelicht (36 spots).
// Aangeroepen door lights.js; ctx/state zie WATER-CONTRACT.md. Bronnen en aannames: renders-centrum-patch/FONTEIN.md.
// Kosten: 3 draw calls (druppels dag, druppels nacht-gloed, één waterquad), ~420 punten, geen textures.

const XY = [-417.89, 103.51];       // OSM node/260878964 (amenity=fountain), 60.390354 N 5.3285048 E, UTM32N min oorsprong
const H_MID = 12, H_RING = 4.5, RING_EL = 65, R_POOL = 13;   // meters / graden: aanname (geen bron voor de hoogte)
const N_MID = 200, N_RING = 8, N_FOAM = 24, G = 9.81;
const SCALE = 2.5;                    // miniatuur-overdrijving: echt 12 m is op het diepste zoomniveau (zoom 4) maar ~10 CSS-px; aanname, zie FONTEIN.md

export async function createFountain(ctx) {
  const { THREE, renderer, camera } = ctx;
  // waterspiegel: straal omlaag op de water-meshes (v2 en v3 hebben hetzelfde wereldstelsel, maar meet het toch)
  const ray = new THREE.Raycaster(new THREE.Vector3(XY[0], XY[1], 500), new THREE.Vector3(0, 0, -1));
  ctx.root?.updateMatrixWorld?.(true);
  const hit = ray.intersectObjects(ctx.waterMeshes?.length ? ctx.waterMeshes : [ctx.root], true)[0];
  const z0 = hit ? hit.point.z : 2;

  // per punt: nozzle-snelheid (vx, vy, vz), fase, soort (0 druppel, 1 schuim), grootte (m)
  const rows = [];
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const vMid = Math.sqrt(2 * G * H_MID);
  for (let i = 0; i < N_MID; i++) rows.push([0, 0, vMid * (.86 + .14 * rnd()), rnd(), 0, .55 + .5 * rnd()]);
  const el = RING_EL * Math.PI / 180, vR = Math.sqrt(2 * G * H_RING) / Math.sin(el);
  const THROW = vR * Math.cos(el) * 2 * vR * Math.sin(el) / G;            // waar de schuine stralen landen (m, onoverdreven)
  for (let j = 0; j < 20; j++) {
    const az = j / 20 * Math.PI * 2;
    for (let i = 0; i < N_RING; i++) {
      const v = vR * (.9 + .1 * rnd());
      rows.push([Math.cos(az) * Math.cos(el) * v, Math.sin(az) * Math.cos(el) * v, Math.sin(el) * v, rnd(), 0, .45 + .35 * rnd()]);
    }
  }
  for (let i = 0; i < N_FOAM; i++) { const a = rnd() * 6.283, r = 1 + 4 * Math.sqrt(rnd()); rows.push([Math.cos(a) * r, Math.sin(a) * r, 0, rnd(), 1, 1.4 + 1.4 * rnd()]); }
  const n = rows.length, vel = new Float32Array(n * 3), aux = new Float32Array(n * 3), pos = new Float32Array(n * 3);
  rows.forEach(([x, y, z, ph, k, sz], i) => { vel.set([x, y, z], i * 3); aux.set([ph, k, sz], i * 3); pos.set([XY[0], XY[1], z0], i * 3); });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('vel', new THREE.BufferAttribute(vel, 3));
  geo.setAttribute('aux', new THREE.BufferAttribute(aux, 3));

  const U = ctx.uniforms;
  const shared = { uT: { value: 0 }, uScale: { value: 1 }, uPx: { value: 1 }, uK: { value: 0 } };
  const VERT = /* glsl */`
    attribute vec3 vel, aux;
    uniform float uT, uScale, uPx;
    varying float vKind, vA, vSeed, vH;
    float h1(float x){ return fract(sin(x) * 43758.5453); }
    void main() {
      vec3 p = position; float kind = aux.y, seed = aux.x;
      float T = kind > .5 ? 1.2 : 2. * vel.z / ${G.toFixed(2)};          // vliegtijd; schuim: 1,2 s opbollen
      float ph = fract(seed + uT / T), t = ph * T;
      float cyc = floor(seed * 97. + uT / T);                            // elke ronde andere zijwaartse spreiding
      vec2 j = vec2(h1(cyc + seed * 31.), h1(cyc * 1.7 + seed * 13.)) - .5;
      if (kind < .5) {
        vec3 d = vel * t; d.z -= .5 * ${G.toFixed(2)} * t * t;
        d.xy += j * (.3 + 2.2 * smoothstep(.35, 1., t / T)) * (vel.x == 0. && vel.y == 0. ? 1. : .5);   // smalle zuil, waaiert pas bij het terugvallen uit
        p += d * ${SCALE.toFixed(2)};
        vH = clamp((p.z - position.z) / ${H_MID}., 0., 1.);
        vA = smoothstep(0., .04, ph) * smoothstep(1., .9, ph);
      } else {
        p.xy += (vel.xy + j * 1.5) * ${SCALE.toFixed(2)}; p.z += .15 + .6 * sin(ph * 3.1416);    // watten-schuim dat op en neer bolt
        vH = 0.; vA = sin(ph * 3.1416);
      }
      vec4 mv = modelViewMatrix * vec4(p, 1.);
      mv.xyz += normalize(-mv.xyz) * 2.;                                 // boven de waterlaag uit
      gl_Position = projectionMatrix * mv;
      float px = aux.z * ${(SCALE * .75).toFixed(2)} * uScale / -mv.z;
      gl_PointSize = clamp(px, (kind > .5 ? 1.6 : 1.3) * uPx, 40. * uPx);
      vA *= min(1., px / (1.3 * uPx) + .35);                              // uitgezoomd: kleiner dan een pixel = zachter, niet weg
      vKind = kind; vSeed = seed;
    }`;
  // dag: glanzende half-doorzichtige druppel (lichte kern, donkere rand, glimlicht linksboven) of watten-schuim; laat de bloom-alpha ongemoeid
  const dayMat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uKeyCol: U.uKeyCol, uFillCol: U.uFillCol, uAmb: U.uAmb, uKeyDir: U.uKeyDir, uExpo: U.uExpo, uSat: U.uSat, uContrast: U.uContrast },
    vertexShader: VERT,
    fragmentShader: /* glsl */`
      uniform vec3 uKeyCol, uFillCol, uAmb, uKeyDir; uniform float uExpo, uSat, uContrast;
      varying float vKind, vA, vSeed, vH;
      ${ctx.shader.TONE}
      void main() {
        vec2 q = gl_PointCoord - .5; float d = length(q) * 2.;
        if (d > 1. || vA < .01) discard;
        vec3 light = uKeyCol * (.45 + .55 * max(uKeyDir.z, 0.)) + uFillCol * .7 + uAmb;
        vec3 c; float a;
        if (vKind < .5) {
          vec3 glass = mix(vec3(.62, .82, .86), vec3(.9, .97, 1.), vH);    // hoog in de straal witter (lucht erin)
          float rim = smoothstep(.55, 1., d);
          float spec = smoothstep(.32, .0, length(q - vec2(-.16, -.18)));
          c = glass * light * (1.05 - .45 * rim) + spec * (uKeyCol + uFillCol) * .9;
          a = mix(.55, .8, rim) * smoothstep(1., .82, d);
        } else {
          float fl = .75 + .25 * fract(sin(dot(floor(q * 5.), vec2(12.9, 78.2)) + vSeed * 91.) * 43758.5);   // pluizige rand
          c = vec3(.95, .97, .97) * light * 1.1;
          a = smoothstep(1., .45, d * (1.1 - .2 * fl)) * .85;
        }
        gl_FragColor = vec4(tone(c), a * vA);
      }`,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  // nacht: de spots (onder water, wit; aanname) laten de druppels gloeien; alpha = bloom-masker
  const nightMat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uCol: { value: new THREE.Color('#e6f1ff').convertSRGBToLinear() } },
    vertexShader: VERT,
    fragmentShader: /* glsl */`
      uniform float uK; uniform vec3 uCol;
      varying float vKind, vA, vSeed, vH;
      void main() {
        float d = length(gl_PointCoord - .5) * 2.;
        if (d > 1. || vA < .01) discard;
        float g = pow(1. - d, 1.5) * (vKind > .5 ? .5 : 1.) * (1. - .55 * vH);   // spots van onderaf: onder feller
        gl_FragColor = vec4(uCol * g * 1.6 * vA * uK, clamp(g * .5 * vA * uK, 0., 1.));
      }`,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
  });

  // water: kringen die van de valzone uitlopen + schuim rond de voet, één platte quad op de waterspiegel
  const disc = new THREE.PlaneGeometry(R_POOL * 2, R_POOL * 2);
  const discMat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uKeyCol: U.uKeyCol, uFillCol: U.uFillCol, uAmb: U.uAmb, uExpo: U.uExpo, uSat: U.uSat, uContrast: U.uContrast,
      uCol: nightMat.uniforms.uCol },
    vertexShader: /* glsl */`
      varying vec2 vP;
      void main() { vP = position.xy; vec4 mv = modelViewMatrix * vec4(position, 1.); mv.xyz += normalize(-mv.xyz) * 1.5; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      uniform float uT, uK, uExpo, uSat, uContrast; uniform vec3 uKeyCol, uFillCol, uAmb, uCol;
      varying vec2 vP;
      ${ctx.shader.COMMON}
      ${ctx.shader.TONE}
      void main() {
        float r = length(vP), R = ${R_POOL}.;
        if (r > R) discard;
        float rings = 0.;
        for (int i = 0; i < 3; i++) {                                    // drie kringen, elk 2,4 s van 4 m naar de rand
          float f = fract(uT / 2.4 + float(i) / 3.), rr = 4. + f * (R - 4.5);
          rings += smoothstep(.45, 0., abs(r - rr)) * (1. - f) * .8;
        }
        float lace = vnoise(vP * .9 + floor(uT * 8.) * 3.17);              // schuim kookt mee op de 8 fps-klok
        float foam = smoothstep(.42, .78, lace) * smoothstep(7.5, 2.5, r) + smoothstep(2.6, 0., r);
        float ringFoam = smoothstep(1.6, .4, abs(r - ${THROW.toFixed(2)}) + (1. - lace) * 1.5) * .45;   // landingszone van de 20 schuine stralen
        float a = clamp(max(foam, ringFoam) * .8 + rings * .45, 0., .85) * smoothstep(R, R - 2., r);
        if (a < .01) discard;
        vec3 light = uKeyCol * .6 + uFillCol * .8 + uAmb;
        vec3 c = tone(vec3(.9, .95, .95) * light) + uCol * uK * .55 * (foam + rings * .5);
        gl_FragColor = vec4(c, a);
      }`,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const pool = new THREE.Mesh(disc, discMat); pool.position.set(XY[0], XY[1], z0 + .05); pool.scale.setScalar(SCALE); pool.renderOrder = 3; pool.frustumCulled = false;   // na water.js (transparant, renderOrder 2), anders dekt het water alles af
  const drops = new THREE.Points(geo, dayMat), glow = new THREE.Points(geo, nightMat);
  drops.renderOrder = 4; glow.renderOrder = 5; drops.frustumCulled = glow.frustumCulled = false;
  const group = new THREE.Group(); group.name = 'fontein'; group.add(pool, drops, glow);
  const size2 = new THREE.Vector2(), FPS = ctx.FPS || 8;
  const nightK = (s) => Math.pow(Math.min(1, Math.max(0, (.62 - s.day) / .62)), 1.4);
  return {
    group, z0,
    update(dt, s) {
      renderer.getDrawingBufferSize(size2);
      shared.uScale.value = size2.y / (2 * Math.tan(camera.fov * Math.PI / 360));
      shared.uPx.value = renderer.getPixelRatio();
      shared.uT.value = (s.tick % (FPS * 3600)) / FPS;                  // stop-motion: alleen op de klok-tik verder
      shared.uK.value = nightK(s); glow.visible = shared.uK.value > .01;
      return false;                                                     // main.js tekent al op elke tik
    },
    dispose() { geo.dispose(); disc.dispose(); dayMat.dispose(); nightMat.dispose(); discMat.dispose(); },
  };
}

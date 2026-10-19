// Intro: Bergen tells Tess, on a white page, that it is ill; only at the last step does the map open up.
// Loaded as a classic script in <head>, so the white page is decided before anything paints (no flash of the old loader).
// First visit: intro. Afterwards straight to the map (remembered in localStorage); #intro in the URL always forces it.
// Menu: "Verhaal opnieuw". Map readiness: 'klei:ready' / 'klei:progress' events if main.js sends them, else #load getting .gone.
(() => {
  const KEY = 'bergen-klei-intro';
  const FIG = (n) => `intro/${n}.webp`;
  const STEPS = [
    { fig: '01_ernstig_ziek', label: 'Opname', say: 'Goedemiddag, dokter. Ik ben Bergen, 956 jaar oud, en het gaat niet goed met me.' },
    { fig: '02_hoestend', label: 'Hoofdklacht', say: 'Sinds augustus zijn hier geen leuke dates meer gehouden. De klachten nemen toe, vooral in de avonduren.' },
    { fig: '03_koortsig', label: 'Werkdiagnose', say: 'Aan de regen ligt het niet; die is er al sinds 1070. Uw assistent houdt het op <em>Anerosis bergensis</em>: een tekort aan dates.',
      note: 'Gr. an-, zonder; eros, liefde. Fictieve aandoening, komt in geen enkel handboek voor.' },
    { fig: '04_herstellend', label: 'Behandelteam', say: 'Gelukkig is de behandelend arts net geland (u), met Niels als assistent. De therapie: samen plekken in de stad bezoeken; bijwerkingen zijn meestal aangenaam.' },
  ];
  const FINAL = { fig: '05_hoopvol', label: 'Behandelplan', say: 'Elke kleimarker op de kaart is een behandeling. Tik erop voor het recept; welke eerst, bepaalt de dokter.' };
  const WAIT = { fig: '04_herstellend', label: 'Even geduld', say: 'De stad wordt nog in klei gezet. Ik wacht zolang hier, met thee.' };
  const N = STEPS.length + 1;

  let seen = false;
  try { seen = localStorage.getItem(KEY) === '1'; } catch {}
  const forced = location.hash === '#intro';
  if (!seen || forced) document.documentElement.classList.add('intro-on');

  let ready = false, progress = 0, el, i = 0, mode = 'off', onReady = null;
  const setReady = () => { if (ready) return; ready = true; if (onReady) { const f = onReady; onReady = null; f(); } };
  addEventListener('klei:ready', setReady);
  addEventListener('klei:progress', (e) => { const v = +(e.detail?.progress ?? e.detail); if (v >= 0) setProgress(v > 1 ? v / 100 : v); });
  function setProgress(f) { progress = Math.max(progress, Math.min(1, f)); if (el) el.querySelector('.bar i').style.transform = `scaleX(${progress})`; }

  function build() {
    el = document.getElementById('intro') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'intro' }));
    el.removeAttribute('style'); el.className = '';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Intro: Bergen vertelt');
    el.innerHTML = `<div class="veil"></div>
      <div class="mark"><b>℞</b>Dossier Bergen</div>
      <button class="skip" type="button">Overslaan</button>
      <div class="stage">
        <div class="fig">${[...new Set([...STEPS, FINAL, WAIT].map((s) => s.fig))].map((f) => `<img src="${FIG(f)}" data-f="${f}" alt="">`).join('')}</div>
        <div class="bubble" aria-live="polite"><div class="label"><span></span><span></span></div><p class="say"></p><p class="note"></p><div class="bar"><i></i></div></div>
        <div class="next"></div>
        <div class="dots">${'<i></i>'.repeat(N)}</div>
      </div>
      <div class="final"><img src="${FIG(FINAL.fig)}" alt="Bergen kijkt hoopvol omhoog naar een regenboog en de zon">
        <div class="label"><span>${FINAL.label}</span><span>${N} van ${N}</span></div><p class="say">${FINAL.say}</p>
        <button type="button">Begin de behandeling</button></div>`;
    setProgress(progress);

    // tap = next, swipe left/right = next/back; buttons and the final card handle themselves
    if (!el.dataset.wired) wire(el);
    el.querySelector('.skip').onclick = () => (mode === 'story' || mode === 'wait') && toFinal(true);
    el.querySelector('.final button').onclick = finish;
    addEventListener('keydown', onKey, true);
  }
  function wire(root) {   // once per element: replays reuse #intro
    root.dataset.wired = '1';
    let down = null;
    root.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    root.addEventListener('pointerup', (e) => {
      if (!down || mode !== 'story' || e.target.closest('button')) return (down = null);
      const dx = e.clientX - down.x, dy = e.clientY - down.y; down = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      else if (Math.hypot(dx, dy) < 12) go(1);
    });
  }
  function onKey(e) {
    if (mode === 'off') return;
    if (e.key === 'Escape') { e.stopPropagation(); mode === 'final' ? finish() : toFinal(true); }
    else if (mode === 'story' && (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); go(1); }
    else if (mode === 'story' && e.key === 'ArrowLeft') go(-1);
  }

  function show(s, k) {
    el.querySelectorAll('.fig img').forEach((im) => im.classList.toggle('on', im.dataset.f === s.fig));
    const b = el.querySelector('.bubble');
    b.querySelector('.label span').textContent = s.label;
    b.querySelector('.label span:last-child').textContent = k ? `${k} van ${N}` : '';
    b.querySelector('.say').innerHTML = s.say;
    b.querySelector('.note').textContent = s.note || '';
    b.classList.remove('swap'); void b.offsetWidth; b.classList.add('swap');
    el.querySelectorAll('.dots i').forEach((d, j) => d.classList.toggle('on', j === (k || N) - 1));
    el.querySelector('.next').textContent = k === 1 ? 'tik om verder te gaan' : '';
  }
  function go(d) {
    const n = i + d;
    if (n < 0) return;
    if (n >= STEPS.length) return toFinal(false);
    i = n; show(STEPS[i], i + 1);
  }
  function toFinal(skipped) {
    if (ready || errShown()) return reveal(skipped);
    mode = 'wait'; el.classList.add('waiting'); show(WAIT, 0);
    onReady = () => reveal(skipped);
  }
  // the white page opens like an iris around the figure, then the last line sits on a card over the map
  function reveal(skipped) {
    el.classList.remove('waiting');
    try { localStorage.setItem(KEY, '1'); } catch {}
    mode = 'final';
    const r = el.querySelector('.fig').getBoundingClientRect(), veil = el.querySelector('.veil');
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const max = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy)) + 40;
    el.classList.add('open');
    const t0 = performance.now(), D = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 1300;
    (function step(t) {
      const p = Math.min(1, (t - t0) / D), e = p < .5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
      const rad = e * max, m = `radial-gradient(circle at ${cx}px ${cy}px, transparent ${rad}px, #000 ${rad + 28}px)`;
      veil.style.webkitMaskImage = veil.style.maskImage = m;
      if (p < 1) requestAnimationFrame(step); else veil.style.visibility = 'hidden';
    })(t0);
    setTimeout(() => addEventListener('pointerdown', outside, true), 400);
  }
  function outside(e) { if (!e.target.closest('#intro .final')) finish(); }
  function finish() {
    if (mode === 'off') return;
    mode = 'off';
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', onKey, true);
    el.style.transition = 'opacity .35s'; el.style.opacity = '0';
    setTimeout(() => { document.documentElement.classList.remove('intro-on'); el.replaceChildren(); el = null; }, 380);
    // main.js shows its one-time gesture hint ~1s after load; if that happened behind the intro, show it again now
    const h = document.getElementById('hint');
    if (h?.textContent && h.classList.contains('gone')) { h.classList.remove('gone'); setTimeout(() => h.classList.add('gone'), 8000); }
  }
  const errShown = () => { const e = document.getElementById('err'); return !!e && !e.hidden; };

  function start(replay) {
    if (el) return;
    document.documentElement.classList.add('intro-on');
    build(); i = 0; mode = 'story'; show(STEPS[0], 1);
    if (replay) { el.classList.add('fadein'); requestAnimationFrame(() => requestAnimationFrame(() => el?.classList.remove('fadein'))); }
  }

  function watch() {
    const load = document.getElementById('load'), err = document.getElementById('err');
    const check = () => {
      const v = load && +load.getAttribute('aria-valuenow');
      if (v) setProgress(v / 100);
      if (load?.classList.contains('gone') || errShown()) setReady();
    };
    const mo = new MutationObserver(check);
    if (load) mo.observe(load, { attributes: true, attributeFilter: ['class', 'aria-valuenow'] });
    if (err) mo.observe(err, { attributes: true, attributeFilter: ['hidden'] });
    check();
  }
  function addMenuItem() {
    const menu = document.getElementById('menu');
    if (!menu) return;
    const row = document.createElement('button');
    row.className = 'row'; row.id = 'intro-row'; row.type = 'button';
    row.innerHTML = '<span class="ico">℞</span>Verhaal opnieuw';
    row.onclick = () => { document.getElementById('menu-close')?.click(); start(true); };
    menu.append(document.createElement('hr'), row);
  }

  document.addEventListener('DOMContentLoaded', () => {
    watch(); addMenuItem();
    if (document.documentElement.classList.contains('intro-on')) start(false);
  });
  window.__intro = { start: () => start(true), get mode() { return mode; }, get ready() { return ready; } };   // for tests
})();

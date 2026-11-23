{
const VF = Vex.Flow;
const $ = id => document.getElementById(id);
const TPQ = RCore.TPQ;
const store = {
  get(k, d) { try { const v = localStorage.getItem('rytmy:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('rytmy:' + k, JSON.stringify(v)); } catch (e) {} }
};
const DEFAULT_BPM = { '4/4': 72, '3/4': 72, '5/4': 72, '4/8': 72, '6/8': 104, '5/8': 96 };
const VALUE_NAME = { 1: 'cała nuta', 2: 'półnuta', 4: 'ćwierćnuta', 8: 'ósemka', 16: 'szesnastka', 32: 'trzydziestodwójka' };

let cur = Math.min(25, Math.max(1, store.get('ex', 1)));
let from = 0;
let parsed = null;
let result = null;
let tempos = store.get('tempos', {});
let best = store.get('best', {});
let sens = 0.5;
let layout = null;        // { svg, staves[], points[measure] = [[tick,x]], lineY[measure] }
let lastRecording = null; // {samples, sr}
let lastRecordingHadTempo = false;

/* ---------------- wybór ćwiczenia ---------------- */
function buildPicker() {
  $('picker').innerHTML = RHYTHMS.map(r => {
    const b = best[r.n];
    const cls = b == null ? '' : b >= 90 ? 'ok' : b >= 70 ? 'mid' : 'low';
    return `<button class="pk" data-n="${r.n}" aria-current="${r.n === cur}" aria-label="Ćwiczenie ${r.n}, metrum ${r.ts}"><b>${r.n}</b><small>${r.ts}</small><span class="dot ${cls}"></span></button>`;
  }).join('');
}
$('picker').addEventListener('click', e => { const b = e.target.closest('.pk'); if (b) select(+b.dataset.n); });
$('prev').onclick = () => select(cur > 1 ? cur - 1 : 25);
$('next').onclick = () => select(cur < 25 ? cur + 1 : 1);

function rhythm() { return RHYTHMS.find(r => r.n === cur); }
function bpm() { const r = rhythm(); return tempos[r.n] || DEFAULT_BPM[r.ts] || 72; }
function unitSym() {
  const flag = parsed.den === 8 ? '<path d="M9.2 1.5c0 3 4.3 3.6 3.3 8.2-.2-3-1.8-4-3.3-4.4z" fill="currentColor"/>' : '';
  return `<svg class="nico" viewBox="0 0 14 18" aria-label="${parsed.den === 8 ? 'ósemka' : 'ćwierćnuta'}"><ellipse cx="5.2" cy="14.4" rx="4.3" ry="3" transform="rotate(-22 5.2 14.4)" fill="currentColor"/><path d="M8.6 13.6V1.5h1.1v12.1z" fill="currentColor"/>${flag}</svg>`;
}
function secPerTick() { return (60 / bpm()) * (parsed.den / 4) / TPQ; }

function select(n) {
  stopAll();
  cur = n; store.set('ex', n);
  const r = rhythm();
  parsed = RCore.parseRhythm(r.d, r.ts);
  from = 0; result = null;
  $('title').textContent = 'Ćwiczenie ' + n;
  $('meter').textContent = r.ts;
  $('origImg').src = 'img/ex' + String(n).padStart(2, '0') + '.png';
  document.querySelectorAll('.pk').forEach(b => b.setAttribute('aria-current', +b.dataset.n === n));
  const pk = document.querySelector(`.pk[data-n="${n}"]`);
  if (pk) pk.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  $('results').classList.add('hidden');
  $('legend').classList.add('hidden');
  updateTempo();
  renderScore();
  updateFromChip();
}

/* ---------------- tempo ---------------- */
function updateTempo() {
  $('tLabel').innerHTML = `${unitSym()} = ${bpm()}`;
  $('tRange').value = bpm();
}
function setTempo(v) {
  v = Math.max(30, Math.min(200, Math.round(v)));
  tempos[cur] = v; store.set('tempos', tempos); updateTempo();
  if (playing) { const keep = playing.kind; stopAll(); if (keep === 'play') play(); }
}
$('tMinus').onclick = () => setTempo(bpm() - 4);
$('tPlus').onclick = () => setTempo(bpm() + 4);
$('tRange').oninput = e => setTempo(+e.target.value);

/* ---------------- zapis nutowy (VexFlow) ---------------- */
function noteW(e) {
  const alone = !e.rest && e.val >= 8 && !parsed.events.some(o => o !== e && o.beam === e.beam && !o.rest);
  return ({ 1: 38, 2: 30, 4: 26, 8: 22, 16: 19, 32: 18 })[e.val] + (e.dots ? 6 : 0) + (alone ? 5 : 0) + (e.rest ? 2 : 0);
}

function renderScore() {
  const box = $('score');
  box.innerHTML = '';
  const W = Math.max(280, Math.floor(box.clientWidth));
  const ms = parsed.measures;
  const nat = ms.map(m => 14 + m.reduce((s, e) => s + noteW(e), 0));
  const head = k => (k === 0 ? 52 : 28);
  // podział na linie
  const lines = [];
  let line = [], used = 0;
  ms.forEach((m, k) => {
    const w = nat[k] + (line.length ? 0 : head(k));
    if (line.length && (used + w) * 0.86 > W) { lines.push(line); line = []; used = 0; }
    const w2 = nat[k] + (line.length ? 0 : head(k));
    line.push({ k, w: w2 }); used += w2;
  });
  lines.push(line);
  const lineH = 100, top = 0;
  const renderer = new VF.Renderer(box, VF.Renderer.Backends.SVG);
  renderer.resize(W, lines.length * lineH + 14);
  const ctx = renderer.getContext();
  const svg = box.querySelector('svg');
  const vfOf = new Map();
  const staves = [];
  const ties = [];
  lines.forEach((ln, li) => {
    const tot = ln.reduce((s, x) => s + x.w, 0);
    const scale = (li < lines.length - 1 || tot > W * 0.55) ? (W - 8) / tot : Math.min(1.25, (W - 8) / tot);
    let x = 6;
    ln.forEach(({ k, w }) => {
      const sw = w * scale;
      const st = new VF.Stave(x, top + li * lineH, sw, { space_above_staff_ln: 3.2, space_below_staff_ln: 2 });
      st.setConfigForLines([0, 1, 2, 3, 4].map(i => ({ visible: i === 2 })));
      if (ln[0].k === k) st.addClef('percussion');
      if (k === 0) st.addTimeSignature(rhythm().ts);
      st.setBegBarType(VF.Barline.type.NONE);
      st.setEndBarType(k === ms.length - 1 ? VF.Barline.type.END : VF.Barline.type.SINGLE);
      st.setMeasure(k + 1);
      st.setContext(ctx).draw();
      staves[k] = st;
      const evs = ms[k];
      const notes = evs.map(e => {
        const n = new VF.StaveNote({ keys: ['b/4'], duration: String(e.val) + 'd'.repeat(e.dots) + (e.rest ? 'r' : ''), stem_direction: 1, auto_stem: false });
        if (e.dots) VF.Dot.buildAndAttach([n], { all: true });
        vfOf.set(e, n);
        return n;
      });
      // triole
      const tups = [];
      const byTup = new Map();
      evs.forEach((e, i) => { if (e.tup) { if (!byTup.has(e.tup)) byTup.set(e.tup, []); byTup.get(e.tup).push(notes[i]); } });
      byTup.forEach((arr, id) => {
        const es = evs.filter(e => e.tup === id);
        const mixed = es.some(e => e.val !== es[0].val);
        tups.push(new VF.Tuplet(arr, { num_notes: 3, notes_occupied: 2, bracketed: mixed, ratioed: false, location: VF.Tuplet.LOCATION_TOP }));
      });
      // belki
      const beams = [];
      const byBeam = new Map();
      evs.forEach((e, i) => { if (!e.rest && e.val >= 8) { if (!byBeam.has(e.beam)) byBeam.set(e.beam, []); byBeam.get(e.beam).push(notes[i]); } });
      byBeam.forEach(arr => { if (arr.length > 1) { const bm = new VF.Beam(arr, false); bm.render_options.flat_beams = true; beams.push(bm); } });
      const voice = new VF.Voice({ num_beats: parsed.num, beat_value: parsed.den }).setMode(VF.Voice.Mode.SOFT);
      voice.addTickables(notes);
      new VF.Formatter().joinVoices([voice]).formatToStave([voice], st);
      voice.draw(ctx, st);
      beams.forEach(b => b.setContext(ctx).draw());
      tups.forEach(t => t.setContext(ctx).draw());
      x += sw;
    });
  });
  // ligatury (także przez kreskę taktową i koniec linii)
  const lineOf = k => lines.findIndex(l => l.some(x => x.k === k));
  parsed.events.forEach((e, idx) => {
    if (!e.tieNext) return;
    const nx = parsed.events[idx + 1];
    if (!nx) return;
    const a = vfOf.get(e), b = vfOf.get(nx);
    const mk = o => { const t = new VF.StaveTie(o); t.setDirection(1); t.setContext(ctx).draw(); };
    if (lineOf(e.m) === lineOf(nx.m)) mk({ first_note: a, last_note: b, first_indices: [0], last_indices: [0] });
    else { mk({ first_note: a, first_indices: [0] }); mk({ last_note: b, last_indices: [0] }); }
  });
  // elementy SVG nut i położenia w poziomie
  const points = [], lineY = [];
  parsed.events.forEach(e => {
    const n = vfOf.get(e);
    e.el = n.getSVGElement ? n.getSVGElement() : n.getAttribute('el');
    e.x = noteCenterX(n);
    (points[e.m] = points[e.m] || []).push([e.start, e.x]);
  });
  ms.forEach((m, k) => {
    const st = staves[k];
    lineY[k] = st.getYForLine(2);
    points[k].unshift([m[0].mStart, st.getNoteStartX()]);
    points[k].push([m[0].mStart + parsed.measureTicks, st.getNoteEndX()]);
  });
  // warstwy: zaznaczenie taktu startowego (pod spodem) i pola dotyku (na wierzchu)
  const NS = 'http://www.w3.org/2000/svg';
  const under = document.createElementNS(NS, 'g'); svg.insertBefore(under, svg.firstChild);
  const marks = document.createElementNS(NS, 'g'); svg.appendChild(marks);
  const hits = document.createElementNS(NS, 'g'); svg.appendChild(hits);
  const mrects = [];
  const nowRect = document.createElementNS(NS, 'rect');
  nowRect.setAttribute('class', 'mnow'); nowRect.setAttribute('stroke', 'none'); nowRect.setAttribute('rx', 8); nowRect.setAttribute('height', 80); nowRect.setAttribute('width', 0);
  under.appendChild(nowRect);
  ms.forEach((m, k) => {
    const st = staves[k];
    const x0 = k === 0 || lines.some(l => l[0].k === k) ? st.getNoteStartX() - 6 : st.getX();
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x0); r.setAttribute('y', lineY[k] - 46); r.setAttribute('width', st.getX() + st.getWidth() - x0); r.setAttribute('height', 80);
    r.setAttribute('class', 'mhit'); r.setAttribute('stroke', 'none'); r.dataset.m = k;
    mrects[k] = { x: x0, y: lineY[k] - 46, w: st.getX() + st.getWidth() - x0 };
    hits.appendChild(r);
    if (k === from && from > 0) {
      const s = r.cloneNode(); s.setAttribute('class', 'msel'); s.setAttribute('stroke', 'none'); s.setAttribute('rx', 8); under.appendChild(s);
    }
  });
  layout = { svg, staves, points, lineY, marks, mrects, nowRect };
  if (result) paintResult();
}
function markMeasure(k) {
  if (!layout) return;
  const r = layout.nowRect, g = k == null ? null : layout.mrects[k];
  if (!g) { r.setAttribute('width', 0); return; }
  r.setAttribute('x', g.x); r.setAttribute('y', g.y); r.setAttribute('width', g.w);
}
function noteCenterX(n) {
  try {
    if (n.isRest && n.isRest()) { const bb = n.getBoundingBox(); return bb.getX() + bb.getW() / 2; }
    return (n.getNoteHeadBeginX() + n.getNoteHeadEndX()) / 2;
  } catch (e) { return n.getAbsoluteX() + 6; }
}
function xAt(m, tick) {
  const p = layout.points[m];
  for (let i = 1; i < p.length; i++) if (tick <= p[i][0]) {
    const [t0, x0] = p[i - 1], [t1, x1] = p[i];
    return t1 === t0 ? x0 : x0 + (tick - t0) / (t1 - t0) * (x1 - x0);
  }
  return p[p.length - 1][1];
}
$('score').addEventListener('click', e => {
  const r = e.target.closest('.mhit');
  if (!r) return;
  const k = +r.dataset.m;
  from = from === k ? 0 : k;
  stopAll(); updateFromChip(); renderScore();
});
function updateFromChip() {
  const c = $('fromChip');
  c.classList.toggle('hidden', from === 0);
  c.textContent = `Od taktu ${from + 1}  ✕`;
  $('phint').classList.toggle('hidden', from !== 0);
}
$('fromChip').onclick = () => { from = 0; stopAll(); updateFromChip(); renderScore(); };
$('origBtn').onclick = () => {
  const on = $('origBtn').getAttribute('aria-pressed') !== 'true';
  $('origBtn').setAttribute('aria-pressed', on); $('orig').classList.toggle('hidden', !on); store.set('orig', on);
};
let rz = 0, lastW = 0;
new ResizeObserver(() => { const w = $('score').clientWidth; if (Math.abs(w - lastW) < 2) return; lastW = w; clearTimeout(rz); rz = setTimeout(() => parsed && renderScore(), 120); }).observe($('score'));

/* ---------------- dźwięk ---------------- */
let ac = null, clapBuf = null, clickBufs = null;
function audio() {
  if (!ac) {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    clapBuf = makeClap(ac);
    clickBufs = [makeClick(ac, 2600, 1), makeClick(ac, 2200, 0.75), makeClick(ac, 1900, 0.55)];
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
function makeClap(c) {
  const sr = c.sampleRate, len = Math.round(sr * 0.2), b = c.createBuffer(1, len, sr), x = b.getChannelData(0);
  let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const bursts = [[0, 1], [0.006, 0.8], [0.013, 0.55], [0.019, 0.35]];
  let lp = 0, pv = 0, mx = 0;
  for (let n = 0; n < len; n++) {
    const t = n / sr; let env = 0.28 * Math.exp(-t / 0.05);
    for (const [st, g] of bursts) if (t >= st) env += g * Math.exp(-(t - st) / 0.0045);
    const v = r() * env, hp = v - 0.6 * pv; pv = v; lp += 0.55 * (hp - lp); x[n] = lp; mx = Math.max(mx, Math.abs(lp));
  }
  for (let n = 0; n < len; n++) x[n] /= mx * 1.15;
  return b;
}
function makeClick(c, f, g) {
  const sr = c.sampleRate, len = Math.round(sr * 0.05), b = c.createBuffer(1, len, sr), x = b.getChannelData(0);
  for (let n = 0; n < len; n++) { const t = n / sr; x[n] = g * Math.exp(-t / 0.008) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 1.5 * t)); }
  return b;
}
function fire(buf, t, gain, out) {
  const s = ac.createBufferSource(); s.buffer = buf;
  const g = ac.createGain(); g.gain.value = gain;
  s.connect(g).connect(out || ac.destination); s.start(t);
  return s;
}
function clickFor(unitIdx) {
  if (unitIdx === 0) return clickBufs[0];
  if (parsed.num === 6 && unitIdx === 3) return clickBufs[1];
  if (parsed.num === 5 && parsed.den === 8 && (unitIdx === 2 || unitIdx === 3)) return clickBufs[2];
  return clickBufs[2];
}

let playing = null; // { kind, nodes, raf, timers }
function stopAll() {
  if (!playing) return;
  playing.nodes.forEach(n => { try { n.stop(); } catch (e) {} });
  cancelAnimationFrame(playing.raf);
  (playing.timers || []).forEach(clearTimeout);
  if (playing.cleanup) playing.cleanup();
  document.querySelectorAll('.score .now').forEach(el => el.classList.remove('now'));
  playing = null;
  $('playBtn').setAttribute('aria-pressed', 'false');
  $('playBtn').querySelector('span').textContent = 'Wzór';
}

// zwraca harmonogram względem t0 (początek pierwszego granego taktu)
function plan(t0) {
  const spt = secPerTick();
  const startTick = from * parsed.measureTicks;
  const unitT = 4 * TPQ / parsed.den;
  const units = [];
  for (let tk = startTick, k = 0; tk < parsed.total - 1e-6; tk += unitT, k++) units.push({ t: t0 + (tk - startTick) * spt, idx: k % parsed.num });
  const claps = parsed.onsets.filter(e => e.m >= from).map(e => ({ t: t0 + (e.start - startTick) * spt, e }));
  const hl = parsed.events.filter(e => e.m >= from && !e.rest).map(e => ({ t: t0 + (e.start - startTick) * spt, e }));
  return { units, claps, hl, end: t0 + (parsed.total - startTick) * spt, unitSec: unitT * spt, measureSec: parsed.measureTicks * spt };
}

function play() {
  if (playing) { stopAll(); return; }
  const c = audio();
  const count = $('optCount').checked;
  const spt = secPerTick();
  const ci = count ? parsed.measureTicks * spt : 0;
  const t0 = c.currentTime + 0.15 + ci;
  const p = plan(t0);
  const nodes = [];
  if (count) for (let k = 0; k < parsed.num; k++) nodes.push(fire(clickFor(k), t0 - ci + k * p.unitSec, 0.9));
  if ($('optMetro').checked) p.units.forEach(u => nodes.push(fire(clickFor(u.idx), u.t, 0.6)));
  if ($('optClaps').checked) p.claps.forEach(x => nodes.push(fire(clapBuf, x.t, 0.9)));
  playing = { kind: 'play', nodes, raf: 0 };
  $('playBtn').setAttribute('aria-pressed', 'true');
  $('playBtn').querySelector('span').textContent = 'Stop';
  let lastEl = null, i = 0;
  const tick = () => {
    const now = ac.currentTime - (ac.outputLatency || 0);
    while (i < p.hl.length && p.hl[i].t <= now) i++;
    const el = i > 0 ? p.hl[i - 1].e.el : null;
    if (el !== lastEl) { if (lastEl) lastEl.classList.remove('now'); if (el) el.classList.add('now'); lastEl = el; }
    if (now > p.end + 0.2) { stopAll(); return; }
    playing.raf = requestAnimationFrame(tick);
  };
  playing.raf = requestAnimationFrame(tick);
}
$('playBtn').onclick = play;

/* ---------------- nagrywanie z mikrofonu ---------------- */
async function record() {
  stopAll();
  const c = audio();
  const rec = $('rec');
  $('recMsg').textContent = 'Włączam mikrofon…';
  $('recSub').textContent = '';
  $('beat').textContent = ''; $('beat').className = 'beat';
  $('stopBtn').classList.add('hidden'); $('cancelBtn').classList.remove('hidden');
  rec.classList.remove('hidden');
  document.querySelector('.paper').scrollIntoView({ block: 'start', behavior: 'smooth' });
  let stream;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('brak API');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (err) {
    $('recMsg').textContent = 'Mikrofon jest tu niedostępny';
    $('recSub').innerHTML = 'W podglądzie w aplikacji Claude przeglądarka blokuje mikrofon. Nagraj klaskanie Dyktafonem albo aparatem i użyj przycisku <b>„Sprawdź nagranie z telefonu”</b>. Z mikrofonem na żywo działa wersja otwarta bezpośrednio w Safari.';
    $('cancelBtn').textContent = 'Zamknij';
    $('cancelBtn').onclick = () => { rec.classList.add('hidden'); $('cancelBtn').textContent = 'Anuluj'; };
    return;
  }
  if (c.state === 'suspended') await c.resume();
  const src = c.createMediaStreamSource(stream);
  const proc = c.createScriptProcessor(2048, 1, 1);
  const mute = c.createGain(); mute.gain.value = 0;
  const chunks = []; let firstCtx = null; let nSamp = 0;
  proc.onaudioprocess = ev => {
    const d = ev.inputBuffer.getChannelData(0);
    if (firstCtx === null) firstCtx = (ev.playbackTime || c.currentTime) - 2 * d.length / c.sampleRate;
    chunks.push(new Float32Array(d)); nSamp += d.length;
    let pk = 0; for (let i = 0; i < d.length; i += 4) pk = Math.max(pk, Math.abs(d[i]));
    $('lvl').style.width = Math.min(100, Math.sqrt(pk) * 140) + '%';
  };
  src.connect(proc); proc.connect(mute); mute.connect(c.destination);

  const spt = secPerTick();
  const ci = parsed.measureTicks * spt;
  const t0 = c.currentTime + 0.9 + ci;
  const p = plan(t0);
  const nodes = [];
  for (let k = 0; k < parsed.num; k++) nodes.push(fire(clickFor(k), t0 - ci + k * p.unitSec, 1));
  if ($('optRecMetro').checked) p.units.forEach(u => nodes.push(fire(clickFor(u.idx), u.t, 0.6)));
  const stopAt = p.end + Math.max(1.6, (p.end - t0) * 0.15);
  $('recMsg').textContent = 'Wyliczanka…';
  $('recSub').textContent = 'Klaszcz od pierwszej nuty po wyliczance.';
  $('stopBtn').classList.remove('hidden'); $('cancelBtn').classList.remove('hidden');
  let done = false;
  const finish = async (cancel) => {
    if (done) return; done = true;
    cancelAnimationFrame(playing && playing.raf);
    nodes.forEach(n => { try { n.stop(); } catch (e) {} });
    try { src.disconnect(); proc.disconnect(); mute.disconnect(); } catch (e) {}
    stream.getTracks().forEach(t => t.stop());
    playing = null;
    markMeasure(null);
    rec.classList.add('hidden');
    $('cancelBtn').textContent = 'Anuluj';
    if (cancel) return;
    const x = new Float32Array(nSamp); let o = 0; chunks.forEach(ch => { x.set(ch, o); o += ch.length; });
    lastRecording = { samples: x, sr: c.sampleRate };
    const startRec = t0 - firstCtx;
    analyse(x, c.sampleRate, { startRec, unitSec: p.unitSec, countN: parsed.num, nominalB: spt * TPQ });
  };
  $('stopBtn').onclick = () => finish(false);
  $('cancelBtn').onclick = () => finish(true);
  playing = { kind: 'rec', nodes: [], raf: 0, cleanup: () => finish(true) };
  // wizualny puls
  const beat = $('beat');
  let lastK = -99;
  const loop = () => {
    if (done) return;
    const now = c.currentTime;
    if (now >= stopAt) { finish(false); return; }
    const k = Math.floor((now - (t0 - ci)) / p.unitSec);
    if (k !== lastK && now >= t0 - ci) {
      lastK = k;
      const inCount = k < parsed.num;
      const idx = ((k % parsed.num) + parsed.num) % parsed.num;
      beat.textContent = String(idx + 1);
      beat.className = 'beat on' + (idx === 0 ? ' acc' : '');
      setTimeout(() => { beat.className = 'beat'; }, Math.min(140, p.unitSec * 400));
      $('recMsg').textContent = inCount ? 'Wyliczanka…' : 'Klaszcz!';
      const mNow = Math.min(parsed.measures.length - 1, from + Math.floor((k - parsed.num) / parsed.num));
      if (!inCount) { $('recSub').textContent = `Takt ${mNow + 1} z ${parsed.measures.length}`; markMeasure(mNow); }
      else $('recSub').textContent = `Zaczynasz od taktu ${from + 1}`;
    }
    playing && (playing.raf = requestAnimationFrame(loop));
  };
  requestAnimationFrame(loop);
}
$('recBtn').onclick = record;

/* ---------------- wczytanie pliku ---------------- */
$('file').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  stopAll();
  const lbl = $('fileLbl');
  const old = lbl.firstChild.textContent;
  lbl.firstChild.textContent = 'Analizuję nagranie…';
  try {
    const c = audio();
    const buf = await new Promise((res, rej) => {
      f.arrayBuffer().then(ab => {
        const pr = c.decodeAudioData(ab, res, rej);
        if (pr && pr.then) pr.then(res, rej);
      }, rej);
    });
    const x = new Float32Array(buf.length);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) x[i] += d[i] / buf.numberOfChannels; }
    lastRecording = { samples: x, sr: buf.sampleRate };
    analyse(x, buf.sampleRate, {});
  } catch (err) {
    showError('Nie udało się odczytać tego pliku. Spróbuj nagrania z Dyktafonu (m4a) albo krótkiego wideo z aparatu.');
  } finally {
    lbl.firstChild.textContent = old;
  }
};

/* ---------------- analiza i wyniki ---------------- */
let lastInfo = {};
function analyse(x, sr, info) {
  lastInfo = info; lastRecordingHadTempo = info.startRec != null;
  let det = RAnalysis.detectOnsets(x, sr, { sensitivity: sens });
  let nominal = null;
  if (info.startRec != null) {
    // odrzuć kliknięcia wyliczanki: szukamy ich na równej siatce przed startem
    const clicks = [];
    for (let k = 1; k <= info.countN; k++) clicks.push(info.startRec - k * info.unitSec);
    let bestOff = 0, bestHits = 0;
    det.filter(o => o.t < info.startRec - 0.3 * info.unitSec + 0.25).forEach(o => {
      clicks.forEach(c => {
        const off = o.t - c;
        if (Math.abs(off) > 0.25) return;
        const hits = clicks.filter(cc => det.some(d => Math.abs(d.t - (cc + off)) < 0.015)).length;
        if (hits > bestHits) { bestHits = hits; bestOff = off; }
      });
    });
    let start = info.startRec;
    if (bestHits >= 2) {
      start += bestOff;
      det = det.filter(d => !clicks.some(cc => Math.abs(d.t - (cc + bestOff)) < 0.015));
    }
    det = det.filter(d => d.t > start - 0.45 * info.unitSec);
    nominal = { a: start, b: info.nominalB };
  }
  const res = RAnalysis.evaluate(parsed, det, { fromMeasure: from, nominal });
  if (res.empty || res.detected < Math.max(3, res.total * 0.25)) {
    showError(res.empty || !res.detected ? 'Nie usłyszałem klaśnięć. Klaszcz głośniej albo bliżej telefonu, ewentualnie ustaw czułość na „wysoka”.'
      : `Usłyszałem tylko ${res.detected} klaśnięć, a w rytmie jest ${res.total} nut. Klaszcz głośniej albo bliżej telefonu, ewentualnie ustaw czułość na „wysoka”.`);
    return;
  }
  result = res;
  const pct = Math.round(100 * (res.counts.ok + 0.5 * res.counts.warn) / res.total);
  res.pct = pct;
  if (from === 0) { best[cur] = Math.max(best[cur] || 0, pct); store.set('best', best); buildPicker(); }
  paintResult();
  showResults();
}

function paintResult() {
  if (!layout || !result) return;
  const { marks, lineY } = layout;
  marks.innerHTML = '';
  parsed.events.forEach(e => e.el && e.el.classList.remove('r-ok', 'r-warn', 'r-bad', 'r-miss', 'r-tie'));
  const NS = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs) => { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); marks.appendChild(el); return el; };
  const col = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', miss: 'var(--bad)' };
  result.notes.forEach(n => {
    const e = n.ev;
    e.el && e.el.classList.add('r-' + n.status);
    const y = lineY[e.m] + 24;
    if (n.status === 'miss') {
      add('circle', { cx: e.x, cy: y, r: 5, fill: 'none', stroke: col.miss, 'stroke-width': 2 });
      return;
    }
    // przesunięcie kropki ~ błąd względem odstępu do sąsiedniej nuty
    const k = parsed.events.indexOf(e);
    let nb = null;
    for (let j = k + (n.err > 0 ? 1 : -1); j >= 0 && j < parsed.events.length; j += (n.err > 0 ? 1 : -1)) { if (parsed.events[j].m === e.m || true) { nb = parsed.events[j]; break; } }
    const spacing = nb && nb.m === e.m ? Math.abs(nb.x - e.x) : 22;
    const frac = n.delta ? n.err / n.delta : 0;
    const dx = Math.max(-0.9, Math.min(0.9, frac)) * spacing;
    if (Math.abs(dx) > 2) add('line', { x1: e.x, y1: y, x2: e.x + dx, y2: y, stroke: col[n.status], 'stroke-width': 2, 'stroke-linecap': 'round' });
    add('circle', { cx: e.x + dx, cy: y, r: 4, fill: col[n.status] });
  });
  parsed.events.forEach(e => { if (e.tieCont && e.m >= from && e.el) e.el.classList.add('r-tie'); });
  result.extras.forEach(x => {
    const m = x.ev.m;
    const xx = xAt(m, Math.max(x.ev.mStart, Math.min(x.tick, x.ev.mStart + parsed.measureTicks)));
    const y = lineY[m] + 24;
    add('path', { d: `M${xx - 5} ${y}h10M${xx} ${y - 5}v10`, stroke: 'var(--bad)', 'stroke-width': 2.6, 'stroke-linecap': 'round' });
  });
  $('legend').classList.remove('hidden');
}

function noteLabel(e) {
  const vis = parsed.measures[e.m].filter(x => !x.rest);
  const idx = vis.indexOf(e) + 1;
  let name = (e.rest ? 'pauza ' : '') + VALUE_NAME[e.val] + (e.dots ? ' z kropką' : '') + (e.tup ? ' w trioli' : '');
  return { where: `Takt ${e.m + 1}` + (e.rest ? '' : ` · ${idx}. nuta`), name };
}
const EXTRA_TEXT = {
  tie: 'klaśnięcie na nucie pod ligaturą (tej nie klaszczemy)',
  rest: 'klaśnięcie w pauzie',
  dot: 'klaśnięcie na kropce, w trakcie trwania nuty',
  long: 'dodatkowe klaśnięcie w trakcie długiej nuty',
  double: 'podwójne klaśnięcie',
  extra: 'dodatkowe klaśnięcie'
};
function showResults() {
  const r = result;
  const items = [];
  r.notes.forEach(n => {
    if (n.status === 'ok') return;
    const L = noteLabel(n.ev);
    let what, ms = '';
    if (n.status === 'miss') what = 'brak klaśnięcia';
    else {
      const v = Math.round(Math.abs(n.err) * 1000);
      what = (n.far ? 'mocno ' : '') + (n.err < 0 ? 'za wcześnie' : 'za późno');
      ms = (n.err < 0 ? '−' : '+') + v + ' ms';
    }
    items.push({ tick: n.ev.start, el: n.ev.el, color: n.status === 'warn' ? 'var(--warn)' : 'var(--bad)', where: L.where, what: `${L.name}: ${what}`, ms });
  });
  r.extras.forEach(x => {
    const e = x.ev;
    const near = x.kind === 'tie' || x.kind === 'rest' || x.kind === 'dot' || x.kind === 'long' ? noteLabel(e) : { where: `Takt ${e.m + 1}`, name: '' };
    items.push({ tick: x.tick, el: e.el, color: 'var(--bad)', where: near.where, what: EXTRA_TEXT[x.kind], ms: '' });
  });
  items.sort((a, b) => a.tick - b.tick);
  const c = r.counts;
  const extra = r.extras.length;
  const title = r.pct >= 95 && !extra ? 'Świetnie!' : r.pct >= 85 ? 'Bardzo dobrze' : r.pct >= 70 ? 'Nieźle, popraw kilka miejsc' : r.pct >= 50 ? 'Jeszcze nad tym popracuj' : 'Zwolnij i spróbuj jeszcze raz';
  const unit = unitSym();
  const tempoTxt = `Twoje tempo: ${unit} ≈ ${Math.round(r.bpm)}` + (lastRecordingHadTempo ? ` (ustawione ${bpm()})` : '');
  const fromTxt = from > 0 ? ` · od taktu ${from + 1}` : '';
  $('results').innerHTML = `
    <div class="verdict"><h2>${title}</h2><span class="pct">${r.pct}%</span></div>
    <p class="vsub">${c.ok} z ${r.total} nut dokładnie w punkt${fromTxt}. ${tempoTxt}.</p>
    <div class="stats">
      <div class="stat ok"><b>${c.ok}</b><span>dokładnie</span></div>
      <div class="stat warn"><b>${c.warn}</b><span>prawie</span></div>
      <div class="stat bad"><b>${c.bad}</b><span>za wcześnie / późno</span></div>
      <div class="stat bad"><b>${c.miss}</b><span>brakujące</span></div>
      <div class="stat bad"><b>${extra}</b><span>dodatkowe</span></div>
    </div>
    ${r.hints.length ? `<ul class="hints">${r.hints.map(h => `<li>${h.text}</li>`).join('')}</ul>` : ''}
    ${items.length ? `<ul class="issues">${items.map((it, i) => `<li${i >= 8 ? ' class="more hidden"' : ''}><button data-i="${i}"><i style="background:${it.color}"></i><span><span class="where">${it.where}</span><br><span class="what">${it.what}</span></span><span class="ms">${it.ms}</span></button></li>`).join('')}</ul>`
      : '<p class="note">Bez błędów. Spróbuj w szybszym tempie.</p>'}
    ${items.length > 8 ? `<button class="btn" id="showAll" style="margin-top:8px;min-height:44px">Pokaż wszystkie (${items.length})</button>` : ''}
    <div class="racts">
      <button class="btn" id="hearMe">Odsłuchaj swoje nagranie</button>
      <button class="btn" id="again">Klaszcz jeszcze raz</button>
      <button class="btn" id="clearRes">Wyczyść ocenę</button>
    </div>
    ${r.ignored ? `<p class="small">Pominięto ${r.ignored} cichych dźwięków (np. głos), których nie uznałem za klaśnięcia.</p>` : ''}`;
  $('results').classList.remove('hidden');
  $('results').querySelectorAll('.issues button').forEach(b => b.onclick = () => {
    const it = items[+b.dataset.i];
    if (!it.el) return;
    it.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    it.el.classList.remove('flash'); void it.el.getBoundingClientRect(); it.el.classList.add('flash');
    setTimeout(() => it.el.classList.remove('flash'), 2000);
  });
  if ($('showAll')) $('showAll').onclick = () => { $('results').querySelectorAll('.issues .more').forEach(li => li.classList.remove('hidden')); $('showAll').remove(); };
  $('hearMe').onclick = hearRecording;
  $('again').onclick = record;
  $('clearRes').onclick = () => { result = null; $('results').classList.add('hidden'); $('legend').classList.add('hidden'); renderScore(); };
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function hearRecording() {
  if (!lastRecording) return;
  if (playing) { stopAll(); return; }
  const c = audio();
  const b = c.createBuffer(1, lastRecording.samples.length, lastRecording.sr);
  b.getChannelData(0).set(lastRecording.samples);
  const s = fire(b, c.currentTime + 0.05, 1);
  playing = { kind: 'hear', nodes: [s], raf: 0 };
  s.onended = () => { if (playing && playing.nodes[0] === s) playing = null; };
}
function showError(msg) {
  result = null;
  $('results').innerHTML = `<p class="note">${msg}</p>`;
  $('results').classList.remove('hidden');
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('sens').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  sens = +b.dataset.v; store.set('sens', sens);
  $('sens').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
  if (lastRecording) analyse(lastRecording.samples, lastRecording.sr, lastInfo);
});

/* ---------------- start ---------------- */
const savedSens = store.get('sens', 0.5);
sens = savedSens;
$('sens').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', +x.dataset.v === savedSens));
const origOn = store.get('orig', true);
$('origBtn').setAttribute('aria-pressed', origOn); $('orig').classList.toggle('hidden', !origOn);
buildPicker();
select(cur);
// API do testów
window.__rytmy = { analyse: (x, sr, info) => analyse(x, sr, info || {}), select, get parsed() { return parsed; }, get result() { return result; } };
}

// Wykrywanie klaśnięć i porównanie ze wzorcem. Działa w przeglądarce i w Node (testy).
(function (root) {
  // ---------- filtr górnoprzepustowy (biquad RBJ) ----------
  function highpass(x, sr, f0) {
    const w0 = 2 * Math.PI * f0 / sr, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
    const b0 = (1 + cs) / 2, b1 = -(1 + cs), b2 = (1 + cs) / 2, a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let n = 0; n < x.length; n++) {
      const v = (b0 * x[n] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = x[n]; y2 = y1; y1 = v; y[n] = v;
    }
    return y;
  }

  // ---------- wykrywanie klaśnięć ----------
  // Klaśnięcie: bardzo szybki wzrost energii w wysokich częstotliwościach i szybkie wygaszenie.
  // Mowa (liczenie na głos) narasta wolniej i trwa dłużej, więc jest odrzucana.
  function detectOnsets(x, sr, opt = {}) {
    const sens = opt.sensitivity == null ? 0.5 : opt.sensitivity; // 0..1
    let y = highpass(x, sr, 1500); y = highpass(y, sr, 1500);
    const hop = Math.max(1, Math.round(sr * 0.001)), win = Math.round(sr * 0.004);
    const S = new Float64Array(y.length + 1);
    for (let n = 0; n < y.length; n++) S[n + 1] = S[n] + y[n] * y[n];
    const K = Math.floor(y.length / hop);
    const db = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      const e = k * hop, s = Math.max(0, e - win);
      db[k] = 10 * Math.log10((S[e] - S[s]) / Math.max(1, e - s) + 1e-12);
    }
    const sorted = Array.from(db).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.3)] ?? -120;
    const maxDb = sorted[sorted.length - 1] ?? -120;
    const thr = Math.max(floor + 16 - 8 * sens, maxDb - (26 + 12 * sens));
    const riseNeed = 13 - 5 * sens;
    const ms = v => Math.round(v * sr / hop / 1000);
    const cands = [];
    let k = ms(20), armed = true, lastPeakDb = -200;
    while (k < K - 1) {
      if (!armed && db[k] < lastPeakDb - 7) armed = true;
      const back = Math.min(...Array.from(db.subarray(Math.max(0, k - ms(14)), Math.max(1, k - ms(2)))));
      const rise = db[k] - back;
      if (armed && db[k] >= thr && rise >= riseNeed) {
        // szczyt w ciągu 15 ms
        let p = k;
        for (let q = k; q < Math.min(K, k + ms(15)); q++) if (db[q] > db[p]) p = q;
        const peakDb = db[p];
        const later = db[Math.min(K - 1, p + ms(35))];
        const decay = peakDb - later;
        // dokładny moment: pierwsza próbka > 25% lokalnego maksimum
        const s0 = Math.max(0, (k - ms(6)) * hop), s1 = Math.min(y.length, (p + 1) * hop);
        let pk = 0; for (let n = s0; n < s1; n++) pk = Math.max(pk, Math.abs(y[n]));
        let on = s0; for (let n = s0; n < s1; n++) if (Math.abs(y[n]) > 0.25 * pk) { on = n; break; }
        let en = 0; const e0 = on, e1 = Math.min(y.length, on + Math.round(sr * 0.025));
        for (let n = e0; n < e1; n++) en += y[n] * y[n];
        cands.push({ t: on / sr, peakDb, rise: db[p] - back, decay, e: 10 * Math.log10(en + 1e-12) });
        lastPeakDb = peakDb; armed = false;
        k = p + ms(45);
        continue;
      }
      k++;
    }
    if (!cands.length) return [];
    const peaks = cands.map(c => c.peakDb).sort((a, b) => a - b);
    const med = peaks[Math.floor(peaks.length / 2)];
    const ens = cands.map(c => c.e).sort((a, b) => a - b);
    const ref = ens[Math.floor(ens.length * 0.75)];
    // odrzucamy dźwięki wybrzmiewające długo (mowa, szum), chyba że są tak głośne jak klaśnięcia i bardzo ostre,
    // oraz krótkie, słabe impulsy (spółgłoski „t”, „d”, stuknięcia) wyraźnie cichsze od typowego klaśnięcia
    return cands.filter(c => c.decay >= 7 || (c.rise >= 22 && c.peakDb >= med - 4))
      .filter(c => c.e >= ref - (11 + 8 * sens));
  }

  // ---------- dopasowanie do wzorca ----------
  function dp(q, d, a, b, span) {
    const N = q.length, M = d.length, K = 1.5, MISS = 1, EXTRA = 1, OUT = 0.03;
    const W = i => {
      const l = i > 0 ? (q[i] - q[i - 1]) : (i + 1 < N ? q[i + 1] - q[i] : 1);
      const r = i + 1 < N ? (q[i + 1] - q[i]) : l;
      return [b * l / 2, b * r / 2];
    };
    const win = q.map((_, i) => W(i));
    const lo = a + b * (q[0] - span), hi = a + b * (q[N - 1] + span);
    const exCost = d.map(t => (t < lo || t > hi) ? OUT : EXTRA);
    const C = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(Infinity));
    const P = Array.from({ length: N + 1 }, () => new Int8Array(M + 1));
    C[0][0] = 0;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= M; j++) {
      if (i === 0 && j === 0) continue;
      let best = Infinity, from = 0;
      if (i > 0 && C[i - 1][j] + MISS < best) { best = C[i - 1][j] + MISS; from = 1; }
      if (j > 0 && C[i][j - 1] + exCost[j - 1] < best) { best = C[i][j - 1] + exCost[j - 1]; from = 2; }
      if (i > 0 && j > 0) {
        const err = d[j - 1] - (a + b * q[i - 1]);
        const w = err < 0 ? win[i - 1][0] : win[i - 1][1];
        if (Math.abs(err) < w * 0.98) {
          const c = C[i - 1][j - 1] + K * (err / w) ** 2;
          if (c < best) { best = c; from = 3; }
        }
      }
      C[i][j] = best; P[i][j] = from;
    }
    const pairs = [], extras = [], misses = [];
    let i = N, j = M;
    while (i > 0 || j > 0) {
      const f = P[i][j];
      if (f === 3) { pairs.push([i - 1, j - 1]); i--; j--; }
      else if (f === 1) { misses.push(i - 1); i--; }
      else { extras.push(j - 1); j--; }
    }
    pairs.reverse(); misses.reverse(); extras.reverse();
    return { cost: C[N][M], pairs, misses, extras, lo, hi };
  }

  // Dopasowanie śledzące: przewidywany moment liczony od ostatnich trafionych klaśnięć,
  // dzięki czemu przyspieszenie lub zwolnienie w środku nie rozjeżdża reszty ćwiczenia.
  function dpTrack(q, d, a, b, span) {
    const N = q.length, M = d.length, K = 1.5, MISS = 1, EXTRA = 1, OUT = 0.03;
    const win = q.map((_, i) => {
      const l = i > 0 ? (q[i] - q[i - 1]) : (i + 1 < N ? q[i + 1] - q[i] : 1);
      const r = i + 1 < N ? (q[i + 1] - q[i]) : l;
      return [b * l / 2, b * r / 2];
    });
    const lo = a + b * (q[0] - span), hi = a + b * (q[N - 1] + span);
    const exCost = d.map(t => (t < lo || t > hi) ? OUT : EXTRA);
    const C = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(Infinity));
    const P = Array.from({ length: N + 1 }, () => new Int8Array(M + 1));
    const A = Array.from({ length: N + 1 }, () => new Array(M + 1));
    C[0][0] = 0; A[0][0] = [];
    const pred = (anch, i) => {
      if (!anch.length) return a + b * q[i];
      let s = 0, w = 0;
      anch.forEach(([qq, t], k) => { const ww = k + 1; s += ww * (t + b * (q[i] - qq)); w += ww; });
      return s / w;
    };
    for (let i = 0; i <= N; i++) for (let j = 0; j <= M; j++) {
      if (i === 0 && j === 0) continue;
      let best = Infinity, from = 0, anch = null;
      if (i > 0 && C[i - 1][j] + MISS < best) { best = C[i - 1][j] + MISS; from = 1; anch = A[i - 1][j]; }
      if (j > 0 && C[i][j - 1] + exCost[j - 1] < best) { best = C[i][j - 1] + exCost[j - 1]; from = 2; anch = A[i][j - 1]; }
      if (i > 0 && j > 0 && C[i - 1][j - 1] < Infinity) {
        const prevA = A[i - 1][j - 1];
        const err = d[j - 1] - pred(prevA, i - 1);
        const w = err < 0 ? win[i - 1][0] : win[i - 1][1];
        if (Math.abs(err) < w * 0.98) {
          const c = C[i - 1][j - 1] + K * (err / w) ** 2;
          if (c < best) { best = c; from = 3; anch = prevA.concat([[q[i - 1], d[j - 1]]]).slice(-4); }
        }
      }
      C[i][j] = best; P[i][j] = from; A[i][j] = anch || [];
    }
    const pairs = [], extras = [], misses = [];
    let i = N, j = M;
    while (i > 0 || j > 0) {
      const f = P[i][j];
      if (f === 3) { pairs.push([i - 1, j - 1]); i--; j--; }
      else if (f === 1) { misses.push(i - 1); i--; }
      else { extras.push(j - 1); j--; }
    }
    pairs.reverse(); misses.reverse(); extras.reverse();
    return { cost: C[N][M], pairs, misses, extras, lo, hi };
  }

  function fitLine(pts, w) { // pts: [[q, t]], w: wagi
    let sw = 0, sq = 0, st = 0, sqq = 0, sqt = 0;
    pts.forEach(([q, t], k) => { const ww = w ? w[k] : 1; sw += ww; sq += ww * q; st += ww * t; sqq += ww * q * q; sqt += ww * q * t; });
    const den = sw * sqq - sq * sq;
    if (sw <= 0 || Math.abs(den) < 1e-12) return null;
    const b = (sw * sqt - sq * st) / den, a = (st - b * sq) / sw;
    return b > 0 ? { a, b } : null;
  }

  function align(q, d, opt = {}) {
    const N = q.length, M = d.length;
    if (!N || !M) return null;
    const hyps = [];
    if (opt.nominal) hyps.push(opt.nominal);
    const tryPair = (j0, i0, j1, i1) => {
      if (j0 < 0 || j1 >= M || j0 >= j1 || i0 < 0 || i1 >= N || i0 >= i1) return;
      const b = (d[j1] - d[j0]) / (q[i1] - q[i0]);
      if (b > 0.08 && b < 4) hyps.push({ a: d[j0] - b * q[i0], b });
    };
    for (const [j0, i0] of [[0, 0], [1, 0], [2, 0], [0, 1]])
      for (const [j1, i1] of [[M - 1, N - 1], [M - 2, N - 1], [M - 1, N - 2], [M - 3, N - 1]]) tryPair(j0, i0, j1, i1);
    if (opt.nominal) { hyps.push({ a: d[0] - opt.nominal.b * q[0], b: opt.nominal.b }); }
    let best = null;
    for (const h of hyps) {
      let { a, b } = h, r = null;
      for (let it = 0; it < 6; it++) {
        r = dp(q, d, a, b, 1.5);
        if (r.pairs.length < 2) break;
        const pts = r.pairs.map(([i, j]) => [q[i], d[j]]);
        const res = pts.map(([qq, t]) => Math.abs(t - (a + b * qq)));
        const f = fitLine(pts, res.map(e => e < 0.04 ? 1 : 0.04 / e));
        if (!f) break;
        if (Math.abs(f.a - a) < 1e-4 && Math.abs(f.b - b) < 1e-5) { a = f.a; b = f.b; break; }
        a = f.a; b = f.b;
      }
      r = dp(q, d, a, b, 1.5);
      if (!best || r.cost < best.cost) best = { ...r, a, b };
    }
    // wersja śledząca tempo — wybieramy tę, która lepiej tłumaczy nagranie
    const tr = dpTrack(q, d, best.a, best.b, 1.5);
    const bad = r => r.misses.length + r.extras.filter(j => d[j] >= r.lo && d[j] <= r.hi).length;
    if (bad(tr) < bad(best) || (bad(tr) === bad(best) && tr.cost < best.cost)) {
      const pts = tr.pairs.map(([i, j]) => [q[i], d[j]]);
      const f = fitLine(pts) || best;
      return { ...tr, a: f.a, b: f.b, tracked: true };
    }
    return best;
  }

  // ---------- ocena: lokalne tempo, błędy, podpowiedzi ----------
  // parsed: wynik RCore.parseRhythm; fromMeasure: od którego taktu (0-based)
  function evaluate(parsed, detected, opt = {}) {
    const TPQ = 48;
    const from = opt.fromMeasure || 0;
    const startTick = from * parsed.measureTicks;
    const on = parsed.onsets.filter(e => e.m >= from);
    const q = on.map(e => (e.start - startTick) / TPQ);
    let det = detected.map(o => typeof o === 'number' ? { t: o, e: 0 } : o).sort((x, y) => x.t - y.t);
    const d = det.map(o => o.t);
    const measureQ = parsed.measureTicks / TPQ;
    const unitQ = 4 / parsed.den;
    if (!d.length) return { empty: true, total: on.length };
    const al = align(q, d, opt);
    if (!al) return { empty: true, total: on.length };
    const { a, b } = al;
    const pairs = al.pairs.map(([i, j]) => ({ i, j, q: q[i], t: d[j], gr: d[j] - (a + b * q[i]) }));
    const notes = on.map((e, i) => ({ ev: e, q: q[i], status: 'miss', err: null }));
    // lokalne dopasowanie (bez samej nuty) → błąd względem pulsu sąsiadów
    const Wq = Math.max(2, measureQ);
    for (const p of pairs) {
      const nb = pairs.filter(o => o !== p && Math.abs(o.q - p.q) <= Wq);
      let A = a, B = b;
      if (nb.length >= 3 && (Math.max(...nb.map(o => o.q)) - Math.min(...nb.map(o => o.q))) >= 1) {
        const f = fitLine(nb.map(o => [o.q, o.t]), nb.map(o => (1 - Math.abs(o.q - p.q) / (Wq + 0.01)) / (1 + (o.gr / 0.025) ** 2)));
        if (f && f.b > b * 0.75 && f.b < b * 1.33) { A = f.a; B = f.b; }
      }
      const err = p.t - (A + B * p.q);
      const i = p.i;
      const gapL = i > 0 ? q[i] - q[i - 1] : Infinity, gapR = i + 1 < q.length ? q[i + 1] - q[i] : Infinity;
      const delta = B * Math.min(gapL, gapR, 2);
      const tolG = Math.min(0.075, Math.max(0.03, 0.18 * delta));
      const tolY = Math.min(0.15, Math.max(0.06, 0.36 * delta));
      const n = notes[i];
      n.err = err; n.t = p.t; n.tolG = tolG; n.tolY = tolY; n.delta = delta;
      n.status = Math.abs(err) <= tolG ? 'ok' : Math.abs(err) <= tolY ? 'warn' : 'bad';
    }
    // brak + obok „zabłąkane” klaśnięcie → ta sama nuta, mocno przesunięta
    const used = new Set();
    let extraIdx = al.extras.filter(j => d[j] >= al.lo && d[j] <= al.hi);
    const matchedE = pairs.map(p => det[p.j].e).sort((x, y) => x - y);
    const medE = matchedE.length ? matchedE[Math.floor(matchedE.length / 2)] : 0;
    // ciche dodatkowe dźwięki (mowa, szmery) pomijamy
    const ignored = extraIdx.filter(j => det[j].e < medE - 10).length;
    extraIdx = extraIdx.filter(j => det[j].e >= medE - 10);
    notes.forEach((n, i) => {
      if (n.status !== 'miss') return;
      const prevP = pairs.filter(p => p.i < i).pop(), nextP = pairs.find(p => p.i > i);
      const B = b;
      const pr = prevP ? prevP.t + B * (q[i] - prevP.q) : (nextP ? nextP.t - B * (nextP.q - q[i]) : a + b * q[i]);
      const gapL = i > 0 ? q[i] - q[i - 1] : 1, gapR = i + 1 < q.length ? q[i + 1] - q[i] : gapL;
      const cand = extraIdx.filter(j => !used.has(j) && (!prevP || d[j] > prevP.t) && (!nextP || d[j] < nextP.t) &&
        d[j] - pr > -B * gapL * 0.9 && d[j] - pr < B * gapR * 0.9);
      if (!cand.length) return;
      const j = cand.reduce((x, y) => Math.abs(d[x] - pr) < Math.abs(d[y] - pr) ? x : y);
      used.add(j);
      n.status = 'bad'; n.err = d[j] - pr; n.t = d[j]; n.far = true; n.delta = B * Math.min(gapL, gapR);
    });
    // dodatkowe klaśnięcia — gdzie wypadły w nutach
    const inSpan = extraIdx.filter(j => !used.has(j));
    const matchedT = pairs.map(p => p.t);
    const extras = inSpan.map(j => {
      const t = d[j];
      let prev = null, next = null;
      for (const p of pairs) { if (p.t <= t) prev = p; else { next = p; break; } }
      let qq;
      if (prev && next) qq = prev.q + (t - prev.t) / (next.t - prev.t) * (next.q - prev.q);
      else qq = (t - a) / b;
      if (qq < -0.2 || qq > q[q.length - 1] + Math.max(1, on[on.length - 1].dur / TPQ)) return null;
      const tick = startTick + qq * TPQ;
      let ev = parsed.events.find(e => tick >= e.start - 1e-6 && tick < e.start + e.dur) ||
        (tick < startTick ? parsed.events.find(e => e.m === from) : parsed.events[parsed.events.length - 1]);
      // klaśnięcie blisko początku nuty pod ligaturą albo pauzy → przypisz do niej
      const spec = parsed.events.filter(e => (e.tieCont || e.rest) && e.m >= from &&
        Math.abs(tick - e.start) <= Math.min(TPQ / 4, e.dur * 0.45));
      if (spec.length) ev = spec.reduce((x, y) => Math.abs(tick - x.start) < Math.abs(tick - y.start) ? x : y);
      let kind = 'extra';
      const near = Math.min(...matchedT.map(mt => Math.abs(mt - t)));
      const tolT = Math.min(TPQ / 4, ev.dur * 0.45);
      if (near < 0.07) kind = 'double';
      else if (ev.rest) kind = 'rest';
      else if (ev.tieCont && Math.abs(tick - ev.start) <= tolT) kind = 'tie';
      else if (ev.tieCont) kind = 'tie';
      else if (ev.dots && Math.abs(tick - (ev.start + ev.dur / 1.5)) <= tolT) kind = 'dot';
      else if (ev.dur >= TPQ) kind = 'long';
      return { t, q: qq, tick, ev, kind };
    }).filter(Boolean);
    // tempo
    let unitSec = b * unitQ;
    let bpm = 60 / unitSec;
    // dryf tempa w taktach
    const drift = [];
    const nMeasures = parsed.measures.length;
    for (let m = from; m < nMeasures; m++) {
      const m0 = (m - from) * measureQ, m1 = m0 + measureQ;
      const sel = pairs.filter(p => p.q >= m0 - measureQ * 0.5 && p.q <= m1 + measureQ * 0.5);
      if (sel.length < 4) continue;
      const f = fitLine(sel.map(p => [p.q, p.t]), sel.map(p => 1 / (1 + (p.gr / 0.05) ** 2)));
      if (!f) continue;
      drift.push({ m, bpm: 60 / (f.b * unitQ), dev: 0 });
    }
    // podpowiedzi
    const hints = [];
    const matched = notes.filter(n => n.err != null);
    const events = parsed.events;
    const prevOnsetEv = n => { const k = events.indexOf(n.ev); for (let x = k - 1; x >= 0; x--) if (!events[x].rest && !events[x].tieCont) return events[x]; return null; };
    const dotted = matched.filter(n => { const p = prevOnsetEv(n); return p && p.dots && p.beam === n.ev.beam && n.ev.dur < p.dur && p.dur - n.ev.dur > 0; });
    if (dotted.length >= 2) {
      const mErr = dotted.reduce((s, n) => s + n.err, 0) / dotted.length;
      const tol = dotted.reduce((s, n) => s + n.tolG, 0) / dotted.length;
      if (mErr < -tol * 0.8) hints.push({ k: 'dot', text: 'Rytm z kropką: krótka nuta po kropce wypada za wcześnie (wyrównujesz rytm). Wytrzymaj dłużej nutę z kropką.' });
      else if (mErr > tol * 0.8) hints.push({ k: 'dot', text: 'Rytm z kropką: krótka nuta po kropce wypada za późno, przez co rytm robi się zbyt ostry.' });
    }
    const trip = matched.filter(n => n.ev.tup);
    if (trip.length >= 3) {
      const bad = trip.filter(n => n.status !== 'ok').length / trip.length;
      if (bad > 0.35) hints.push({ k: 'tup', text: 'Triole są nierówne. Podziel wartość na trzy równe części (licz „raz-i-a”).' });
    }
    const after = matched.filter(n => { const p = prevOnsetEv(n); return p && p.dur + (p.tieNext ? 0 : 0) >= TPQ * 1.5; });
    if (after.length >= 2) {
      const mErr = after.reduce((s, n) => s + n.err, 0) / after.length;
      if (mErr < -0.05) hints.push({ k: 'long', text: 'Za krótko trzymasz długie wartości (półnuty, ćwierćnuty z kropką). Następna nuta wchodzi za wcześnie.' });
    }
    if (extras.some(x => x.kind === 'tie')) hints.push({ k: 'tie', text: 'Nut połączonych ligaturą nie klaszczemy. Klaśnięcie jest tylko na pierwszej, a potem ją przedłużasz.' });
    if (extras.some(x => x.kind === 'rest')) hints.push({ k: 'rest', text: 'Pojawiły się klaśnięcia w pauzach. Pauzę licz w myślach, ale nie klaszcz.' });
    const medBpm = drift.length ? drift.map(x => x.bpm).sort((x, y) => x - y)[Math.floor(drift.length / 2)] : bpm;
    drift.forEach(x => { x.dev = x.bpm / medBpm - 1; });
    const fast = drift.filter(x => x.dev > 0.07), slow = drift.filter(x => x.dev < -0.07);
    const ranges = arr => { const r = []; arr.forEach(x => { const l = r[r.length - 1]; if (l && x.m === l[1] + 1) l[1] = x.m; else r.push([x.m, x.m]); }); return r.map(([s, e]) => s === e ? `${s + 1}` : `${s + 1}–${e + 1}`).join(', '); };
    if (fast.length) hints.push({ k: 'tempo', text: `Przyspieszasz w takcie ${ranges(fast)}.` });
    if (slow.length) hints.push({ k: 'tempo', text: `Zwalniasz w takcie ${ranges(slow)}.` });
    if (drift.length >= 3) { bpm = medBpm; unitSec = 60 / bpm; }
    const counts = { ok: 0, warn: 0, bad: 0, miss: 0 };
    notes.forEach(n => counts[n.status]++);
    return { notes, extras, a, b, bpm, unitSec, drift, hints, counts, total: notes.length, detected: d.length, ignored, fromMeasure: from, tracked: !!al.tracked };
  }

  const api = { highpass, detectOnsets, align, evaluate };
  if (typeof module !== 'undefined') module.exports = api; else root.RAnalysis = api;
})(this);

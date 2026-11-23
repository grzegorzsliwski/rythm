// Parsowanie rytmów i obliczanie momentów klaśnięć (wspólne dla przeglądarki i testów).
(function (root) {
  const TPQ = 48; // ticki na ćwierćnutę
  function parseRhythm(src, ts) {
    const [num, den] = ts.split('/').map(Number);
    const measureTicks = num * 4 * TPQ / den;
    const measures = [[]];
    const events = [];
    let tick = 0, i = 0, join = false, beamId = 0, curBeam = -1, lastNote = null;
    const tupStack = []; let tupId = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\n') { join = false; i++; continue; }
      if (c === '|') { measures.push([]); join = false; i++; continue; }
      if (c === '-') { join = true; i++; continue; }
      if (c === ']') { tupStack.pop(); i++; continue; }
      if (c === '3' && src[i + 1] === '[') { tupStack.push(++tupId); i += 2; continue; }
      const m = /^(r?)(32|16|8|4|2|1)(\.*)(_?)/.exec(src.slice(i));
      if (!m) throw new Error('Błąd zapisu przy: ' + src.slice(i, i + 12));
      i += m[0].length;
      const val = +m[2], dots = m[3].length, rest = m[1] === 'r';
      let dur = 4 * TPQ / val;
      if (dots === 1) dur *= 1.5; else if (dots === 2) dur *= 1.75;
      const tup = tupStack.length ? tupStack[tupStack.length - 1] : null;
      if (tup) dur = dur * 2 / 3;
      const ev = { m: measures.length - 1, start: tick, dur, val, dots, rest, tieNext: m[4] === '_',
        tieCont: !!(lastNote && lastNote.tieNext && !rest), tup, beam: -1 };
      if (!rest) {
        if (join && lastNote && !lastNote.rest && curBeam >= 0 && lastNote.beam === curBeam) ev.beam = curBeam;
        else ev.beam = curBeam = ++beamId;
      }
      ev.i = measures[measures.length - 1].length;
      measures[measures.length - 1].push(ev); events.push(ev);
      tick += dur; lastNote = ev; join = false;
    }
    // walidacja taktów
    const errors = [];
    let t = 0;
    measures.forEach((ms, k) => {
      const sum = ms.reduce((a, e) => a + e.dur, 0);
      if (Math.abs(sum - measureTicks) > 1e-6) errors.push(`takt ${k + 1}: ${sum / TPQ} ćwierćnut zamiast ${measureTicks / TPQ}`);
      ms.forEach(e => { e.mStart = t; });
      t += measureTicks;
    });
    const onsets = events.filter(e => !e.rest && !e.tieCont);
    return { num, den, measureTicks, measures, events, onsets, total: t, errors };
  }
  const api = { TPQ, parseRhythm };
  if (typeof module !== 'undefined') module.exports = api; else root.RCore = api;
})(this);

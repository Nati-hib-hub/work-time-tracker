// Stellt Berichte zusammen: für einen Zeitraum (Tag, Woche, Monat, Schuljahr, Jahr oder frei gewählt)
// und für einen einzelnen Arbeitsort oder für alle zusammen.
//
// Es gibt zwei Formen:
// - "ausführlich" (z. B. NaturGut, Anforderungen 8.1): eine Zeile pro Arbeitsabschnitt,
//   jede Pause als eigene Zeile dazwischen.
// - "Übersicht" (Anforderungen 8.2): eine Zeile pro Arbeitsblock, die Pausen zusammengefasst.

import {
  DAY, MONTHS, PLACE_IDS, PLACE_META, WEEKDAYS,
  addDays, blockNotes, blockStart, dayKey, fmtDate, isDetailed, pad, segments, startOfDay, stateOf,
} from './model.js';

export const PERIOD_KINDS = [
  ['tag', 'Tag'],
  ['woche', 'Woche'],
  ['monat', 'Monat'],
  ['schuljahr', 'Schuljahr'],
  ['jahr', 'Jahr'],
  ['frei', 'Von–Bis'],
];

// Das Schuljahr beginnt in NRW am 1. August (Monat 7, weil ab 0 gezählt wird).
const SCHOOL_YEAR_START_MONTH = 7;

const dm = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
};
const dmy = (ts) => `${dm(ts)}${new Date(ts).getFullYear()}`;

// Kalenderwoche nach deutscher Zählung (Woche beginnt montags)
function isoWeek(ts) {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const year = d.getFullYear();
  const w1 = new Date(year, 0, 4);
  const week = 1 + Math.round(((d.getTime() - w1.getTime()) / DAY - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return { week, year };
}

const monday = (ts) => {
  const d0 = startOfDay(ts);
  return addDays(d0, -((new Date(d0).getDay() + 6) % 7));
};

// Zeitraum bestimmen. "anchor" ist irgendein Zeitpunkt im gewünschten Zeitraum,
// "custom" enthält bei "frei" den ersten und letzten Tag als 2026-11-03.
export function period(kind, anchor, custom) {
  const d = new Date(anchor);
  const y = d.getFullYear();
  const m = d.getMonth();
  let from;
  let to;
  let label;
  let key;
  let word = 'Zeitraum';
  let sumWord = 'Summe';

  if (kind === 'tag') {
    from = startOfDay(anchor);
    to = addDays(from, 1);
    label = fmtDate(from);
    key = dayKey(from);
    word = 'Tag';
    sumWord = 'Tagessumme';
  } else if (kind === 'woche') {
    from = monday(anchor);
    to = addDays(from, 7);
    const w = isoWeek(from);
    label = `KW ${w.week} · ${dm(from)}–${dmy(addDays(to, -1))}`;
    key = `${w.year}-KW${pad(w.week)}`;
    word = 'Woche';
    sumWord = 'Wochensumme';
  } else if (kind === 'schuljahr') {
    const sy = m >= SCHOOL_YEAR_START_MONTH ? y : y - 1;
    from = new Date(sy, SCHOOL_YEAR_START_MONTH, 1).getTime();
    to = new Date(sy + 1, SCHOOL_YEAR_START_MONTH, 1).getTime();
    label = `Schuljahr ${sy}/${String(sy + 1).slice(2)}`;
    key = `Schuljahr-${sy}-${String(sy + 1).slice(2)}`;
  } else if (kind === 'jahr') {
    from = new Date(y, 0, 1).getTime();
    to = new Date(y + 1, 0, 1).getTime();
    label = `${y}`;
    key = `${y}`;
    word = 'Kalenderjahr';
    sumWord = 'Jahressumme';
  } else if (kind === 'frei') {
    let a = startOfDay(new Date(`${custom.from}T00:00`).getTime());
    let b = startOfDay(new Date(`${custom.to}T00:00`).getTime());
    if (!Number.isFinite(a)) a = startOfDay(anchor);
    if (!Number.isFinite(b)) b = a;
    if (b < a) [a, b] = [b, a];
    from = a;
    to = addDays(b, 1);
    label = a === b ? fmtDate(a) : `${dmy(a)}–${dmy(b)}`;
    key = a === b ? dayKey(a) : `${dayKey(a)}_bis_${dayKey(b)}`;
  } else {
    from = new Date(y, m, 1).getTime();
    to = new Date(y, m + 1, 1).getTime();
    label = `${MONTHS[m]} ${y}`;
    key = `${y}-${pad(m + 1)}`;
    word = 'Monat';
    sumWord = 'Monatssumme';
  }
  return { kind, from, to, label, key, line: `${word}: ${label}`, sumLabel: `${sumWord} netto (ohne Pausen)` };
}

// Einen Zeitraum vor oder zurück blättern
export function shiftAnchor(kind, anchor, n) {
  const d = new Date(anchor);
  if (kind === 'tag') return addDays(startOfDay(anchor), n);
  if (kind === 'woche') return addDays(startOfDay(anchor), 7 * n);
  if (kind === 'monat') return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
  return new Date(d.getFullYear() + n, d.getMonth(), 1).getTime();
}

// Unterteilung für das Säulendiagramm: Tage, Wochen oder Monate, je nach Länge des Zeitraums
function buckets(per) {
  const days = Math.round((per.to - per.from) / DAY);
  const out = [];
  if (days <= 1) return out;
  if (days <= 31) {
    for (let t = per.from; t < per.to; t = addDays(t, 1)) {
      const d = new Date(t);
      const label = days <= 7 ? WEEKDAYS[d.getDay()] : d.getDate() === 1 || d.getDate() % 5 === 0 ? String(d.getDate()) : '';
      out.push({ from: t, to: addDays(t, 1), label, full: fmtDate(t) });
    }
  } else if (days <= 125) {
    for (let t = monday(per.from); t < per.to; t = addDays(t, 7)) {
      const from = Math.max(t, per.from);
      const to = Math.min(addDays(t, 7), per.to);
      const w = isoWeek(t).week;
      out.push({ from, to, label: String(w), full: `KW ${w} (${dm(from)}–${dmy(addDays(to, -1))})` });
    }
  } else {
    let d = new Date(per.from);
    d = new Date(d.getFullYear(), d.getMonth(), 1);
    while (d.getTime() < per.to) {
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      out.push({
        from: Math.max(d.getTime(), per.from),
        to: Math.min(next.getTime(), per.to),
        label: MONTHS[d.getMonth()].slice(0, 3),
        full: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
      });
      d = next;
    }
  }
  return out;
}

const UNIT = (per) => {
  const days = Math.round((per.to - per.from) / DAY);
  return days <= 31 ? 'Tag' : days <= 125 ? 'Woche' : 'Monat';
};

// Baut den Bericht. place ist die Kennung eines Arbeitsorts oder 'all' für alle.
// names = { place(id) -> Name des Orts, user: Name der Nutzerin }
export function buildReport(blocks, per, place, now, names) {
  const all = place === 'all';
  const detailed = !all && isDetailed(place);
  const list = blocks.filter((b) => all || b.place === place).sort((a, b) => blockStart(a) - blockStart(b));

  const rows = [];
  const series = buckets(per).map((b) => ({ ...b, ms: 0, parts: {} }));
  const placeMs = {};
  const catMs = new Map();
  let totalMs = 0;
  let openCount = 0;
  let blockCount = 0;

  for (const b of list) {
    // Nur der Teil, der im Zeitraum liegt
    const segs = [];
    for (const s of segments(b, now)) {
      if (s.kind === 'pause' && s.open) continue;
      const from = Math.max(s.from, per.from);
      const to = Math.min(s.to, per.to);
      const inside = to > from || (s.from === s.to && s.from >= per.from && s.from < per.to);
      if (inside) segs.push({ ...s, from, to });
    }
    while (segs.length && segs[0].kind === 'pause') segs.shift();
    while (segs.length && segs[segs.length - 1].kind === 'pause') segs.pop();
    if (!segs.length) continue;

    const open = stateOf(b) !== 'done';
    if (open) openCount++;
    blockCount++;

    let ms = 0;
    let pause = 0;
    for (const s of segs) {
      if (s.kind === 'pause') {
        pause += s.to - s.from;
        continue;
      }
      ms += s.to - s.from;
      for (const c of series) {
        const part = Math.min(s.to, c.to) - Math.max(s.from, c.from);
        if (part > 0) {
          c.ms += part;
          c.parts[b.place] = (c.parts[b.place] || 0) + part;
        }
      }
    }
    totalMs += ms;
    placeMs[b.place] = (placeMs[b.place] || 0) + ms;
    const category = b.category || PLACE_META[b.place].defaultCategory;
    catMs.set(category, (catMs.get(category) || 0) + ms);

    if (detailed) {
      let lastDay = '';
      for (const s of segs) {
        if (s.kind === 'work') {
          const day = dayKey(s.from);
          rows.push({
            type: 'work',
            id: b.id,
            date: day !== lastDay ? fmtDate(s.from) : '',
            first: !lastDay,
            from: s.from,
            to: s.to,
            ms: s.to - s.from,
            note: s.note,
          });
          lastDay = day;
        } else {
          rows.push({ type: 'pause', id: b.id, from: s.from, to: s.to });
        }
      }
    } else {
      const first = segs[0];
      const last = segs[segs.length - 1];
      const lastDay = last.to > first.from ? last.to - 1 : last.to;
      const multiDay = dayKey(first.from) !== dayKey(lastDay);
      rows.push({
        type: 'block',
        id: b.id,
        date: multiDay ? `${fmtDate(first.from)} bis ${fmtDate(lastDay)}` : fmtDate(first.from),
        first: true,
        place: b.place,
        placeName: names.place(b.place),
        category,
        from: first.from,
        to: last.to,
        pauseMs: pause,
        ms,
        note: blockNotes(b).join(' · '),
      });
    }
  }

  const placeName = all ? 'Alle Arbeitsorte' : names.place(place);
  return {
    period: per,
    label: per.label,
    place,
    all,
    detailed,
    placeName,
    userName: names.user || '',
    title: all ? 'Arbeitszeitbericht gesamt' : `Arbeitszeitbericht ${placeName}`,
    fileLabel: all ? 'Gesamt' : placeName,
    rows,
    totalMs,
    openCount,
    blockCount,
    byPlace: PLACE_IDS.filter((id) => placeMs[id] > 0)
      .map((id) => ({ id, name: names.place(id), ms: placeMs[id] }))
      .sort((a, b) => b.ms - a.ms),
    byCategory: [...catMs.entries()]
      .filter(([, ms]) => ms > 0)
      .map(([name, ms]) => ({ name, ms }))
      .sort((a, b) => b.ms - a.ms),
    series,
    seriesUnit: UNIT(per),
  };
}

// Stellt Berichte zusammen: für einen Zeitraum (Tag, Woche, Monat, Schuljahr, Jahr oder frei gewählt)
// und für einen einzelnen Arbeitsort oder für alle zusammen.
//
// Es gibt zwei Formen:
// - "ausführlich" (z. B. NaturGut, Anforderungen 8.1): eine Zeile pro Arbeitsabschnitt,
//   jede Pause als eigene Zeile dazwischen.
// - "Übersicht" (Anforderungen 8.2): eine Zeile pro Arbeitsblock, die Pausen zusammengefasst.

import {
  DAY, MONTHS, WEEKDAYS,
  addDays, blockNotes, blockStart, dayKey, defaultCategory, fmtDate, isDetailed, pad, segments, startOfDay, stateOf,
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
    const category = b.category || defaultCategory(b.place);
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
    byPlace: Object.keys(placeMs)
      .filter((id) => placeMs[id] > 0)
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

// ---------- Übersicht für die Steuererklärung (Anforderungen 8.3) ----------

// Ostersonntag eines Jahres (bekannte Rechenvorschrift, braucht kein Internet)
function easter(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day).getTime();
}

// Gesetzliche Feiertage in Nordrhein-Westfalen: Tag (2026-11-01) -> Name
export function holidaysNRW(y) {
  const e = easter(y);
  const map = new Map();
  const add = (ts, name) => map.set(dayKey(ts), name);
  add(new Date(y, 0, 1).getTime(), 'Neujahr');
  add(addDays(e, -2), 'Karfreitag');
  add(addDays(e, 1), 'Ostermontag');
  add(new Date(y, 4, 1).getTime(), 'Tag der Arbeit');
  add(addDays(e, 39), 'Christi Himmelfahrt');
  add(addDays(e, 50), 'Pfingstmontag');
  add(addDays(e, 60), 'Fronleichnam');
  add(new Date(y, 9, 3).getTime(), 'Tag der Deutschen Einheit');
  add(new Date(y, 10, 1).getTime(), 'Allerheiligen');
  add(new Date(y, 11, 25).getTime(), '1. Weihnachtstag');
  add(new Date(y, 11, 26).getTime(), '2. Weihnachtstag');
  return map;
}

// Zählt für einen Zeitraum (Kalenderjahr oder Schuljahr), an wie vielen Tagen an welchem Ort gearbeitet wurde.
// Gezählt werden nur Tage mit erfasster Arbeitszeit. placeInfo(id) liefert { name, home }.
export function taxReport(blocks, per, now, placeInfo) {
  const days = new Map(); // Tag -> Menge der Arbeitsorte
  const trips = {};
  for (const b of blocks) {
    for (const s of segments(b, now)) {
      if (s.kind !== 'work') continue;
      const end = s.to > s.from ? s.to - 1 : s.to;
      for (let d = startOfDay(s.from); d <= end; d = addDays(d, 1)) {
        if (d < per.from || d >= per.to) continue;
        const k = dayKey(d);
        if (!days.has(k)) days.set(k, new Set());
        days.get(k).add(b.place);
      }
    }
    const start = blockStart(b);
    if (start >= per.from && start < per.to) trips[b.place] = (trips[b.place] || 0) + 1;
  }

  const holidays = new Map();
  for (let y = new Date(per.from).getFullYear(); y <= new Date(per.to - 1).getFullYear(); y++) {
    for (const [k, name] of holidaysNRW(y)) holidays.set(k, name);
  }
  const isWeekend = (ts) => [0, 6].includes(new Date(ts).getDay());

  // Zählung je Arbeitsort
  const count = {};
  let homeOnly = 0;
  let homeMixed = 0;
  const toTs = (k) => new Date(`${k}T00:00`).getTime();
  for (const [k, set] of days) {
    const off = isWeekend(toTs(k)) || holidays.has(k);
    let home = 0;
    for (const id of set) {
      if (!count[id]) count[id] = { days: 0, offDays: 0 };
      count[id].days++;
      if (off) count[id].offDays++;
      if (placeInfo(id).home) home++;
    }
    if (home && home === set.size) homeOnly++;
    else if (home) homeMixed++;
  }

  // Alle Tage bis heute, nach Monaten gruppiert, damit auch Tage ohne Erfassung zu sehen sind
  const months = [];
  const last = Math.min(per.to, addDays(startOfDay(now), 1));
  for (let d = per.from; d < last; d = addDays(d, 1)) {
    const date = new Date(d);
    const label = `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
    let month = months[months.length - 1];
    if (!month || month.label !== label) {
      month = { label, worked: 0, days: [] };
      months.push(month);
    }
    const k = dayKey(d);
    const places = days.has(k) ? [...days.get(k)] : [];
    if (places.length) month.worked++;
    month.days.push({ ts: d, places, weekend: isWeekend(d), holiday: holidays.get(k) || '' });
  }

  return {
    period: per,
    totalDays: days.size,
    places: Object.keys(count).map((id) => ({
      id,
      name: placeInfo(id).name,
      home: !!placeInfo(id).home,
      days: count[id].days,
      offDays: count[id].offDays,
      trips: trips[id] || 0,
    })),
    homeOnly,
    homeMixed,
    months,
  };
}

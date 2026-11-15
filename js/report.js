// Stellt Berichte zusammen: für einen Zeitraum (Tag, Woche, Monat, Schuljahr, Jahr oder frei gewählt)
// und für einen einzelnen Arbeitsort oder für alle zusammen.
//
// Es gibt zwei Formen:
// - "ausführlich" (z. B. NaturGut, Anforderungen 8.1): eine Zeile pro Arbeitsabschnitt,
//   jede Pause als eigene Zeile dazwischen.
// - "Übersicht" (Anforderungen 8.2): eine Zeile pro Arbeitsblock, die Pausen zusammengefasst.

import {
  DAY, MONTHS, WEEKDAYS,
  addDays, blockNotes, blockStart, dayKey, defaultCategory, fmtDate, fmtDur, isDetailed, nightCount, pad, pct, segments, startOfDay, stateOf,
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

// Für Excel (Anforderungen 8.1, 15.11.2026): Ein Zeitraum über mehrere Monate wird in Monate aufgeteilt,
// damit jeder Monat ein eigenes Blatt bekommt. Gilt für Schuljahr, Jahr und Von–Bis, nicht für Wochen.
// Angebrochene Monate (bei Von–Bis) bekommen als Bezeichnung die genauen Tage.
// Gibt eine leere Liste zurück, wenn alles in einem Monat liegt.
export function monthPeriods(per) {
  if (!['schuljahr', 'jahr', 'frei'].includes(per.kind)) return [];
  const out = [];
  let d = new Date(per.from);
  d = new Date(d.getFullYear(), d.getMonth(), 1);
  while (d.getTime() < per.to) {
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const from = Math.max(d.getTime(), per.from);
    const to = Math.min(next.getTime(), per.to);
    const name = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    const whole = from === d.getTime() && to === next.getTime();
    const last = addDays(to, -1);
    const label = whole ? name : from === last ? dmy(from) : `${dm(from)}–${dmy(last)}`;
    out.push({
      kind: 'monat',
      from,
      to,
      name,
      label,
      key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
      line: whole ? `Monat: ${label}` : `Zeitraum: ${label}`,
      sumLabel: 'Monatssumme netto (ohne Pausen)',
    });
    d = next;
  }
  return out.length > 1 ? out : [];
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

// Text für eine Zeile „Nachtruhe“ im Bericht
const nightRowText = (raw, f) => `Nachtruhe ${fmtDur(raw)} Std., davon ${pct(f)} gezählt`;

// Baut den Bericht. place ist die Kennung eines Arbeitsorts oder 'all' für alle.
// names = { place(id) -> Name des Orts, user: Name der Nutzerin }
// opts.night = false: Nachtruhe bei Klassenfahrten weder aufführen noch mitzählen (Häkchen beim Speichern)
export function buildReport(blocks, per, place, now, names, opts = {}) {
  const withNight = opts.night !== false;
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
  let nightRaw = 0;
  let nightCounted = 0;
  const nightFactors = new Set();

  for (const b of list) {
    // Nur der Teil, der im Zeitraum liegt. Ohne Nachtruhe wird sie zur Lücke ('gap'), die nicht zählt.
    const segs = [];
    for (const s of segments(b, now)) {
      if (s.kind === 'pause' && s.open) continue;
      const from = Math.max(s.from, per.from);
      const to = Math.min(s.to, per.to);
      const inside = to > from || (s.from === s.to && s.from >= per.from && s.from < per.to);
      if (!inside) continue;
      segs.push({ ...s, from, to, kind: s.kind === 'night' && !withNight ? 'gap' : s.kind });
    }
    const edge = (s) => s.kind === 'pause' || s.kind === 'gap';
    while (segs.length && edge(segs[0])) segs.shift();
    while (segs.length && edge(segs[segs.length - 1])) segs.pop();
    if (!segs.length) continue;

    const open = stateOf(b) !== 'done';
    if (open) openCount++;
    blockCount++;

    let ms = 0;
    let pause = 0;
    let hasNight = false;
    for (const s of segs) {
      if (s.kind === 'pause') {
        pause += s.to - s.from;
        continue;
      }
      if (s.kind === 'gap') {
        hasNight = true;
        continue;
      }
      // Nachtruhe zählt mit ihrem Anteil, auf volle Minuten gerundet
      const count = (ms0) => (s.kind === 'night' ? nightCount(ms0, s.f) : ms0);
      if (s.kind === 'night') {
        hasNight = true;
        nightRaw += s.to - s.from;
        nightCounted += count(s.to - s.from);
        nightFactors.add(s.f);
      }
      ms += count(s.to - s.from);
      for (const c of series) {
        const part = Math.min(s.to, c.to) - Math.max(s.from, c.from);
        if (part > 0) {
          c.ms += count(part);
          c.parts[b.place] = (c.parts[b.place] || 0) + count(part);
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
        if (s.kind === 'gap') continue;
        if (s.kind === 'night') {
          rows.push({
            type: 'night',
            id: b.id,
            date: lastDay ? '' : fmtDate(s.from),
            first: !lastDay,
            from: s.from,
            to: s.to,
            raw: s.to - s.from,
            ms: nightCount(s.to - s.from, s.f),
            f: s.f,
            text: nightRowText(s.to - s.from, s.f),
          });
          if (!lastDay) lastDay = dayKey(s.from);
          continue;
        }
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
      // Eine Zeile für einen Teil des Blocks (ohne Nachtruhe: für den ganzen Block)
      const blockRow = (ps, isFirst, note) => {
        const first = ps[0];
        const last = ps[ps.length - 1];
        const lastDay = last.to > first.from ? last.to - 1 : last.to;
        const multiDay = dayKey(first.from) !== dayKey(lastDay);
        let p = 0;
        let w = 0;
        for (const s of ps) {
          if (s.kind === 'pause') p += s.to - s.from;
          else w += s.to - s.from;
        }
        return {
          type: 'block',
          id: b.id,
          date: multiDay ? `${fmtDate(first.from)} bis ${fmtDate(lastDay)}` : fmtDate(first.from),
          first: isFirst,
          place: b.place,
          placeName: names.place(b.place),
          category,
          from: first.from,
          to: last.to,
          pauseMs: p,
          ms: w,
          note,
        };
      };
      if (!hasNight) {
        rows.push({ ...blockRow(segs, true, blockNotes(b).join(' · ')), pauseMs: pause, ms });
      } else {
        // Klassenfahrt mit Nachtruhe: Tag für Tag eine Zeile, dazwischen jede Nachtruhe als eigene Zeile
        let cur = [];
        let count = 0;
        const flush = () => {
          if (!cur.length) return;
          // Nur die eigenen Notizen dieses Tages. Die erste Zeile im Bericht übernimmt sonst die Notiz von davor.
          const notes = [];
          for (const s of cur) if (s.kind === 'work' && s.ownNote && !notes.includes(s.ownNote)) notes.push(s.ownNote);
          const w = cur.find((s) => s.kind === 'work');
          if (!notes.length && count === 0 && w && w.note) notes.push(w.note);
          rows.push(blockRow(cur, count === 0, notes.join(' · ')));
          count++;
          cur = [];
        };
        for (const s of segs) {
          if (s.kind === 'night' || s.kind === 'gap') {
            flush();
            if (s.kind === 'night') {
              rows.push({
                type: 'night',
                id: b.id,
                date: count === 0 ? fmtDate(s.from) : '',
                first: count === 0,
                place: b.place,
                from: s.from,
                to: s.to,
                raw: s.to - s.from,
                ms: nightCount(s.to - s.from, s.f),
                f: s.f,
                text: nightRowText(s.to - s.from, s.f),
              });
              count++;
            }
          } else cur.push(s);
        }
        flush();
      }
    }
  }
  const fs = [...nightFactors];
  const nightText = nightRaw > 0
    ? `davon Nachtruhe: ${fmtDur(nightCounted)} Std. gezählt (${fmtDur(nightRaw)} Std. Nachtruhe, ${fs.length === 1 ? `zu ${pct(fs[0])}` : 'zu unterschiedlichen Anteilen'})`
    : '';

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
    nightRaw, // Nachtruhe im Zeitraum (ganze Dauer), 0 wenn keine oder nicht mitgezählt
    nightMs: nightCounted, // davon gezählt (steckt schon in totalMs)
    nightText, // Zeile unter der Summe, z. B. „davon Nachtruhe: 8:15 Std. gezählt (16:30 Std. Nachtruhe, zu 50 %)“
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

// Schulferien in NRW als Vorlage zum Antippen: erster und letzter Ferientag.
// Quelle: Ferienordnung des Schulministeriums NRW (schulministerium.nrw), nachgesehen am 14.11.2026.
// Neue Schuljahre hier unten anhängen. Bewegliche Ferientage legt jede Schule selbst fest, die fehlen hier.
const FERIEN_NRW = [
  ['Herbstferien', '2025-10-13', '2025-10-25'],
  ['Weihnachtsferien', '2025-12-22', '2026-01-06'],
  ['Osterferien', '2026-03-30', '2026-04-11'],
  ['Pfingstferien', '2026-05-26', '2026-05-26'],
  ['Sommerferien', '2026-07-20', '2026-09-01'],
  ['Herbstferien', '2026-10-17', '2026-10-31'],
  ['Weihnachtsferien', '2026-12-23', '2027-01-06'],
  ['Osterferien', '2027-03-22', '2027-04-03'],
  ['Pfingstferien', '2027-05-18', '2027-05-18'],
  ['Sommerferien', '2027-07-19', '2027-08-31'],
  ['Herbstferien', '2027-10-23', '2027-11-06'],
  ['Weihnachtsferien', '2027-12-24', '2028-01-08'],
  ['Osterferien', '2028-04-10', '2028-04-22'],
  ['Sommerferien', '2028-07-10', '2028-08-22'],
  ['Herbstferien', '2028-10-23', '2028-11-04'],
  ['Weihnachtsferien', '2028-12-21', '2029-01-05'],
  ['Osterferien', '2029-03-26', '2029-04-07'],
  ['Pfingstferien', '2029-05-22', '2029-05-22'],
  ['Sommerferien', '2029-07-02', '2029-08-14'],
  ['Herbstferien', '2029-10-15', '2029-10-27'],
  ['Weihnachtsferien', '2029-12-20', '2030-01-04'],
  ['Osterferien', '2030-04-15', '2030-04-27'],
];

// Alle NRW-Ferien, die in den Zeitraum [from, to) hineinreichen: { name, from, to, keys }
export function ferienNRW(from, to) {
  const toTs = (k) => new Date(`${k}T00:00`).getTime();
  return FERIEN_NRW.map(([name, a, b]) => {
    const f = toTs(a);
    const t = toTs(b);
    const ya = a.slice(0, 4);
    const yb = b.slice(0, 4);
    const keys = [];
    for (let d = f; d <= t; d = addDays(d, 1)) keys.push(dayKey(d));
    return { name: `${name} ${ya === yb ? ya : `${ya}/${yb.slice(2)}`}`, from: f, to: t, keys };
  }).filter((x) => x.to >= from && x.from < to);
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

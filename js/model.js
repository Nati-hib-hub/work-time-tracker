// Zeitrechnung und Regeln. Hier steht keine Oberfläche, nur die Logik:
// Ein Arbeitsblock besteht aus Ereignissen (Start, Pause, Weiter, Stopp) mit Uhrzeit.
// Jede Dauer wird immer aus diesen Ereignissen berechnet und nie einzeln gespeichert.

export const MIN = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;

export const PLACE_IDS = ['schule', 'homeoffice', 'naturgut', 'fahrt'];

// categories: Auswahl an Kategorien für diesen Ort, die erste ist der Standard.
// detailed: Im Bericht bekommt jeder Arbeitsabschnitt (zwischen zwei Pausen) eine eigene Zeile und Notiz.
export const PLACE_META = {
  schule: {
    icon: '🏫',
    defaultName: 'Schule',
    defaultCategory: 'Unterricht',
    categories: ['Unterricht', 'Konferenz', 'Schulfest', 'Projektwoche', 'Elterngespräch', 'Fortbildung', 'Sonstiges'],
  },
  homeoffice: {
    icon: '🏠',
    defaultName: 'Homeoffice',
    defaultCategory: 'Unterrichtsvorbereitung',
    categories: ['Unterrichtsvorbereitung', 'Korrekturen', 'Konferenz (online)', 'Elterngespräch', 'Fortbildung', 'Sonstiges'],
  },
  naturgut: {
    icon: '🌿',
    defaultName: 'NaturGut Ophoven',
    defaultCategory: 'NaturGut',
    categories: ['NaturGut', 'Konferenz', 'Fortbildung', 'Fest/Veranstaltung', 'Sonstiges'],
    detailed: true,
  },
  fahrt: {
    icon: '🚌',
    defaultName: 'Klassenfahrt / Ausflug',
    defaultCategory: 'Klassenfahrt',
    categories: ['Klassenfahrt', 'Ausflug', 'Sonstiges'],
  },
};

export const isDetailed = (place) => !!(PLACE_META[place] && PLACE_META[place].detailed);
export const categoriesFor = (place) => (PLACE_META[place] ? PLACE_META[place].categories : []);

export const LABEL = { start: 'Start', pause: 'Pause', weiter: 'Weiter', stopp: 'Stopp' };
export const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// ---------- Einstellungen ----------

export function defaultSettings() {
  return {
    userName: '',
    places: Object.fromEntries(PLACE_IDS.map((id) => [id, { name: PLACE_META[id].defaultName }])),
    warnRunHours: 10,
    warnPauseHours: 3,
  };
}

export function mergeSettings(saved) {
  const d = defaultSettings();
  if (!saved) return d;
  return {
    ...d,
    ...saved,
    places: Object.fromEntries(PLACE_IDS.map((id) => [id, { ...d.places[id], ...((saved.places || {})[id] || {}) }])),
  };
}

// ---------- Datum und Uhrzeit ----------

export const pad = (n) => String(n).padStart(2, '0');

export function floorMin(ms) {
  return Math.floor(ms / MIN) * MIN;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function fmtDateShort(ts) {
  const d = new Date(ts);
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
}

// Dauer als Stunden:Minuten, z. B. 7:48
export function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

// Tag als 2026-11-11 (so erwarten es die Datumsfelder im Browser)
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

// Aus "2026-11-11" und "07:15" wird ein Zeitpunkt. Gibt null zurück, wenn etwas fehlt.
export function combine(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const ts = new Date(y, m - 1, d, h, mi).getTime();
  return Number.isFinite(ts) ? ts : null;
}

// ---------- Arbeitsblöcke ----------

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function newBlock(place, ts) {
  return {
    id: uid(),
    place,
    category: PLACE_META[place].defaultCategory,
    events: [{ t: 'start', ts }],
  };
}

export const lastEvent = (b) => b.events[b.events.length - 1];
export const blockStart = (b) => b.events[0].ts;

// 'running' = Uhr läuft, 'paused' = Pause, 'done' = gestoppt
export function stateOf(b) {
  const t = lastEvent(b).t;
  if (t === 'stopp') return 'done';
  return t === 'pause' ? 'paused' : 'running';
}

export function blockEnd(b, now) {
  return stateOf(b) === 'done' ? lastEvent(b).ts : Math.max(now, lastEvent(b).ts);
}

// Zerlegt einen Block in Abschnitte: Arbeit ('work') und Pause ('pause').
// Die Notiz eines Arbeitsabschnitts gilt weiter, bis ein späterer Abschnitt eine eigene hat.
export function segments(b, now) {
  const out = [];
  let note = '';
  for (let i = 0; i < b.events.length; i++) {
    const e = b.events[i];
    const next = b.events[i + 1];
    if (e.t === 'stopp') break;
    const to = next ? next.ts : Math.max(now, e.ts);
    if (e.t === 'pause') {
      out.push({ kind: 'pause', from: e.ts, to, open: !next, idx: i });
    } else {
      if (e.note) note = e.note;
      out.push({ kind: 'work', from: e.ts, to, open: !next, idx: i, note, ownNote: e.note || '' });
    }
  }
  return out;
}

// Netto-Arbeitszeit (ohne Pausen), auf Wunsch nur der Teil zwischen from und to
export function netMs(b, now, from = -Infinity, to = Infinity) {
  let sum = 0;
  for (const s of segments(b, now)) {
    if (s.kind === 'work') sum += Math.max(0, Math.min(s.to, to) - Math.max(s.from, from));
  }
  return sum;
}

export function pauseMs(b, now) {
  let sum = 0;
  for (const s of segments(b, now)) if (s.kind === 'pause') sum += s.to - s.from;
  return sum;
}

// Alle Notizen eines Blocks, ohne Wiederholungen
export function blockNotes(b) {
  const seen = [];
  for (const e of b.events) if (e.note && !seen.includes(e.note)) seen.push(e.note);
  return seen;
}

// Prüft, ob das Protokoll in sich stimmt. Gibt einen Fehlertext zurück oder null.
export function validate(b, now) {
  const ev = b.events;
  if (!ev.length || ev[0].t !== 'start') return 'Ein Arbeitsblock muss mit Start beginnen.';
  for (let i = 1; i < ev.length; i++) {
    const p = ev[i - 1];
    const e = ev[i];
    let ok = false;
    if (p.t === 'start' || p.t === 'weiter') ok = e.t === 'pause' || e.t === 'stopp';
    else if (p.t === 'pause') ok = e.t === 'weiter' || e.t === 'stopp';
    if (!ok) return 'Die Reihenfolge im Protokoll stimmt nicht.';
    if (e.ts < p.ts) {
      return `${LABEL[e.t]} (${fmtDateShort(e.ts)} ${fmtTime(e.ts)}) liegt vor ${LABEL[p.t]} (${fmtDateShort(p.ts)} ${fmtTime(p.ts)}). Bitte die Uhrzeit anpassen.`;
    }
  }
  if (lastEvent(b).ts > now + MIN) return 'Die Uhrzeit liegt in der Zukunft.';
  return null;
}

// Zeitrechnung und Regeln. Hier steht keine Oberfläche, nur die Logik:
// Ein Arbeitsblock besteht aus Ereignissen (Start, Pause, Weiter, Stopp) mit Uhrzeit.
// Jede Dauer wird immer aus diesen Ereignissen berechnet und nie einzeln gespeichert.

export const MIN = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;

export const LABEL = { start: 'Start', pause: 'Pause', weiter: 'Weiter', stopp: 'Stopp' };
export const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// ---------- Arbeitsorte ----------
//
// Die Arbeitsorte stehen in den Einstellungen und lassen sich in der App ändern und ergänzen.
// Ein Arbeitsort hat:
//   id          feste Kennung, mit der die Arbeitsblöcke ihren Ort merken
//   name, icon  Anzeige
//   color       Nummer der Farbe (0 bis 7, die Farben selbst stehen in style.css)
//   categories  Auswahl an Kategorien, die erste ist beim Start automatisch gewählt
//   detailed    ausführlicher Bericht: jeder Abschnitt zwischen zwei Pausen hat eine eigene Zeile und Notiz
//   hidden      ausgeblendet: wird nicht mehr zur Auswahl angeboten, alte Zeiten bleiben erhalten
//   trip        Klassenfahrt: keine Hinweise bei langer Laufzeit
//   home        Arbeitsplatz zu Hause: zählt in der Steuer-Übersicht als Homeoffice

export const COLOR_NAMES = ['Blau', 'Orange', 'Grün', 'Lila', 'Pink', 'Türkis', 'Braun', 'Grau'];
export const ICONS = ['🏫', '🏠', '🌿', '🚌', '🏛️', '🎓', '🧪', '📚', '💼', '🌳', '🏢', '⭐'];

const DEFAULT_PLACES = [
  {
    id: 'schule',
    name: 'Schule',
    icon: '🏫',
    color: 0,
    categories: ['Unterricht', 'Konferenz', 'Schulfest', 'Projektwoche', 'Elterngespräch', 'Fortbildung', 'Sonstiges'],
  },
  {
    id: 'homeoffice',
    name: 'Homeoffice',
    icon: '🏠',
    color: 1,
    categories: ['Unterrichtsvorbereitung', 'Korrekturen', 'Konferenz (online)', 'Elterngespräch', 'Fortbildung', 'Sonstiges'],
  },
  {
    id: 'naturgut',
    name: 'NaturGut Ophoven',
    icon: '🌿',
    color: 2,
    categories: ['NaturGut', 'Konferenz', 'Fortbildung', 'Fest/Veranstaltung', 'Sonstiges'],
    detailed: true,
  },
  {
    id: 'fahrt',
    name: 'Klassenfahrt / Ausflug',
    icon: '🚌',
    color: 3,
    categories: ['Klassenfahrt', 'Ausflug', 'Sonstiges'],
    trip: true,
  },
];

function cleanPlace(p, i) {
  const cats = Array.isArray(p.categories) ? p.categories.map((c) => String(c).trim()).filter(Boolean) : [];
  return {
    id: String(p.id),
    name: String(p.name || '').trim().slice(0, 40) || 'Arbeitsort',
    icon: p.icon || '💼',
    color: Number.isInteger(p.color) ? ((p.color % 8) + 8) % 8 : i % 8,
    categories: cats.length ? cats : ['Allgemein', 'Sonstiges'],
    detailed: !!p.detailed,
    hidden: !!p.hidden,
    trip: !!p.trip,
    // Arbeitsplatz zu Hause (für die Steuer-Übersicht). Bei älteren Daten fehlt die Angabe noch.
    home: p.home === undefined ? p.id === 'homeoffice' : !!p.home,
  };
}

// Eine neu installierte App hat noch keine Arbeitsorte. Diese Vorlagen werden beim ersten Start
// zum Antippen angeboten, damit niemand alles von Hand anlegen muss.
const TEMPLATE_IDS = ['schule', 'homeoffice', 'fahrt'];
export const placeTemplates = () => DEFAULT_PLACES.filter((p) => TEMPLATE_IDS.includes(p.id)).map(cleanPlace);

// Arbeitsort zu einer Kennung, die in gespeicherten Arbeitsblöcken vorkommt, aber in der Liste fehlt
export function repairPlace(id) {
  const known = DEFAULT_PLACES.find((p) => p.id === id);
  return cleanPlace(known || { id, name: 'Unbekannter Ort', icon: '❓', color: 7, categories: ['Sonstiges'], hidden: true }, 0);
}

let places = [];

// Wird beim Start und nach jeder Änderung der Einstellungen aufgerufen
export function setPlaces(list) {
  places = list;
}
export const allPlaces = () => places;
export const visiblePlaces = () => places.filter((p) => !p.hidden);
export const placeIds = () => places.map((p) => p.id);

// Liefert immer einen Arbeitsort, auch wenn die Kennung unbekannt ist (z. B. nach einem Fehler)
export function placeOf(id) {
  return places.find((p) => p.id === id) || { id, name: 'Unbekannter Ort', icon: '❓', color: 7, categories: ['Sonstiges'], detailed: false, hidden: true, trip: false, home: false };
}
export const isDetailed = (id) => placeOf(id).detailed;
export const categoriesFor = (id) => placeOf(id).categories;
export const defaultCategory = (id) => placeOf(id).categories[0] || 'Sonstiges';

export function newPlace() {
  const used = places.map((p) => p.color);
  let color = 0;
  for (let c = 0; c < 8; c++) {
    if (!used.includes(c)) {
      color = c;
      break;
    }
  }
  return cleanPlace({ id: `p${uid()}`, name: 'Neuer Arbeitsort', icon: '💼', color, categories: ['Allgemein', 'Sonstiges'] }, 0);
}

// ---------- Einstellungen ----------

export function defaultSettings() {
  return {
    userName: '',
    places: [],
    warnRunHours: 10,
    warnPauseHours: 3,
    theme: 'auto', // Darstellung: 'auto' = wie das Handy, 'light' = hell, 'dark' = dunkel
  };
}

// saved = gespeicherte Einstellungen (oder nichts), hasBlocks = es gibt schon gespeicherte Arbeitsblöcke
export function mergeSettings(saved, hasBlocks) {
  const d = defaultSettings();
  let list = [];
  if (saved && Array.isArray(saved.places)) {
    list = saved.places.filter((p) => p && p.id).map(cleanPlace);
  } else if (saved || hasBlocks) {
    // Ältere Fassung der App: Dort gab es vier fest eingebaute Orte, gespeichert waren nur ihre Namen.
    const old = (saved && saved.places) || {};
    list = DEFAULT_PLACES.map(cleanPlace).map((p) => ({ ...p, name: (old[p.id] && String(old[p.id].name || '').trim()) || p.name }));
  }
  // Sonst: ganz neue App, noch ohne Arbeitsorte.
  return { ...d, ...(saved || {}), places: list };
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
    category: defaultCategory(place),
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

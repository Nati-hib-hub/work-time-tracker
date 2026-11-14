// Oberfläche der App: Bildschirme, Knöpfe und Eingaben.

import * as M from './model.js';
import * as store from './store.js';
import { PERIOD_KINDS, buildReport, holidaysNRW, period, shiftAnchor, taxReport } from './report.js';
import { reportPdf } from './pdf.js';
import { reportXlsx } from './xlsx.js';

const VERSION = '0.12 · Sicherung repariert, Selbst-Aktualisierung';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { blocks: [], settings: M.defaultSettings() };
const today = new Date();
const ui = {
  tab: 'home',
  detailId: null,
  histMonth: { y: today.getFullYear(), m: today.getMonth() },
  // Bericht: Art des Zeitraums, ein Zeitpunkt darin, Arbeitsort ('all' = alle) und die Tage für "Von–Bis"
  catsOpen: null, // Arbeitsblock, bei dem „Weitere“ Kategorien gerade aufgeklappt sind
  repMode: 'zeit', // 'zeit' = Arbeitszeit-Berichte, 'steuer' = Tage zählen für die Steuererklärung, 'krank' = Krankentage
  sickMonth: { y: today.getFullYear(), m: today.getMonth() },
  taxKind: 'jahr', // 'jahr' = Kalenderjahr, 'schuljahr'
  taxAnchor: today.getTime(),
  rep: { kind: 'monat', anchor: today.getTime(), place: 'all', from: M.dayKey(today.getTime()), to: M.dayKey(today.getTime()) },
  sheet: null,
};
let lastRep = null;
let skipPop = 0;

const now = () => M.floorMin(Date.now());
const byId = (id) => state.blocks.find((b) => b.id === id);
const openBlock = () =>
  state.blocks.filter((b) => M.stateOf(b) !== 'done').sort((a, b) => M.blockStart(b) - M.blockStart(a))[0] || null;
const placeName = (id) => M.placeOf(id).name;
const placeLabel = (id) => `${M.placeOf(id).icon} ${esc(placeName(id))}`;
// Orte zur Auswahl: alle sichtbaren, dazu der gerade gewählte, falls er ausgeblendet ist
const choosablePlaces = (currentId) => M.allPlaces().filter((p) => !p.hidden || p.id === currentId);

// Jeder Arbeitsort bekommt seine Farbe über eine kleine, automatisch erzeugte Stilvorlage.
function applyPlaceColors() {
  let el = $('#place-colors');
  if (!el) {
    el = document.createElement('style');
    el.id = 'place-colors';
    document.head.append(el);
  }
  el.textContent = M.allPlaces().map((p) => `.place-${p.id}{--pc:var(--c${p.color})}`).join('\n');
}
// Hell oder dunkel: nach Handy-Einstellung oder fest gewählt
const THEME_BAR = { light: '#1f7a6d', dark: '#11171a' };
function applyTheme() {
  const th = state.settings.theme;
  const root = document.documentElement;
  if (th === 'light' || th === 'dark') root.dataset.theme = th;
  else delete root.dataset.theme;
  // Farbe der Leiste oben am Handy
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const sys = (m.getAttribute('media') || '').includes('dark') ? 'dark' : 'light';
    m.setAttribute('content', THEME_BAR[th === 'light' || th === 'dark' ? th : sys]);
  });
}

const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement || {}).tagName);
const hasSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

// ---------- Speichern ----------

function saveFailed(err) {
  console.error(err);
  toast('Speichern hat leider nicht geklappt.');
}
const saveBlock = (b) => store.putBlock(b).catch(saveFailed);
const saveSettings = () => store.putSettings(state.settings).catch(saveFailed);

// ---------- Kleine Helfer ----------

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3800);
}

// "07:15 Uhr", "gestern 07:15 Uhr" oder "Mo 09.11., 07:15 Uhr"
function fmtWhen(ts, t) {
  const diff = Math.round((M.startOfDay(t) - M.startOfDay(ts)) / M.DAY);
  if (diff === 0) return `${M.fmtTime(ts)} Uhr`;
  if (diff === 1) return `gestern ${M.fmtTime(ts)} Uhr`;
  return `${M.fmtDateShort(ts)}, ${M.fmtTime(ts)} Uhr`;
}

function sumRange(t, from, to) {
  let sum = 0;
  for (const b of state.blocks) sum += M.netMs(b, t, from, to);
  return sum;
}
const sumToday = (t) => sumRange(t, M.startOfDay(t), M.addDays(M.startOfDay(t), 1));

// Vorschläge für Notizen: was am selben Arbeitsort am häufigsten verwendet wurde, steht vorn.
// Bei gleicher Häufigkeit kommt die zuletzt verwendete Notiz zuerst. Es gibt höchstens drei Vorschläge.
function recentNotes(place, exceptId) {
  const stat = new Map();
  for (const b of state.blocks) {
    if (b.place !== place || b.id === exceptId) continue;
    const ts = M.blockStart(b);
    for (const n of M.blockNotes(b)) {
      const s = stat.get(n) || { n, count: 0, last: 0 };
      s.count++;
      s.last = Math.max(s.last, ts);
      stat.set(n, s);
    }
  }
  return [...stat.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, 3)
    .map((s) => s.n);
}

const missingNotes = (b) => M.segments(b, now()).some((s) => s.kind === 'work' && !s.note);

// ---------- Hinweise beim Öffnen ----------

function hints(b, t) {
  if (!b || M.placeOf(b.place).trip) return [];
  const st = M.stateOf(b);
  const last = M.lastEvent(b);
  const s = state.settings;
  const out = [];
  if (st === 'running') {
    if (M.dayKey(last.ts) !== M.dayKey(t)) {
      out.push({
        text: `Die Uhr läuft seit ${fmtWhen(last.ts, t)}, also über Nacht. Wann hast du aufgehört?`,
        acts: [['fixEnd', 'Korrigieren']],
      });
    } else if (t - last.ts > s.warnRunHours * M.HOUR && !b.longOk) {
      out.push({
        text: `Die Uhr läuft seit über ${s.warnRunHours} Stunden ohne Pause. Stimmt das?`,
        acts: [['fixOpen', 'Korrigieren'], ['hintOk', 'Stimmt so']],
      });
    }
  } else if (st === 'paused' && t - last.ts > s.warnPauseHours * M.HOUR) {
    out.push({
      text: `Die Pause läuft seit über ${s.warnPauseHours} Stunden (seit ${fmtWhen(last.ts, t)}). Hast du vergessen, Stopp zu drücken?`,
      acts: [['stopAtPause', `Um ${M.fmtTime(last.ts)} beenden`], ['fixOpen', 'Korrigieren']],
    });
  }
  return out;
}

function hintsHtml(b, t) {
  return hints(b, t)
    .map(
      (h) => `<section class="hint"><p>${esc(h.text)}</p><div class="hint-acts">${h.acts
        .map(([act, label]) => `<button class="btn small" data-act="${act}" data-id="${b.id}">${esc(label)}</button>`)
        .join('')}</div></section>`
    )
    .join('');
}

// ---------- Datensicherung ----------
//
// Die Sicherung ist eine Datei (JSON) mit allen Arbeitsblöcken und allen Einstellungen.
// In den Einstellungen stehen auch Arbeitsorte, Krankentage und später Ferientage.

const BACKUP_APP = 'work-time-tracker';
const BACKUP_FORMAT = 1;

const validEvent = (e) => e && M.LABEL[e.t] && Number.isFinite(e.ts);
const validBlock = (b) => b && typeof b.id === 'string' && typeof b.place === 'string' && Array.isArray(b.events) && b.events.length > 0 && b.events.every(validEvent);

// Chrome auf Android teilt keine .json-Dateien (meldet aber vorher trotzdem „geht“).
// Deshalb wird die Sicherung zum Teilen als .txt verpackt. Der Inhalt ist derselbe.
function backupFile(forShare) {
  const t = Date.now();
  const text = JSON.stringify({ app: BACKUP_APP, format: BACKUP_FORMAT, created: new Date(t).toISOString(), version: VERSION, settings: state.settings, blocks: state.blocks });
  const base = `Work-Time-Tracker-Sicherung-${M.dayKey(t)}`;
  if (forShare) return new File([text], `${base}.txt`, { type: 'text/plain' });
  return new File([text], `${base}.json`, { type: 'application/json' });
}

// Datei herunterladen oder teilen. Gibt true zurück, wenn es geklappt hat.
async function deliverFile(file, mode, title) {
  if (mode === 'share') {
    try {
      await navigator.share({ files: [file], title });
      return true;
    } catch (e) {
      // Der Grund in Klammern hilft bei der Fehlersuche.
      if (e.name !== 'AbortError') toast(`Teilen hat nicht geklappt (${e.name || 'Fehler'}). Versuche es mit „Herunterladen“.`);
      return false;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  toast('Die Datei liegt jetzt im Download-Ordner.');
  return true;
}

const backupBtns = () =>
  `${canShareFiles() ? '<button class="btn primary" data-act="backup" data-mode="share"><span>📤 Sicherung teilen<small class="btn-sub">z. B. in Google Drive oder per E-Mail an dich</small></span></button>' : ''}
  <button class="btn ${canShareFiles() ? '' : 'primary'}" data-act="backup" data-mode="save">⬇️ Sicherung herunterladen</button>`;

const lastBackupText = () => {
  const lb = state.settings.lastBackup;
  return lb ? `Letzte Sicherung: <b>${M.fmtDate(lb)}</b>` : 'Du hast noch keine Sicherung gespeichert.';
};

// Ist eine Erinnerung an die Sicherung fällig?
function backupDue(t) {
  const s = state.settings;
  if (!state.blocks.length) return false;
  if (s.backupSnooze && t < s.backupSnooze) return false;
  const last = s.lastBackup || 0;
  if (!last) {
    // Noch nie gesichert: erinnern, sobald die erste Erfassung eine Woche alt ist
    const first = Math.min(...state.blocks.map(M.blockStart));
    return t - first >= 7 * M.DAY;
  }
  if (s.backupEvery === 'woche') return t - last >= 7 * M.DAY;
  // Monatlich: sobald ein neuer Kalendermonat begonnen hat (passt zum NaturGut-Monatsbericht)
  const a = new Date(last);
  const b = new Date(t);
  return a.getFullYear() * 12 + a.getMonth() < b.getFullYear() * 12 + b.getMonth();
}

// Aufbewahrung: Mindestens das laufende und das vorige Schuljahr bleiben. Alles davor gilt als alt.
function oldData(t) {
  const cur = period('schuljahr', t);
  const cutoff = period('schuljahr', M.addDays(cur.from, -1)).from;
  const blocks = state.blocks.filter((b) => M.stateOf(b) === 'done' && M.lastEvent(b).ts < cutoff);
  const sick = sickDays().filter((k) => keyToTs(k) < cutoff);
  const lastOld = period('schuljahr', M.addDays(cutoff, -1));
  const oldest = Math.min(...blocks.map(M.blockStart), ...sick.map(keyToTs));
  const label = `${lastOld.label}${oldest < lastOld.from ? ' und früher' : ''}`;
  return { cutoff, blocks, sick, label };
}

function backupHints(t) {
  let h = '';
  if (backupDue(t)) {
    const lb = state.settings.lastBackup;
    h += `<section class="hint"><p>💾 ${
      lb ? `Deine letzte Sicherung ist vom ${M.fmtDate(lb)}.` : 'Du hast noch keine Sicherung deiner Zeiten gespeichert.'
    } Magst du jetzt eine Sicherung machen? Dann gehen deine Zeiten nicht verloren, falls dem Handy etwas passiert.</p>
      <div class="hint-acts"><button class="btn small" data-act="backupOpen">Jetzt sichern</button><button class="btn small" data-act="backupLater">Später</button></div></section>`;
  }
  const old = oldData(t);
  if ((old.blocks.length || old.sick.length) && state.settings.oldDataOk !== old.cutoff) {
    h += `<section class="hint"><p>🗂️ Es gibt Daten aus dem ${esc(old.label)}. Die App hebt mindestens zwei Schuljahre auf. Jetzt sichern und löschen?</p>
      <div class="hint-acts"><button class="btn small" data-act="oldOpen">Sichern und löschen …</button><button class="btn small" data-act="oldKeep">Behalten</button></div></section>`;
  }
  return h;
}

function backupSheetHtml() {
  return `<h2>Sicherung speichern</h2>
    <p>Die Sicherung ist eine kleine Datei mit allen deinen Zeiten, Arbeitsorten, Krankentagen und Einstellungen.</p>
    <p>Bewahre sie <b>außerhalb des Handys</b> auf, zum Beispiel in Google Drive oder als E-Mail an dich selbst. Mit „Sicherung einlesen“ (unter „Einstellungen“) holst du alles zurück, auch auf einem neuen Handy.</p>
    <p class="muted small">${lastBackupText()}</p>
    ${backupBtns()}
    ${CANCEL}`;
}

function oldSheetHtml() {
  const t = now();
  const old = oldData(t);
  const ms = old.blocks.reduce((s, b) => s + M.netMs(b, t), 0);
  const backedUpToday = state.settings.lastBackup && state.settings.lastBackup >= M.startOfDay(t);
  const parts = [];
  if (old.blocks.length) parts.push(`<b>${old.blocks.length} ${old.blocks.length === 1 ? 'Arbeitsblock' : 'Arbeitsblöcke'}</b> mit zusammen ${M.fmtDur(ms)} Stunden`);
  if (old.sick.length) parts.push(`<b>${nDays(old.sick.length)}</b> als krank markiert`);
  return `<h2>Alte Daten löschen?</h2>
    <p>Betroffen ist alles vor dem ${M.fmtDate(old.cutoff)} (${esc(old.label)}): ${parts.join(' und ') || 'nichts mehr'}.</p>
    <p><b>Schritt 1:</b> Speichere vorher eine Sicherung. Dann kannst du die alten Daten später jederzeit wieder einlesen. Wenn du noch Berichte für diese Zeit brauchst, erstelle sie vorher unter „Berichte“.</p>
    ${backupBtns()}
    <p class="muted small">${lastBackupText()}</p>
    <p><b>Schritt 2:</b> Alte Daten löschen.</p>
    ${backedUpToday ? '' : '<p class="note-box">Du hast heute noch keine Sicherung gespeichert. Ohne Sicherung sind die alten Daten nach dem Löschen endgültig weg.</p>'}
    <button class="btn danger" data-act="oldDel">${backedUpToday ? 'Alte Daten löschen' : 'Ohne Sicherung löschen'}</button>
    <button class="btn ghost" data-act="oldKeep">Lieber behalten</button>`;
}

// Liest eine Sicherungsdatei. Gibt { blocks, settings, created } oder { err } zurück.
function readBackup(text) {
  const bad = { err: 'Diese Datei ist keine Sicherung des Work Time Trackers. Bitte wähle die Datei, die mit „Work-Time-Tracker-Sicherung“ beginnt.' };
  let d;
  try {
    d = JSON.parse(text);
  } catch (e) {
    return bad;
  }
  if (!d || d.app !== BACKUP_APP || !Array.isArray(d.blocks) || !d.settings || typeof d.settings !== 'object') return bad;
  if (Number(d.format) > BACKUP_FORMAT) {
    return { err: 'Diese Sicherung stammt aus einer neueren Fassung der App. Bitte schließe die App ganz, öffne sie noch einmal (dann holt sie sich die neue Fassung) und versuche es danach erneut.' };
  }
  const blocks = d.blocks.filter(validBlock);
  return { blocks, settings: d.settings, created: Date.parse(d.created) || 0, skipped: d.blocks.length - blocks.length };
}

let pendingRestore = null;

function restoreSheetHtml() {
  const r = pendingRestore;
  const n = (k) => `${k} ${k === 1 ? 'Arbeitsblock' : 'Arbeitsblöcke'}`;
  const placesIn = Array.isArray(r.settings.places) ? r.settings.places.length : 0;
  const sickIn = Array.isArray(r.settings.sickDays) ? r.settings.sickDays.length : 0;
  const starts = r.blocks.map(M.blockStart);
  const range = starts.length ? ` aus der Zeit vom ${M.fmtDate(Math.min(...starts))} bis ${M.fmtDate(Math.max(...starts))}` : '';
  let h = `<h2>Sicherung einlesen</h2>
    <p>Sicherung vom <b>${r.created ? `${M.fmtDate(r.created)}, ${M.fmtTime(r.created)} Uhr` : 'unbekannten Datum'}</b>.</p>
    <p>Darin: ${n(r.blocks.length)}${range}, ${placesIn} ${placesIn === 1 ? 'Arbeitsort' : 'Arbeitsorte'}${sickIn ? `, ${nDays(sickIn)} als krank markiert` : ''}.</p>
    ${r.skipped ? `<p class="muted small">${n(r.skipped)} in der Datei waren beschädigt und werden übersprungen.</p>` : ''}`;
  if (!state.blocks.length) {
    return `${h}<p>Auf diesem Handy sind noch keine Zeiten gespeichert. Die Arbeitsorte und Einstellungen kommen aus der Sicherung.</p>
      <button class="btn primary" data-act="restoreDo" data-how="replace">Sicherung einlesen</button>${CANCEL}`;
  }
  const have = new Set(state.blocks.map((b) => b.id));
  const inFile = new Set(r.blocks.map((b) => b.id));
  const fresh = r.blocks.filter((b) => !have.has(b.id)).length;
  const onlyHere = state.blocks.filter((b) => !inFile.has(b.id)).length;
  h += `<p>Auf diesem Handy sind gerade ${n(state.blocks.length)} gespeichert.</p>
    ${fresh ? '' : '<p class="note-box">✅ Alle Arbeitsblöcke aus dieser Sicherung sind schon auf diesem Handy. Es fehlt nichts. Du kannst einfach auf „Abbrechen“ tippen.</p>'}
    <h2 class="sub">Ergänzen (empfohlen)</h2>
    <p class="muted small">Alles, was schon auf diesem Handy ist, bleibt. Aus der Sicherung kommt nur dazu, was hier fehlt: ${fresh ? n(fresh) : 'keine Arbeitsblöcke'}, dazu fehlende Arbeitsorte und Krankentage.</p>
    <button class="btn primary" data-act="restoreDo" data-how="merge">Ergänzen</button>
    <h2 class="sub">Alles ersetzen</h2>
    <p class="muted small">Alles auf diesem Handy wird durch die Sicherung ersetzt, auch Arbeitsorte und Einstellungen.</p>
    ${onlyHere ? `<p class="note-box">${n(onlyHere)} ${onlyHere === 1 ? 'ist' : 'sind'} nur auf diesem Handy und nicht in der Sicherung. ${onlyHere === 1 ? 'Er wäre' : 'Sie wären'} danach weg.</p>` : ''}
    <button class="btn danger" data-act="restoreDo" data-how="replace">Alles ersetzen</button>
    ${CANCEL}`;
  return h;
}

// Arbeitsblöcke und gespeicherte Einstellungen zu einem gültigen Stand zusammenbauen.
// Jeder Arbeitsblock braucht seinen Arbeitsort in der Liste (sonst wird er ergänzt).
function prepareData(blocks, saved) {
  const settings = M.mergeSettings(saved, blocks.length > 0);
  let repaired = false;
  for (const b of blocks) {
    if (!settings.places.some((p) => p.id === b.place)) {
      settings.places.push(M.repairPlace(b.place));
      repaired = true;
    }
  }
  return { blocks, settings, repaired };
}

function adoptData(d) {
  state.blocks = d.blocks;
  state.settings = d.settings;
  M.setPlaces(state.settings.places);
  applyPlaceColors();
  applyTheme();
}

// ---------- Bausteine ----------

function blockItem(b, t) {
  const st = M.stateOf(b);
  const from = M.fmtTime(M.blockStart(b));
  const to = st === 'done' ? M.fmtTime(M.lastEvent(b).ts) : st === 'paused' ? 'Pause' : 'läuft';
  const p = M.pauseMs(b, t);
  const notes = M.blockNotes(b).join(' · ');
  const cat = b.category ? ` · ${esc(b.category)}` : '';
  return `<button class="item place-${b.place}" data-act="openDetail" data-id="${b.id}">
    <span class="dot"></span>
    <span class="item-main">
      <span class="item-title">${placeLabel(b.place)}${cat}</span>
      <span class="item-sub">${from}–${to}${p > 0 ? ` · Pause ${M.fmtDur(p)}` : ''}</span>
      ${notes ? `<span class="item-note">${esc(notes)}</span>` : ''}
    </span>
    <span class="item-dur">${M.fmtDur(M.netMs(b, t))}</span>
  </button>`;
}

function noteField(b, idx, own, placeholder) {
  const mic = hasSpeech ? `<button class="icon-btn mic" data-act="mic" aria-label="Notiz diktieren">🎤</button>` : '';
  return `<div class="note-row"><input type="text" data-input="segnote" data-id="${b.id}" data-idx="${idx}" value="${esc(own)}" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="done" maxlength="200">${mic}</div>`;
}

// Kategorien zum Antippen. Eine frühere Kategorie, die es in der Liste nicht mehr gibt, bleibt wählbar.
// Zu sehen sind zuerst die fünf Kategorien, die an diesem Arbeitsort am häufigsten verwendet wurden
// (bei gleicher Häufigkeit in der Reihenfolge aus den Einstellungen). Der Rest steckt hinter „Weitere“.
// Die gerade gewählte Kategorie ist immer sichtbar.
const CAT_TOP = 5;
function catChips(b) {
  const cats = [...M.categoriesFor(b.place)];
  if (b.category && !cats.includes(b.category)) cats.unshift(b.category);
  const count = {};
  for (const x of state.blocks) {
    if (x.place === b.place && x.id !== b.id && x.category) count[x.category] = (count[x.category] || 0) + 1;
  }
  const order = cats
    .map((c, i) => ({ c, i, n: count[c] || 0 }))
    .sort((a, z) => z.n - a.n || a.i - z.i)
    .map((o) => o.c);
  const top = order.slice(0, CAT_TOP);
  let rest = order.slice(CAT_TOP);
  if (rest.includes(b.category)) {
    rest = [top.pop(), ...rest.filter((c) => c !== b.category)];
    top.push(b.category);
  }
  const chip = (c) => `<button class="chip ${c === b.category ? 'on' : ''}" data-act="setCat" data-id="${b.id}" data-cat="${esc(c)}">${esc(c)}</button>`;
  // Für eine einzige weitere Kategorie lohnt sich kein „Weitere“-Knopf.
  if (rest.length <= 1) return `<div class="chips">${[...top, ...rest].map(chip).join('')}</div>`;
  const open = ui.catsOpen === b.id;
  return `<div class="chips">${top.map(chip).join('')}<button class="chip more-btn" data-act="catMore" data-id="${b.id}" aria-expanded="${open}">${open ? 'Weniger ▴' : 'Weitere ▾'}</button></div>
  <div class="more-wrap ${open ? 'open' : ''}"><div class="chips more-inner">${rest.map(chip).join('')}</div></div>`;
}

function monthSwitch(which, mm) {
  return `<div class="month-switch">
    <button class="icon-btn" data-act="month" data-which="${which}" data-d="-1" aria-label="Monat zurück">‹</button>
    <strong>${M.MONTHS[mm.m]} ${mm.y}</strong>
    <button class="icon-btn" data-act="month" data-which="${which}" data-d="1" aria-label="Monat vor">›</button>
  </div>`;
}

// ---------- Bildschirm: Heute ----------

function viewHome() {
  const t = now();
  const b = openBlock();
  const todayMs = sumToday(t);
  let h = hintsHtml(b, t) + backupHints(t);

  if (!M.allPlaces().length) {
    h += `<section class="card"><h2>Willkommen!</h2>${starterHtml()}</section>`;
  } else if (M.allPlaces().length < 3 && M.placeTemplates().some((p) => !M.placeIds().includes(p.id)) && !state.blocks.length) {
    // Solange noch nichts erfasst ist, bleiben die übrigen Vorlagen zum Antippen sichtbar.
    h += `<section class="card"><h2>Weitere Arbeitsorte?</h2>${starterHtml()}</section>`;
  }

  if (!b) {
    h += `<section class="status idle">
      <div class="status-place">Die Uhr steht</div>
      <div class="status-big" id="live-today">${M.fmtDur(todayMs)}</div>
      <div class="status-sub">Stunden heute gearbeitet (ohne Pausen)</div>
    </section>`;
  } else {
    const st = M.stateOf(b);
    const last = M.lastEvent(b);
    const sub = st === 'running' ? `Uhr läuft · Start ${fmtWhen(M.blockStart(b), t)}` : `Pause seit ${fmtWhen(last.ts, t)}`;
    h += `<section class="status place-${b.place} ${st}">
      <div class="status-place">${placeLabel(b.place)}</div>
      <div class="status-big" id="live-net">${M.fmtDur(M.netMs(b, t))}</div>
      <div class="status-sub">${st === 'paused' ? '⏸ ' : ''}${esc(sub)}</div>
      <div class="status-today">Heute insgesamt: <b id="live-today">${M.fmtDur(todayMs)}</b> Std.</div>
    </section>`;

    // Notiz: beim NaturGut für den aktuellen Abschnitt, sonst für den ganzen Block
    const work = M.segments(b, t).filter((s) => s.kind === 'work');
    const seg = M.isDetailed(b.place) ? work[work.length - 1] : work[0];
    const inherited = seg.ownNote ? '' : seg.note;
    const label =
      M.isDetailed(b.place)
        ? work.length > 1
          ? `Notiz für den Abschnitt ab ${M.fmtTime(seg.from)} Uhr`
          : 'Notiz für den Monatsbericht'
        : 'Notiz (Stichworte)';
    const chips = seg.ownNote || inherited ? [] : recentNotes(b.place, b.id);
    h += `<section class="card">
      <label class="label">Kategorie</label>
      ${catChips(b)}
      <label class="label">${label}</label>
      ${noteField(b, seg.idx, seg.ownNote, inherited ? `wie davor: ${inherited}` : 'z. B. Kurskonzept überarbeitet')}
      ${chips.length ? `<span class="muted small">Oft geschriebene Notizen zum Antippen:</span><div class="chips">${chips.map((n) => `<button class="chip" data-act="noteChip" data-id="${b.id}" data-idx="${seg.idx}" data-note="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
    </section>`;
  }

  const d0 = M.startOfDay(t);
  const d1 = M.addDays(d0, 1);
  const list = state.blocks
    .filter((x) => (M.blockStart(x) >= d0 && M.blockStart(x) < d1) || M.netMs(x, t, d0, d1) > 0)
    .sort((a, c) => M.blockStart(c) - M.blockStart(a));
  h += `<section class="list-section"><h2>Heute, ${M.fmtDate(t)}</h2>${
    list.length ? list.map((x) => blockItem(x, t)).join('') : '<p class="muted empty">Heute ist noch nichts erfasst.</p>'
  }</section>`;

  let bar;
  if (!b) bar = `<button class="btn big go" data-act="start">▶ Start</button>`;
  else if (M.stateOf(b) === 'running') bar = `<button class="btn big wait" data-act="pause">⏸ Pause</button><button class="btn big stop" data-act="stopp">■ Stopp</button>`;
  else bar = `<button class="btn big go" data-act="weiter">▶ Weiter</button><button class="btn big stop" data-act="stopp">■ Stopp</button>`;
  h += `<div class="actionbar">${bar}</div>`;
  return h;
}

// ---------- Bildschirm: einzelner Arbeitsblock mit Protokoll ----------

function viewDetail(b) {
  const t = now();
  const st = M.stateOf(b);
  const d0 = M.dayKey(M.blockStart(b));
  const p = M.pauseMs(b, t);
  const rows = b.events
    .map(
      (e, i) => `<button class="ev ev-${e.t}" data-act="evEdit" data-idx="${i}">
        <span class="ev-name">${M.LABEL[e.t]}</span>
        <span class="ev-time">${M.dayKey(e.ts) !== d0 ? `${M.fmtDateShort(e.ts)} ` : ''}${M.fmtTime(e.ts)}</span>
        <span class="ev-edit">ändern ›</span>
      </button>`
    )
    .join('');
  const stateLine = st === 'done' ? '' : `<p class="muted open-line">${st === 'running' ? 'Die Uhr läuft noch.' : 'Gerade ist Pause.'}</p>`;

  const work = M.segments(b, t).filter((s) => s.kind === 'work');
  let notes;
  if (M.isDetailed(b.place) && work.length > 1) {
    notes = work
      .map((s, i) => {
        const prev = i > 0 ? work[i - 1].note : '';
        return `<label class="label">${M.fmtTime(s.from)}–${s.open ? 'jetzt' : M.fmtTime(s.to)} Uhr</label>${noteField(b, s.idx, s.ownNote, prev ? `wie davor: ${prev}` : 'Stichworte')}`;
      })
      .join('');
  } else {
    notes = noteField(b, 0, work[0].ownNote, 'Stichworte, z. B. Kurskonzept überarbeitet');
  }

  return `<button class="back" data-act="back">‹ Zurück</button>
  <section class="card place-${b.place}">
    <div class="detail-head"><span class="dot"></span><div>
      <div class="detail-title">${placeLabel(b.place)}</div>
      <div class="muted">${M.fmtDate(M.blockStart(b))}</div>
    </div></div>
    <div class="detail-sum"><b>${M.fmtDur(M.netMs(b, t))}</b> Std. netto${p > 0 ? ` <span class="muted">· Pausen ${M.fmtDur(p)}</span>` : ''}</div>
  </section>
  <section class="card">
    <h2>Protokoll</h2>
    <p class="muted small">Tippe auf eine Zeile, um die Uhrzeit zu ändern.</p>
    <div class="events">${rows}</div>
    ${stateLine}
    <div class="row-btns">
      <button class="btn small" data-act="addPause">＋ Pause nachtragen</button>
      ${st !== 'done' ? `<button class="btn small" data-act="addEnd">Ende eintragen</button>` : ''}
    </div>
  </section>
  <section class="card">
    <h2>Kategorie</h2>
    ${catChips(b)}
  </section>
  <section class="card">
    <h2>${M.isDetailed(b.place) ? 'Notizen für den Monatsbericht' : 'Notiz'}</h2>
    ${notes}
    <p class="muted small">Wird beim Tippen sofort gespeichert.</p>
  </section>
  <section class="card">
    <h2>Arbeitsort</h2>
    <div class="place-chips">${choosablePlaces(b.place).map(({ id }) => `<button class="chip place-${id} ${id === b.place ? 'on' : ''}" data-act="setPlace" data-place="${id}">${placeLabel(id)}</button>`).join('')}</div>
  </section>
  <button class="btn danger-ghost" data-act="delAsk">Diesen Arbeitsblock löschen</button>`;
}

// ---------- Bildschirm: Verlauf ----------

function viewHistory() {
  const t = now();
  const { y, m } = ui.histMonth;
  const from = new Date(y, m, 1).getTime();
  const to = new Date(y, m + 1, 1).getTime();
  const list = state.blocks.filter((b) => M.blockStart(b) >= from && M.blockStart(b) < to).sort((a, b) => M.blockStart(b) - M.blockStart(a));
  const days = [];
  for (const b of list) {
    const k = M.dayKey(M.blockStart(b));
    let day = days[days.length - 1];
    if (!day || day.key !== k) {
      day = { key: k, ts: M.blockStart(b), blocks: [], ms: 0 };
      days.push(day);
    }
    day.blocks.push(b);
    day.ms += M.netMs(b, t);
  }
  const total = days.reduce((s, d) => s + d.ms, 0);
  return `${monthSwitch('hist', ui.histMonth)}
  <section class="summary"><span>Gearbeitet in diesem Monat</span><b>${M.fmtDur(total)} Std.</b></section>
  <button class="btn" data-act="newManual">＋ Arbeitsblock nachtragen</button>
  ${
    days.length
      ? days
          .map(
            (d) => `<section class="list-section"><h2><span>${M.fmtDate(d.ts)}</span><span class="day-sum">${M.fmtDur(d.ms)}</span></h2>${d.blocks.map((b) => blockItem(b, t)).join('')}</section>`
          )
          .join('')
      : '<p class="muted empty">In diesem Monat ist nichts erfasst.</p>'
  }`;
}

// ---------- Bildschirm: Berichte ----------

const repPeriod = () => period(ui.rep.kind, ui.rep.anchor, { from: ui.rep.from, to: ui.rep.to });

function currentReport() {
  return buildReport(state.blocks, repPeriod(), ui.rep.place, now(), { place: placeName, user: state.settings.userName });
}

let shareOk = null;
function canShareFiles() {
  if (shareOk === null) {
    try {
      shareOk = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'test.pdf', { type: 'application/pdf' })] }));
    } catch (e) {
      shareOk = false;
    }
  }
  return shareOk;
}

// Auswahl von Zeitraum und Arbeitsort
function repControls(per) {
  const r = ui.rep;
  const t = now();
  const kinds = PERIOD_KINDS.map(([k, label]) => `<button class="chip ${k === r.kind ? 'on' : ''}" data-act="repKind" data-kind="${k}">${label}</button>`).join('');
  const range =
    r.kind === 'frei'
      ? `<div class="field-row">
          <label class="label">Von<input type="date" data-change="repDate" data-key="from" value="${esc(r.from)}"></label>
          <label class="label">Bis<input type="date" data-change="repDate" data-key="to" value="${esc(r.to)}"></label>
        </div>`
      : `<div class="month-switch">
          <button class="icon-btn" data-act="repShift" data-d="-1" aria-label="Zurück blättern">‹</button>
          <strong>${esc(per.label)}</strong>
          <button class="icon-btn" data-act="repShift" data-d="1" aria-label="Vor blättern">›</button>
        </div>
        ${t < per.from || t >= per.to ? '<button class="btn small ghost today-btn" data-act="repNow">Zurück zu heute</button>' : ''}`;
  const places = `<button class="chip place-all ${r.place === 'all' ? 'on' : ''}" data-act="repPlace" data-place="all">Alle zusammen</button>${choosablePlaces(r.place).map(
    ({ id }) => `<button class="chip place-${id} ${id === r.place ? 'on' : ''}" data-act="repPlace" data-place="${id}">${placeLabel(id)}</button>`
  ).join('')}`;
  return `<div class="chips kinds">${kinds}</div>${range}<div class="place-chips">${places}</div>`;
}

const share100 = (ms, total) => (total > 0 ? Math.round((ms / total) * 100) : 0);

// Waagerechte Balken: ein Balken pro Arbeitsort oder Kategorie, der größte zuerst
function barList(items, total, byPlace) {
  const max = Math.max(1, ...items.map((it) => it.ms));
  return `<div class="bars">${items
    .map(
      (it) => `<div class="bar-row ${byPlace ? `place-${it.id}` : ''}">
        <div class="bar-head">${byPlace ? '<span class="dot"></span>' : ''}<span class="bar-name">${esc(it.name)}</span><span class="bar-val"><b>${M.fmtDur(it.ms)}</b> Std. · ${share100(it.ms, total)} %</span></div>
        <div class="bar-line"><span class="bar-fill" style="width:${((it.ms / max) * 100).toFixed(1)}%"></span></div>
      </div>`
    )
    .join('')}</div>`;
}

const NICE_HOURS = [1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100, 120, 160, 200, 300, 400, 600, 800];

// Säulen über die Zeit: pro Tag, Woche oder Monat, bei "Alle" nach Arbeitsort gestapelt
function columnChart(rep) {
  const s = rep.series;
  if (s.length < 2 || rep.totalMs <= 0) return '';
  const maxH = Math.max(...s.map((c) => c.ms)) / M.HOUR;
  const top = NICE_HOURS.find((n) => n >= maxH) || Math.ceil(maxH / 100) * 100;
  // Krankentage je Säule (nur wenn sie angezeigt werden sollen)
  let anySick = false;
  for (const c of s) {
    c.sick = showSick() ? sickCount(c.from, c.to).all : 0;
    if (c.sick) anySick = true;
  }
  const cols = s
    .map((c, i) => {
      const ids = rep.all ? M.placeIds().filter((id) => c.parts[id] > 0) : c.ms > 0 ? [rep.place] : [];
      const segs = ids.map((id) => `<span class="col-seg place-${id}" style="flex-grow:${Math.round((rep.all ? c.parts[id] : c.ms) / M.MIN)}"></span>`).join('');
      const tip = `${c.full}: ${M.fmtDur(c.ms)} Std.${c.sick ? `, ${nDays(c.sick)} krank markiert` : ''}`;
      return `<button class="col" data-act="colInfo" data-i="${i}" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="col-stack" style="height:${((c.ms / (top * M.HOUR)) * 100).toFixed(1)}%">${segs}</span></button>`;
    })
    .join('');
  const labels = s.map((c) => `<span class="${c.sick ? 'sick' : ''}">${esc(c.label)}</span>`).join('');
  const legendItems = [];
  if (rep.all && rep.byPlace.length > 1) {
    for (const id of M.placeIds().filter((x) => rep.byPlace.some((p) => p.id === x))) {
      legendItems.push(`<span class="place-${id}"><span class="dot"></span> ${esc(placeName(id))}</span>`);
    }
  }
  if (anySick) legendItems.push('<span><span class="dot sick-dot"></span> krank markiert</span>');
  const legend = legendItems.length ? `<div class="legend">${legendItems.join('')}</div>` : '';
  const half = String(top / 2).replace('.', ',');
  return `<section class="card">
    <h2>Stunden pro ${rep.seriesUnit}</h2>
    ${legend}
    <div class="colchart">
      <div class="plot">
        <div class="grid-line" style="bottom:100%"><span>${top}</span></div>
        <div class="grid-line" style="bottom:50%"><span>${half}</span></div>
        <div class="grid-line base" style="bottom:0"><span>0</span></div>
        <div class="cols">${cols}</div>
      </div>
      <div class="col-labels ${anySick ? 'has-sick' : ''}">${labels}</div>
    </div>
    <p class="muted small" id="col-info">Tippe auf eine Säule, um die genaue Zeit zu sehen.</p>
  </section>`;
}

// Liste der einzelnen Zeiten, so wie sie auch im PDF und in Excel stehen
function reportTable(rep) {
  const rows = rep.rows
    .map((r) => {
      const open = `data-act="openDetail" data-id="${r.id}"`;
      if (r.type === 'work') {
        return `<tr class="${r.first ? 'first' : ''}" ${open}><td>${esc(r.date)}</td><td>${M.fmtTime(r.from)}</td><td>${M.fmtTime(r.to)}</td><td></td><td class="num">${M.fmtDur(r.ms)}</td></tr>
          <tr class="note-tr" ${open}><td colspan="5">${r.note ? esc(r.note) : '<span class="muted">(keine Notiz)</span>'}</td></tr>`;
      }
      if (r.type === 'pause') {
        return `<tr class="pause-row" ${open}><td></td><td></td><td></td><td>${M.fmtTime(r.from)}–${M.fmtTime(r.to)}</td><td></td></tr>`;
      }
      const what = `${rep.all ? `${placeLabel(r.place)} · ` : ''}${esc(r.category)}`;
      return `<tr class="first" ${open}><td>${esc(r.date)}</td><td>${M.fmtTime(r.from)}</td><td>${M.fmtTime(r.to)}</td><td>${r.pauseMs > 0 ? M.fmtDur(r.pauseMs) : ''}</td><td class="num">${M.fmtDur(r.ms)}</td></tr>
        <tr class="note-tr place-${r.place}" ${open}><td colspan="5"><span class="dot"></span> <b>${what}</b>${r.note ? `<br>${esc(r.note)}` : ''}</td></tr>`;
    })
    .join('');
  return `<h2>Einzelne Zeiten</h2>
  <p class="muted small">Tippe auf eine Zeile, um den Arbeitsblock zu öffnen.</p>
  <div class="table-wrap"><table class="report">
    <thead><tr><th>Datum</th><th>Von</th><th>Bis</th><th>Pause</th><th class="num">Std.</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="4">${esc(rep.period.sumLabel.replace(' (ohne Pausen)', ''))}</td><td class="num">${M.fmtDur(rep.totalMs)}</td></tr></tfoot>
  </table></div>`;
}

const repModeChips = () => `<div class="chips mode-chips">
    <button class="chip ${ui.repMode === 'zeit' ? 'on' : ''}" data-act="repMode" data-mode="zeit">Arbeitszeit</button>
    <button class="chip ${ui.repMode === 'steuer' ? 'on' : ''}" data-act="repMode" data-mode="steuer">Steuer-Tage</button>
    <button class="chip ${ui.repMode === 'krank' ? 'on' : ''}" data-act="repMode" data-mode="krank">Krankentage</button>
  </div>`;

// ---------- Krankentage: von Hand im Kalender markieren ----------

const sickDays = () => state.settings.sickDays || [];
// Sollen die Krankentage auch in den Statistiken zu sehen sein? (Schalter auf den Berichtsseiten)
const showSick = () => state.settings.showSick !== false;
const sickSwitch = () => `<label class="check slim"><input type="checkbox" data-change="showSick" ${showSick() ? 'checked' : ''}><span>Krankentage hier mit anzeigen</span></label>`;
const sickLine = (n) => `<div class="tax-row"><span class="tax-name"><span class="sick-tag">krank</span> Als krank markiert${n.all !== n.work ? `<small>davon ${nDays(n.work)} an Werktagen (Mo–Fr, ohne Feiertage)</small>` : ''}</span><b>${nDays(n.all)}</b></div>`;
const keyToTs = (k) => new Date(`${k}T00:00`).getTime();

// Einen Tag als krank markieren oder die Markierung wegnehmen
function setSick(k, on) {
  const set = new Set(sickDays());
  if (on) set.add(k);
  else set.delete(k);
  state.settings.sickDays = [...set].sort();
  saveSettings();
  const view = $('#view');
  const top = view.scrollTop;
  render();
  view.scrollTop = top;
}

// Zählt die markierten Tage in einem Zeitraum: alle und die an Werktagen (Mo–Fr, ohne Feiertage in NRW)
function sickCount(from, to) {
  let all = 0;
  let work = 0;
  const hol = new Map();
  for (const k of sickDays()) {
    const ts = keyToTs(k);
    if (ts < from || ts >= to) continue;
    all++;
    const y = new Date(ts).getFullYear();
    if (!hol.has(y)) hol.set(y, holidaysNRW(y));
    const wd = new Date(ts).getDay();
    if (wd !== 0 && wd !== 6 && !hol.get(y).has(k)) work++;
  }
  return { all, work };
}

// Aufeinanderfolgende Tage zusammenfassen: "03.11.–05.11.2026 (3 Tage)"
function sickRanges(from, to) {
  const list = sickDays().map(keyToTs).filter((ts) => ts >= from && ts < to).sort((a, b) => a - b);
  const out = [];
  for (const ts of list) {
    const last = out[out.length - 1];
    if (last && M.addDays(last.to, 1) === ts) {
      last.to = ts;
      last.n++;
    } else out.push({ from: ts, to: ts, n: 1 });
  }
  return out;
}

function viewSick() {
  const t = now();
  const { y, m } = ui.sickMonth;
  const sick = new Set(sickDays());
  const hol = holidaysNRW(y);
  const first = new Date(y, m, 1).getTime();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const todayKey = M.dayKey(t);

  let cells = '<span></span>'.repeat(offset);
  for (let d = 1; d <= daysInMonth; d++) {
    const ts = M.addDays(first, d - 1);
    const k = M.dayKey(ts);
    const wd = new Date(ts).getDay();
    const isSick = sick.has(k);
    const worked = sumRange(t, ts, M.addDays(ts, 1)) > 0;
    const off = wd === 0 || wd === 6 || hol.has(k);
    const label = `${M.fmtDate(ts)}${hol.has(k) ? `, ${hol.get(k)}` : ''}${isSick ? ', als krank markiert' : ''}${worked ? ', Arbeitszeit erfasst' : ''}`;
    cells += `<button class="cal-day ${isSick ? 'sick' : ''} ${off ? 'off' : ''} ${k === todayKey ? 'today' : ''}" data-act="sickToggle" data-day="${k}" aria-pressed="${isSick}" aria-label="${esc(label)}" title="${esc(label)}">
      <span class="cal-num">${d}</span><span class="cal-mark">${isSick ? 'krank' : worked ? '●' : ''}</span></button>`;
  }

  const yearFrom = new Date(y, 0, 1).getTime();
  const yearTo = new Date(y + 1, 0, 1).getTime();
  const cy = sickCount(yearFrom, yearTo);
  const sjPer = period('schuljahr', first);
  const sj = sickCount(sjPer.from, sjPer.to);
  const ranges = sickRanges(yearFrom, yearTo);
  const dm = (ts) => `${M.pad(new Date(ts).getDate())}.${M.pad(new Date(ts).getMonth() + 1)}.`;

  return `<h2 class="page-title">Berichte</h2>
  ${repModeChips()}
  <p class="muted small">Tippe auf einen Tag, um ihn als krank zu markieren. Noch einmal tippen nimmt die Markierung wieder weg. Es wird sofort gespeichert.</p>
  <section class="card">
    <div class="month-switch">
      <button class="icon-btn" data-act="sickMonth" data-d="-1" aria-label="Monat zurück">‹</button>
      <strong>${M.MONTHS[m]} ${y}</strong>
      <button class="icon-btn" data-act="sickMonth" data-d="1" aria-label="Monat vor">›</button>
    </div>
    <div class="cal cal-head">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal">${cells}</div>
    <p class="muted small">● = an dem Tag ist Arbeitszeit erfasst. Wochenenden und Feiertage sind blasser.</p>
  </section>
  <section class="card"><h2>Gezählt</h2>
    <div class="tax-row"><span class="tax-name">Kalenderjahr ${y}${cy.all !== cy.work ? `<small>davon ${nDays(cy.work)} an Werktagen (Mo–Fr, ohne Feiertage)</small>` : ''}</span><b>${nDays(cy.all)}</b></div>
    <div class="tax-row"><span class="tax-name">${esc(sjPer.label)}${sj.all !== sj.work ? `<small>davon ${nDays(sj.work)} an Werktagen (Mo–Fr, ohne Feiertage)</small>` : ''}</span><b>${nDays(sj.all)}</b></div>
  </section>
  ${
    ranges.length
      ? `<section class="card"><h2>Krankentage ${y}</h2>${ranges
          .map((r) => `<div class="tax-row"><span class="tax-name">${r.n === 1 ? M.fmtDate(r.from) : `${dm(r.from)}–${dm(r.to)}${new Date(r.to).getFullYear()}`}</span><b>${nDays(r.n)}</b></div>`)
          .join('')}</section>`
      : ''
  }`;
}

const nDays = (n) => `${n} ${n === 1 ? 'Tag' : 'Tage'}`;

// Übersicht für die Steuererklärung: an wie vielen Tagen wurde an welchem Ort gearbeitet?
function viewTax() {
  const t = now();
  const per = period(ui.taxKind, ui.taxAnchor);
  const tax = taxReport(state.blocks, per, t, M.placeOf);
  const order = M.placeIds();
  const places = [...tax.places].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const homeNames = M.allPlaces().filter((p) => p.home).map((p) => p.name);
  const sick = new Set(showSick() ? sickDays() : []);
  const sickN = showSick() ? sickCount(per.from, per.to) : { all: 0, work: 0 };

  const head = `<h2 class="page-title">Berichte</h2>
  ${repModeChips()}
  <div class="chips">
    <button class="chip ${ui.taxKind === 'jahr' ? 'on' : ''}" data-act="taxKind" data-kind="jahr">Kalenderjahr</button>
    <button class="chip ${ui.taxKind === 'schuljahr' ? 'on' : ''}" data-act="taxKind" data-kind="schuljahr">Schuljahr</button>
  </div>
  <div class="month-switch">
    <button class="icon-btn" data-act="taxShift" data-d="-1" aria-label="Ein Jahr zurück">‹</button>
    <strong>${esc(per.label)}</strong>
    <button class="icon-btn" data-act="taxShift" data-d="1" aria-label="Ein Jahr vor">›</button>
  </div>
  ${sickSwitch()}`;

  if (!tax.totalDays) {
    return `${head}${sickN.all ? `<section class="card">${sickLine(sickN)}</section>` : ''}
    <p class="muted empty">Für diesen Zeitraum (${esc(per.label)}) gibt es noch keine erfassten Zeiten.</p>`;
  }

  const rows = places
    .map((p) => {
      const sub = [];
      if (p.offDays) sub.push(`davon ${nDays(p.offDays)} am Wochenende oder Feiertag`);
      return `<div class="tax-row place-${p.id}">
        <span class="dot"></span>
        <span class="tax-name">${M.placeOf(p.id).icon} ${esc(p.name)}${sub.length ? `<small>${sub.join(' · ')}</small>` : ''}</span>
        <b>${nDays(p.days)}</b>
      </div>`;
    })
    .join('');

  // Welche Orte kamen am selben Tag zusammen vor? (Hilft beim Zählen der Wege: zwei Orte an einem Tag)
  const comboCount = new Map();
  for (const m of tax.months) {
    for (const d of m.days) {
      if (!d.places.length) continue;
      const ids = [...d.places].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const key = ids.join('|');
      if (!comboCount.has(key)) comboCount.set(key, { ids, n: 0 });
      comboCount.get(key).n++;
    }
  }
  const comboList = [...comboCount.values()].sort((a, b) => b.n - a.n);
  const combos = comboList.some((c) => c.ids.length > 1)
    ? `<section class="card"><h2>So verteilen sich die Tage</h2>
        ${comboList
          .map(
            (c) => `<div class="tax-row"><span class="tax-name">${c.ids.length === 1 ? 'Nur ' : ''}${c.ids.map((id) => `${M.placeOf(id).icon} ${esc(placeName(id))}`).join(' + ')}</span><b>${nDays(c.n)}</b></div>`
          )
          .join('')}
        <p class="muted small">Hier zählt jeder Tag genau einmal. Du siehst, an wie vielen Tagen du nur an einem Ort warst und an wie vielen an mehreren.</p>
      </section>`
    : '';

  const home = homeNames.length
    ? `<section class="card"><h2>Zu Hause gearbeitet</h2>
        <div class="tax-row"><span class="tax-name">Nur zu Hause gearbeitet</span><b>${nDays(tax.homeOnly)}</b></div>
        <div class="tax-row"><span class="tax-name">Zu Hause und am selben Tag an einem anderen Ort</span><b>${nDays(tax.homeMixed)}</b></div>
        <p class="muted small">Als „zu Hause“ zählt: ${esc(homeNames.join(', '))}. Das lässt sich in den Einstellungen beim Arbeitsort ändern.</p>
      </section>`
    : '';

  const months = tax.months
    .map(
      (m) => `<details class="tax-month"><summary><span>${esc(m.label)}</span><span class="muted">${nDays(m.worked)} mit Arbeit</span></summary>
        ${m.days
          .map((d) => {
            const isSick = sick.has(M.dayKey(d.ts));
            const what = d.places.length
              ? d.places.map((id) => `<span class="place-${id}"><span class="dot"></span> ${esc(placeName(id))}</span>`).join(' ')
              : isSick
                ? '<span class="sick-tag">krank</span>'
                : `<span class="muted">${d.holiday ? esc(d.holiday) : d.weekend ? 'Wochenende' : 'keine Erfassung'}</span>`;
            const extra = `${d.places.length && d.holiday ? ` <span class="muted">(${esc(d.holiday)})</span>` : ''}${d.places.length && isSick ? ' <span class="sick-tag">krank</span>' : ''}`;
            return `<div class="tax-day ${d.places.length ? '' : 'none'} ${d.weekend || d.holiday ? 'off' : ''}"><span class="tax-date">${M.fmtDateShort(d.ts)}</span><span>${what}${extra}</span></div>`;
          })
          .join('')}
      </details>`
    )
    .join('');

  return `${head}
  <p class="note-box">Gezählt wird jeder Tag, an dem du an dem Ort Arbeitszeit erfasst hast. Tage ohne Erfassung zählen nicht mit, also auch keine freien Wochenenden, Feiertage und Ferientage. Die App zählt nur. Was du in der Steuererklärung angibst, entscheidest du.</p>
  <section class="summary"><span>Tage mit erfasster Arbeit</span><b>${nDays(tax.totalDays)}</b></section>
  <section class="card"><h2>Tage je Arbeitsort</h2>${rows}
    <p class="muted small">Hast du an einem Tag an zwei Orten gearbeitet, zählt der Tag bei beiden Orten. Oben bei „Tage mit erfasster Arbeit“ zählt er nur einmal. Deshalb kann die Summe der Orte größer sein als die Zahl oben.</p></section>
  ${combos}
  ${home}
  ${
    sickN.all
      ? `<section class="card"><h2>Krankentage</h2>${sickLine(sickN)}</section>`
      : ''
  }
  <section class="card"><h2>Alle Tage im Überblick</h2>
    <p class="muted small">Tippe auf einen Monat, um die einzelnen Tage zu sehen.</p>
    ${months}</section>`;
}

function viewReport() {
  if (ui.repMode === 'steuer') return viewTax();
  if (ui.repMode === 'krank') return viewSick();
  const rep = currentReport();
  lastRep = rep;
  const share = canShareFiles();
  const exportBtns = (kind, label) => `<div class="export-row"><span>${label}</span>
    <button class="btn small" data-act="exp" data-kind="${kind}" data-mode="save">Herunterladen</button>
    ${share ? `<button class="btn small" data-act="exp" data-kind="${kind}" data-mode="share">Teilen</button>` : ''}</div>`;
  const where = rep.all ? '' : ` am Arbeitsort „${esc(rep.placeName)}“`;
  const sickN = showSick() ? sickCount(rep.period.from, rep.period.to) : { all: 0, work: 0 };
  const sickCard = sickN.all ? `<section class="card">${sickLine(sickN)}</section>` : '';

  let body;
  if (!rep.rows.length) {
    body = `${sickCard}<p class="muted empty">Für diesen Zeitraum (${esc(rep.label)}) gibt es noch keine Zeiten${where}.</p>`;
  } else {
    body = `<section class="summary"><span>${esc(rep.period.sumLabel.replace(' (ohne Pausen)', ''))}${rep.all ? '' : `<br><small>${esc(rep.placeName)}</small>`}</span><b>${M.fmtDur(rep.totalMs)} Std.</b></section>
    ${sickCard}
    ${
      rep.all
        ? `<section class="card"><h2>Nach Arbeitsort</h2>
            <div class="split">${rep.byPlace.map((p) => `<span class="place-${p.id}" style="flex-grow:${Math.round(p.ms / M.MIN)}"></span>`).join('')}</div>
            ${barList(rep.byPlace, rep.totalMs, true)}</section>`
        : ''
    }
    <section class="card"><h2>Nach Kategorie</h2>${barList(rep.byCategory, rep.totalMs, false)}</section>
    ${columnChart(rep)}
    <section class="card"><h2>Diesen Bericht speichern</h2>${exportBtns('pdf', 'PDF')}${exportBtns('xlsx', 'Excel')}
      ${!rep.userName ? '<p class="muted small">Dein Name fehlt noch in der Kopfzeile. Du kannst ihn unter „Einstellungen“ eintragen.</p>' : ''}</section>
    ${reportTable(rep)}`;
  }

  return `<h2 class="page-title">Berichte</h2>
  ${repModeChips()}
  ${repControls(rep.period)}
  ${sickSwitch()}
  ${rep.openCount ? `<p class="note-box">Ein Arbeitsblock läuft noch. Er ist bis jetzt (${M.fmtTime(now())} Uhr) mitgezählt.</p>` : ''}
  ${body}`;
}

// ---------- Bildschirm: Einstellungen ----------

const placeRow = (p) => `<button class="item place-${p.id} ${p.hidden ? 'is-hidden' : ''}" data-act="placeEdit" data-id="${p.id}">
    <span class="item-main">
      <span class="item-title">${p.icon} ${esc(p.name)}</span>
      <span class="item-sub">${p.categories.length} ${p.categories.length === 1 ? 'Kategorie' : 'Kategorien'}${p.detailed ? ' · ausführlicher Bericht' : ''}</span>
    </span>
    <span class="ev-edit">ändern ›</span>
  </button>`;

function viewSettings() {
  const s = state.settings;
  return `<h2 class="page-title">Einstellungen</h2>
  <p class="muted small">Alles, was du hier änderst, wird sofort gespeichert. Einen Speichern-Knopf braucht es nicht.</p>
  <section class="card">
    <label class="label" for="set-name">Dein Name (steht in den Berichten)</label>
    <input id="set-name" type="text" data-input="set" data-key="userName" value="${esc(s.userName)}" autocomplete="name" placeholder="Vorname Nachname">
  </section>
  <section class="card">
    <h2>Arbeitsorte und Kategorien</h2>
    <p class="muted small">Tippe auf einen Arbeitsort, um Namen, Farbe und Kategorien zu ändern.</p>
    ${M.visiblePlaces().map(placeRow).join('')}
    <button class="btn" data-act="placeAdd">＋ Arbeitsort hinzufügen</button>
    ${
      M.allPlaces().some((p) => p.hidden)
        ? `<h2 class="sub">Archiv</h2>
           <p class="muted small">Diese Arbeitsorte werden nicht mehr zur Auswahl angeboten. Ihre Zeiten stehen weiter in den Berichten.</p>
           ${M.allPlaces().filter((p) => p.hidden).map(placeRow).join('')}`
        : ''
    }
  </section>
  <section class="card">
    <h2>Datensicherung</h2>
    <p class="muted small">Deine Zeiten liegen nur auf diesem Handy. Eine Sicherung schützt sie, falls das Handy kaputtgeht, verloren geht oder die App gelöscht wird. Bewahre die Datei außerhalb des Handys auf, zum Beispiel in Google Drive oder als E-Mail an dich selbst.</p>
    <p>${lastBackupText()}</p>
    ${backupBtns()}
    <label class="label">Beim Öffnen an die Sicherung erinnern</label>
    <div class="chips mode-chips">${[
      ['woche', 'Jede Woche'],
      ['monat', 'Jeden Monat'],
    ]
      .map(([k, label]) => `<button class="chip ${(s.backupEvery || 'monat') === k ? 'on' : ''}" data-act="setBackupEvery" data-every="${k}">${label}</button>`)
      .join('')}</div>
    <h2 class="sub">Sicherung einlesen</h2>
    <p class="muted small">Zum Beispiel auf einem neuen Handy. Wähle die Sicherungsdatei aus. Die App zeigt dir dann, was darin ist, und fragt nach, bevor sich etwas ändert.</p>
    <button class="btn" data-act="restorePick">📂 Sicherung einlesen</button>
  </section>
  <section class="card">
    <h2>Darstellung</h2>
    <div class="chips mode-chips">${[
      ['auto', '📱 Auto'],
      ['light', '☀️ Hell'],
      ['dark', '🌙 Dunkel'],
    ]
      .map(([k, label]) => `<button class="chip ${(s.theme || 'auto') === k ? 'on' : ''}" data-act="setTheme" data-theme="${k}">${label}</button>`)
      .join('')}</div>
    <p class="muted small">„Hell“ heißt heller Hintergrund mit dunkler Schrift, „Dunkel“ das Gegenteil. „Auto“ richtet sich nach dem Tag- oder Nachtmodus deines Handys.</p>
  </section>
  <section class="card">
    <h2>Hinweise beim Öffnen</h2>
    <label class="label" for="set-run">Nachfragen, wenn die Uhr länger ohne Pause läuft als (Stunden)</label>
    <input id="set-run" type="number" inputmode="numeric" min="1" max="48" data-input="set" data-key="warnRunHours" value="${s.warnRunHours}">
    <label class="label" for="set-pause">Nachfragen, wenn eine Pause länger dauert als (Stunden)</label>
    <input id="set-pause" type="number" inputmode="numeric" min="1" max="48" data-input="set" data-key="warnPauseHours" value="${s.warnPauseHours}">
    <p class="muted small">Bei Klassenfahrten gibt es diese Hinweise nicht.</p>
  </section>
  <p class="muted small center">Work Time Tracker · Version ${VERSION}<br>Alle Daten liegen nur auf diesem Gerät.</p>
  <button class="btn ghost" data-act="checkVersion">🔄 Nach neuer Fassung suchen</button>`;
}

// ---------- Anzeige aufbauen ----------

function render() {
  const view = $('#view');
  let detail = ui.detailId ? byId(ui.detailId) : null;
  if (ui.detailId && !detail) ui.detailId = null;
  document.body.classList.toggle('in-detail', !!detail);
  if (detail) view.innerHTML = viewDetail(detail);
  else view.innerHTML = { home: viewHome, hist: viewHistory, rep: viewReport, set: viewSettings }[ui.tab]();
  document.querySelectorAll('.nav button').forEach((n) => n.classList.toggle('on', n.dataset.tab === ui.tab));
}

// Laufende Zeiten aktualisieren, ohne den Bildschirm neu aufzubauen
function tick() {
  if (ui.detailId || ui.tab !== 'home') return;
  const t = now();
  const b = openBlock();
  const net = $('#live-net');
  if (net && b) net.textContent = M.fmtDur(M.netMs(b, t));
  const td = $('#live-today');
  if (td) td.textContent = M.fmtDur(sumToday(t));
}

// ---------- Fenster von unten (für Auswahl und Eingaben) ----------

function openSheet(html, meta) {
  ui.sheet = meta || { type: 'plain' };
  $('#sheet').innerHTML = html;
  $('#backdrop').hidden = false;
  $('#sheet').scrollTop = 0;
  history.pushState({ layer: 'sheet' }, '');
}

function hideSheet() {
  ui.sheet = null;
  $('#backdrop').hidden = true;
  $('#sheet').innerHTML = '';
  // Eine neue Fassung wartet, bis das Fenster zu ist
  if (reloadPending) setTimeout(reloadNow, 400);
}

function closeSheet() {
  if (!ui.sheet) return;
  hideSheet();
  skipPop++;
  history.back();
}

function sheetErr(msg) {
  const el = $('#sheet-err');
  if (el) {
    el.textContent = msg;
    el.hidden = false;
    el.scrollIntoView({ block: 'nearest' });
  }
}

const ERR = '<p class="error" id="sheet-err" hidden></p>';
const CANCEL = '<button class="btn ghost" data-act="closeSheet">Abbrechen</button>';

// Erster Start: Es gibt noch keinen Arbeitsort. Vorlagen zum Antippen oder ein eigener Ort.
function starterHtml() {
  const have = M.placeIds();
  const tpl = M.placeTemplates().filter((p) => !have.includes(p.id));
  return `<p>${
    have.length
      ? 'Du kannst weitere Vorlagen antippen oder einen eigenen Ort anlegen. Später geht das jederzeit unter „Einstellungen“.'
      : 'Lege zuerst deine Arbeitsorte an. Du kannst eine Vorlage antippen oder einen eigenen Ort anlegen. Namen, Farben und Kategorien lassen sich später jederzeit unter „Einstellungen“ ändern.'
  }</p>
    ${tpl.map((p) => `<button class="btn" data-act="tplAdd" data-id="${p.id}">${p.icon} ${esc(p.name)} anlegen</button>`).join('')}
    <button class="btn" data-act="tplOwn">＋ Eigenen Arbeitsort anlegen</button>`;
}

// Inhalt des offenen Fensters austauschen, ohne es zu schließen und neu zu öffnen
function swapSheet(html, meta) {
  ui.sheet = meta || { type: 'plain' };
  $('#sheet').innerHTML = html;
  $('#sheet').scrollTop = 0;
}

// swap = true: Es ist schon ein Fenster offen, dessen Inhalt ersetzt wird.
function sheetPlaces(swap) {
  const show = swap ? swapSheet : openSheet;
  if (!M.visiblePlaces().length) {
    return show(`<h2>Noch kein Arbeitsort</h2>${starterHtml()}${CANCEL}`);
  }
  show(
    `<h2>Wo arbeitest du?</h2>
    <div class="place-grid">${M.visiblePlaces().map((p) => `<button class="place-btn place-${p.id}" data-act="pickPlace" data-place="${p.id}"><span class="place-icon">${p.icon}</span>${esc(p.name)}</button>`).join('')}</div>
    ${CANCEL}`
  );
}

function dtFields(prefix, ts) {
  return `<div class="field-row">
    <label class="label">Tag<input type="date" id="${prefix}-date" value="${M.dayKey(ts)}"></label>
    <label class="label">Uhrzeit<input type="time" id="${prefix}-time" value="${M.fmtTime(ts)}"></label>
  </div>
  <div class="quick">${[-15, -5, 5, 15].map((n) => `<button class="chip" data-act="shift" data-prefix="${prefix}" data-min="${n}">${n > 0 ? '+' : '−'}${Math.abs(n)} Min.</button>`).join('')}</div>`;
}
const readDT = (prefix) => M.combine($(`#${prefix}-date`).value, $(`#${prefix}-time`).value);

function sheetEvent(b, idx) {
  const e = b.events[idx];
  let extra = '';
  if (e.t === 'pause' || e.t === 'weiter') extra = `<button class="btn danger-ghost" data-act="pauseDel">Diese Pause löschen</button>`;
  if (e.t === 'stopp' && !openBlock()) extra = `<button class="btn danger-ghost" data-act="stoppDel">Stopp entfernen (die Uhr läuft dann wieder)</button>`;
  openSheet(
    `<h2>${M.LABEL[e.t]} ändern</h2>
    ${dtFields('ev', e.ts)}
    ${ERR}
    <button class="btn primary" data-act="evSave">Speichern</button>
    ${extra}
    ${CANCEL}`,
    { type: 'event', id: b.id, idx }
  );
}

function sheetAddPause(b) {
  const t = now();
  const d = M.dayKey(M.blockStart(b));
  const noon = M.combine(d, '12:00');
  const fits = M.segments(b, t).some((s) => s.kind === 'work' && s.from <= noon && noon + 30 * M.MIN <= s.to);
  openSheet(
    `<h2>Pause nachtragen</h2>
    <div class="field-row">
      <label class="label">Von<input type="time" id="p-von" value="${fits ? '12:00' : ''}"></label>
      <label class="label">Bis<input type="time" id="p-bis" value="${fits ? '12:30' : ''}"></label>
    </div>
    ${ERR}
    <button class="btn primary" data-act="addPauseSave">Pause eintragen</button>
    ${CANCEL}`,
    { type: 'addPause', id: b.id }
  );
}

function sheetAddEnd(b) {
  const last = M.lastEvent(b);
  openSheet(
    `<h2>Wann hast du aufgehört?</h2>
    <p class="muted">Letzter Eintrag: ${M.LABEL[last.t]} am ${M.fmtDate(last.ts)} um ${M.fmtTime(last.ts)} Uhr.</p>
    ${dtFields('end', last.ts)}
    ${ERR}
    <button class="btn primary" data-act="addEndSave">Ende speichern</button>
    ${CANCEL}`,
    { type: 'addEnd', id: b.id }
  );
}

function sheetManual() {
  if (!M.visiblePlaces().length) return sheetPlaces();
  const t = now();
  const sameMonth = ui.histMonth.y === new Date(t).getFullYear() && ui.histMonth.m === new Date(t).getMonth();
  const day = sameMonth ? M.dayKey(t) : M.dayKey(new Date(ui.histMonth.y, ui.histMonth.m, 1).getTime());
  openSheet(
    `<h2>Arbeitsblock nachtragen</h2>
    <label class="label">Arbeitsort</label>
    <div class="place-chips" id="m-places">${M.visiblePlaces().map(({ id }, i) => `<button class="chip place-${id} ${i === 0 ? 'on' : ''}" data-act="manualPlace" data-place="${id}">${placeLabel(id)}</button>`).join('')}</div>
    <label class="label">Tag<input type="date" id="m-date" value="${day}"></label>
    <div class="field-row">
      <label class="label">Beginn<input type="time" id="m-von"></label>
      <label class="label">Ende<input type="time" id="m-bis"></label>
    </div>
    <div class="field-row">
      <label class="label">Pause von <span class="muted">(freiwillig)</span><input type="time" id="m-pvon"></label>
      <label class="label">Pause bis<input type="time" id="m-pbis"></label>
    </div>
    <label class="label">Notiz<input type="text" id="m-note" maxlength="200" autocomplete="off" placeholder="Stichworte"></label>
    ${ERR}
    <button class="btn primary" data-act="manualSave">Eintragen</button>
    ${CANCEL}`,
    { type: 'manual', place: M.visiblePlaces()[0].id }
  );
}

// Arbeitsort bearbeiten: Name, Symbol, Farbe, Kategorien, Art des Berichts
// Rückfrage vor dem Entfernen einer Kategorie oder dem Löschen eines Arbeitsorts
function placeConfirmHtml(p, c) {
  const back = '<button class="btn ghost" data-act="confirmNo">Abbrechen</button>';
  if (c.kind === 'cat') {
    const name = p.categories[c.i];
    const n = state.blocks.filter((b) => b.place === p.id && b.category === name).length;
    return `<h2>Kategorie „${esc(name)}“ entfernen?</h2>
      <p>${
        n
          ? `Sie wurde bei <b>${n} ${n === 1 ? 'Arbeitsblock' : 'Arbeitsblöcken'}</b> verwendet. Diese Einträge behalten die Kategorie und erscheinen damit weiter in den Berichten.`
          : 'Sie wurde bisher bei keinem Arbeitsblock verwendet.'
      }</p>
      <p class="muted">Die Kategorie wird nur nicht mehr zur Auswahl angeboten. Du kannst sie jederzeit neu anlegen.</p>
      <button class="btn danger" data-act="catDelYes">Ja, entfernen</button>
      ${back}`;
  }
  const mine = state.blocks.filter((b) => b.place === p.id);
  const t = now();
  if (mine.some((b) => M.stateOf(b) !== 'done')) {
    return `<h2>Löschen geht gerade nicht</h2>
      <p>An diesem Arbeitsort läuft noch die Uhr. Bitte drücke zuerst auf „Stopp“.</p>
      ${back}`;
  }
  if (!mine.length) {
    return `<h2>Arbeitsort „${esc(p.name)}“ löschen?</h2>
      <p>Zu diesem Arbeitsort gibt es keine gespeicherten Zeiten. Es geht also nichts verloren.</p>
      <button class="btn danger" data-act="placeDelYes">Ja, löschen</button>
      ${back}`;
  }
  const ms = mine.reduce((s, b) => s + M.netMs(b, t), 0);
  return `<h2>Achtung: „${esc(p.name)}“ mit allen Zeiten löschen?</h2>
    <p class="note-box">Damit werden auch <b>${mine.length} ${mine.length === 1 ? 'Arbeitsblock' : 'Arbeitsblöcke'} mit zusammen ${M.fmtDur(ms)} Stunden</b> gelöscht. Sie verschwinden aus allen Berichten. Das lässt sich nicht rückgängig machen.</p>
    ${
      !p.hidden && M.visiblePlaces().length > 1
        ? `<p>Wenn du den Ort nur nicht mehr in der Auswahl sehen möchtest, verschiebe ihn besser ins Archiv. Dann bleiben die Zeiten erhalten, und du kannst ihn später zurückholen.</p>
           <button class="btn primary" data-act="placeHide">Lieber ins Archiv verschieben</button>`
        : '<p>Im Archiv bleiben die Zeiten erhalten. Löschen brauchst du nur, wenn die Zeiten wirklich weg sollen.</p>'
    }
    <button class="btn danger" data-act="placeDelYes">Trotzdem alles löschen</button>
    ${back}`;
}

function placeSheetHtml(p) {
  if (ui.sheet && ui.sheet.confirm) return placeConfirmHtml(p, ui.sheet.confirm);
  const visibleCount = M.visiblePlaces().length;
  // Löschen geht nur, wenn danach noch mindestens ein Arbeitsort zur Auswahl steht
  const canDelete = M.visiblePlaces().some((x) => x !== p);
  const cats = p.categories
    .map(
      (c, i) => `<div class="cat-row">
        <input type="text" data-change="catName" data-i="${i}" value="${esc(c)}" maxlength="30" autocomplete="off" aria-label="Name der Kategorie">
        <button class="icon-btn ${i === 0 ? 'star-on' : ''}" data-act="catDefault" data-i="${i}" aria-label="${i === 0 ? 'Ist der Standard' : 'Als Standard festlegen'}">${i === 0 ? '★' : '☆'}</button>
        <button class="icon-btn" data-act="catDel" data-i="${i}" aria-label="Kategorie entfernen">✕</button>
      </div>`
    )
    .join('');
  return `<h2>Arbeitsort bearbeiten</h2>
    <label class="label">Name<input type="text" data-input="placeName" value="${esc(p.name)}" maxlength="40" autocomplete="off"></label>
    <label class="label">Symbol</label>
    <div class="chips">${M.ICONS.map((ic) => `<button class="chip icon-chip ${ic === p.icon ? 'on' : ''}" data-act="placeIcon" data-icon="${ic}">${ic}</button>`).join('')}</div>
    <label class="label">Farbe</label>
    <div class="chips">${M.COLOR_NAMES.map((name, i) => `<button class="swatch ${i === p.color ? 'on' : ''}" style="--pc:var(--c${i})" data-act="placeColor" data-color="${i}" aria-label="${name}" title="${name}"></button>`).join('')}</div>
    <h2 class="sub">Kategorien</h2>
    <p class="muted small">Die Kategorie mit dem Stern ★ ist beim Start automatisch gewählt. Am übersichtlichsten bleibt es mit höchstens 6 bis 8 Kategorien.</p>
    ${cats}
    <div class="cat-row">
      <input type="text" id="cat-new" placeholder="Neue Kategorie" maxlength="30" autocomplete="off" enterkeyhint="done">
      <button class="btn small" data-act="catAdd">Hinzufügen</button>
    </div>
    <h2 class="sub">Bericht</h2>
    <label class="check"><input type="checkbox" data-change="placeFlag" data-key="detailed" ${p.detailed ? 'checked' : ''}>
      <span>Ausführlicher Bericht: Jeder Abschnitt zwischen zwei Pausen bekommt eine eigene Zeile und eine eigene Notiz. Beim Stopp erinnert die App an fehlende Notizen.</span></label>
    <label class="check"><input type="checkbox" data-change="placeFlag" data-key="home" ${p.home ? 'checked' : ''}>
      <span>Das ist mein Arbeitsplatz zu Hause. Tage an diesem Ort zählen in der Übersicht für die Steuer als „zu Hause gearbeitet“.</span></label>
    ${ERR}
    <button class="btn primary" data-act="sheetDone">Fertig</button>
    ${
      p.hidden
        ? `<button class="btn" data-act="placeHide">Aus dem Archiv zurückholen</button>`
        : visibleCount > 1
          ? `<button class="btn" data-act="placeHide">Ins Archiv verschieben</button>
             <p class="muted small center">Im Archiv wird der Ort nicht mehr zur Auswahl angeboten. Alle Zeiten bleiben erhalten, und du kannst ihn jederzeit zurückholen.</p>`
          : ''
    }
    ${canDelete ? `<button class="btn danger-ghost" data-act="placeDel">Arbeitsort löschen …</button>` : ''}`;
}

function sheetPlace(p) {
  openSheet(placeSheetHtml(p), { type: 'place', id: p.id });
}

// Das offene Fenster neu aufbauen, ohne es zu schließen
function refreshPlaceSheet() {
  const p = sheetPlaceObj();
  if (!p) return;
  const sheet = $('#sheet');
  const top = sheet.scrollTop;
  sheet.innerHTML = placeSheetHtml(p);
  sheet.scrollTop = top;
}

const sheetPlaceObj = () => (ui.sheet && ui.sheet.type === 'place' ? M.allPlaces().find((p) => p.id === ui.sheet.id) : null);

function placesChanged() {
  applyPlaceColors();
  saveSettings();
}

function sheetNotes(b) {
  const work = M.segments(b, now()).filter((s) => s.kind === 'work');
  openSheet(
    `<h2>Was hast du gemacht?</h2>
    <p class="muted">Die Stichworte stehen später im Monatsbericht. Du kannst das auch später nachholen.</p>
    ${work
      .map((s, i) => {
        const prev = i > 0 ? work[i - 1].note : '';
        return `<label class="label">${M.fmtTime(s.from)}–${M.fmtTime(s.to)} Uhr</label>${noteField(b, s.idx, s.ownNote, prev ? `wie davor: ${prev}` : 'z. B. Kurs mit Klasse 6b angeleitet')}`;
      })
      .join('')}
    <button class="btn primary" data-act="sheetDone">Fertig</button>`,
    { type: 'notes', id: b.id }
  );
}

// ---------- Aktionen ----------

function doStop(b, t) {
  const last = M.lastEvent(b);
  if (last.t === 'pause') {
    // Nach der Pause wurde nicht weitergearbeitet: Die Arbeit endete mit Beginn der Pause.
    last.t = 'stopp';
  } else {
    b.events.push({ t: 'stopp', ts: Math.max(t, last.ts) });
  }
  saveBlock(b);
}

function afterStop(b) {
  render();
  if (M.isDetailed(b.place) && missingNotes(b)) sheetNotes(b);
  else toast(`Gestoppt. Das waren ${M.fmtDur(M.netMs(b, now()))} Std. netto.`);
}

function openDetail(id) {
  if (ui.detailId === id) return;
  const wasDetail = !!ui.detailId;
  ui.detailId = id;
  if (!wasDetail) history.pushState({ layer: 'detail' }, '');
  render();
  $('#view').scrollTop = 0;
}

let noteTimer = 0;
let speech = null;

const actions = {
  tab(el) {
    ui.tab = el.dataset.tab;
    if (ui.detailId) {
      ui.detailId = null;
      skipPop++;
      history.back();
    }
    render();
    $('#view').scrollTop = 0;
  },

  start() {
    if (openBlock()) return render();
    // Heute als krank markiert? Dann lieber kurz nachfragen, damit kein Widerspruch entsteht.
    if (sickDays().includes(M.dayKey(now()))) {
      return openSheet(
        `<h2>Heute bist du als krank markiert</h2>
        <p>Hast du heute trotzdem gearbeitet, zum Beispiel im Homeoffice? Dann kannst du die Arbeitszeit ganz normal erfassen. Die Markierung „krank“ bleibt dabei bestehen.</p>
        <button class="btn primary" data-act="startAnyway">Ja, Arbeitszeit erfassen</button>
        ${CANCEL}`
      );
    }
    sheetPlaces();
  },
  startAnyway() {
    sheetPlaces(true);
  },

  pickPlace(el) {
    if (!openBlock()) {
      const b = M.newBlock(el.dataset.place, now());
      state.blocks.push(b);
      saveBlock(b);
      store.askPersistent();
    }
    closeSheet();
    render();
  },

  pause() {
    const b = openBlock();
    if (b && M.stateOf(b) === 'running') {
      b.events.push({ t: 'pause', ts: Math.max(now(), M.lastEvent(b).ts) });
      saveBlock(b);
    }
    render();
  },

  weiter() {
    const b = openBlock();
    if (b && M.stateOf(b) === 'paused') {
      b.events.push({ t: 'weiter', ts: Math.max(now(), M.lastEvent(b).ts) });
      saveBlock(b);
    }
    render();
  },

  stopp() {
    const b = openBlock();
    if (!b) return render();
    doStop(b, now());
    afterStop(b);
  },

  openDetail(el) {
    openDetail(el.dataset.id);
  },

  back() {
    if (!ui.detailId) return;
    ui.detailId = null;
    skipPop++;
    history.back();
    render();
  },

  closeSheet() {
    closeSheet();
  },

  sheetDone() {
    closeSheet();
    render();
  },

  // --- Hinweise ---
  fixEnd(el) {
    const b = byId(el.dataset.id);
    if (!b) return;
    openDetail(b.id);
    sheetAddEnd(b);
  },
  fixOpen(el) {
    openDetail(el.dataset.id);
  },
  hintOk(el) {
    const b = byId(el.dataset.id);
    if (!b) return;
    b.longOk = true;
    saveBlock(b);
    render();
  },
  stopAtPause(el) {
    const b = byId(el.dataset.id);
    if (!b || M.stateOf(b) !== 'paused') return render();
    doStop(b, now());
    afterStop(b);
  },

  // --- Protokoll korrigieren ---
  evEdit(el) {
    const b = byId(ui.detailId);
    if (b) sheetEvent(b, Number(el.dataset.idx));
  },

  shift(el) {
    const p = el.dataset.prefix;
    const ts = readDT(p);
    if (ts == null) return;
    const n = ts + Number(el.dataset.min) * M.MIN;
    $(`#${p}-date`).value = M.dayKey(n);
    $(`#${p}-time`).value = M.fmtTime(n);
  },

  evSave() {
    const b = byId(ui.sheet.id);
    const ts = readDT('ev');
    if (ts == null) return sheetErr('Bitte Tag und Uhrzeit eintragen.');
    const copy = structuredClone(b);
    copy.events[ui.sheet.idx].ts = ts;
    const err = M.validate(copy, now());
    if (err) return sheetErr(err);
    b.events = copy.events;
    saveBlock(b);
    closeSheet();
    render();
  },

  pauseDel() {
    const b = byId(ui.sheet.id);
    let i = ui.sheet.idx;
    if (b.events[i].t === 'weiter') i -= 1;
    const copy = structuredClone(b);
    const count = copy.events[i + 1] && copy.events[i + 1].t === 'weiter' ? 2 : 1;
    copy.events.splice(i, count);
    const err = M.validate(copy, now());
    if (err) return sheetErr(err);
    b.events = copy.events;
    saveBlock(b);
    closeSheet();
    render();
  },

  stoppDel() {
    const b = byId(ui.sheet.id);
    if (openBlock() || M.lastEvent(b).t !== 'stopp') return closeSheet();
    b.events.pop();
    saveBlock(b);
    closeSheet();
    render();
  },

  addPause() {
    const b = byId(ui.detailId);
    if (b) sheetAddPause(b);
  },

  addPauseSave() {
    const b = byId(ui.sheet.id);
    const t = now();
    const start = M.blockStart(b);
    const day = M.dayKey(start);
    let from = M.combine(day, $('#p-von').value);
    let to = M.combine(day, $('#p-bis').value);
    if (from == null || to == null) return sheetErr('Bitte Beginn und Ende der Pause eintragen.');
    // Geht der Block über Mitternacht, kann die Pause am Folgetag liegen.
    if (from < start) from = M.addDays(from, 1);
    if (to < from) to = M.addDays(to, 1);
    if (to <= from) return sheetErr('Das Ende der Pause muss nach dem Beginn liegen.');
    const seg = M.segments(b, t).find((s) => s.kind === 'work' && s.from <= from && to <= s.to);
    if (!seg) return sheetErr('Die Pause muss ganz in der Arbeitszeit liegen und darf sich nicht mit einer anderen Pause überschneiden.');
    b.events.splice(seg.idx + 1, 0, { t: 'pause', ts: from }, { t: 'weiter', ts: to });
    saveBlock(b);
    closeSheet();
    render();
  },

  addEnd() {
    const b = byId(ui.detailId);
    if (b && M.stateOf(b) !== 'done') sheetAddEnd(b);
  },

  addEndSave() {
    const b = byId(ui.sheet.id);
    const ts = readDT('end');
    if (ts == null) return sheetErr('Bitte Tag und Uhrzeit eintragen.');
    const copy = structuredClone(b);
    const last = M.lastEvent(copy);
    if (last.t === 'pause' && ts <= last.ts) {
      last.t = 'stopp';
      last.ts = ts;
    } else {
      copy.events.push({ t: 'stopp', ts });
    }
    const err = M.validate(copy, now());
    if (err) return sheetErr(err);
    b.events = copy.events;
    saveBlock(b);
    closeSheet();
    afterStop(b);
  },

  setPlace(el) {
    const b = byId(ui.detailId);
    const place = el.dataset.place;
    if (!b || b.place === place) return;
    b.place = place;
    b.category = M.defaultCategory(place);
    saveBlock(b);
    render();
  },

  delAsk() {
    const b = byId(ui.detailId);
    if (!b) return;
    openSheet(
      `<h2>Arbeitsblock löschen?</h2>
      <p>${placeLabel(b.place)}, ${M.fmtDate(M.blockStart(b))}, ${M.fmtDur(M.netMs(b, now()))} Std. netto.</p>
      <p class="muted">Das lässt sich nicht rückgängig machen.</p>
      <button class="btn danger" data-act="delYes">Ja, löschen</button>
      ${CANCEL}`,
      { type: 'del', id: b.id }
    );
  },

  delYes() {
    const id = ui.sheet.id;
    state.blocks = state.blocks.filter((b) => b.id !== id);
    store.deleteBlock(id).catch(saveFailed);
    hideSheet();
    ui.detailId = null;
    skipPop++;
    history.go(-2);
    render();
    toast('Arbeitsblock gelöscht.');
  },

  // --- Von Hand nachtragen ---
  newManual() {
    sheetManual();
  },

  manualPlace(el) {
    ui.sheet.place = el.dataset.place;
    document.querySelectorAll('#m-places .chip').forEach((c) => c.classList.toggle('on', c === el));
  },

  manualSave() {
    const date = $('#m-date').value;
    const a = M.combine(date, $('#m-von').value);
    const z = M.combine(date, $('#m-bis').value);
    const pv = $('#m-pvon').value;
    const pb = $('#m-pbis').value;
    const note = $('#m-note').value.trim();
    if (a == null || z == null) return sheetErr('Bitte Tag, Beginn und Ende eintragen.');
    if (z <= a) return sheetErr('Das Ende muss nach dem Beginn liegen.');
    const b = M.newBlock(ui.sheet.place, a);
    if (note) b.events[0].note = note;
    if (pv || pb) {
      const p1 = M.combine(date, pv);
      const p2 = M.combine(date, pb);
      if (p1 == null || p2 == null) return sheetErr('Bitte bei der Pause Beginn und Ende eintragen oder beide Felder leer lassen.');
      if (!(a <= p1 && p1 < p2 && p2 <= z)) return sheetErr('Die Pause muss innerhalb der Arbeitszeit liegen.');
      b.events.push({ t: 'pause', ts: p1 }, { t: 'weiter', ts: p2 });
    }
    b.events.push({ t: 'stopp', ts: z });
    const err = M.validate(b, now());
    if (err) return sheetErr(err);
    // Der Tag ist als krank markiert: einmal nachfragen, beim zweiten Tippen wird eingetragen
    if (sickDays().includes(date) && ui.sheet.sickOk !== date) {
      ui.sheet.sickOk = date;
      return sheetErr('Dieser Tag ist als krank markiert. Wenn du trotzdem gearbeitet hast, tippe noch einmal auf „Eintragen“. Die Markierung „krank“ bleibt bestehen.');
    }
    state.blocks.push(b);
    saveBlock(b);
    store.askPersistent();
    const d = new Date(a);
    ui.histMonth = { y: d.getFullYear(), m: d.getMonth() };
    closeSheet();
    render();
    toast('Arbeitsblock eingetragen.');
  },

  // --- Notizen ---
  noteChip(el) {
    const b = byId(el.dataset.id);
    if (!b) return;
    b.events[Number(el.dataset.idx)].note = el.dataset.note;
    saveBlock(b);
    render();
  },

  mic(el) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const input = el.closest('.note-row').querySelector('input');
    if (speech) return speech.stop();
    const fallback = 'Diktieren hat nicht geklappt, dafür braucht es Internet. Du kannst das Mikrofon auf der Tastatur nehmen.';
    try {
      speech = new SR();
      speech.lang = 'de-DE';
      speech.interimResults = false;
      el.classList.add('listening');
      speech.onresult = (ev) => {
        const txt = ev.results[0][0].transcript.trim();
        if (!txt) return;
        input.value = input.value.trim() ? `${input.value.trim()} ${txt}` : txt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      speech.onerror = (ev) => {
        if (ev.error === 'no-speech' || ev.error === 'aborted') return;
        toast(ev.error === 'not-allowed' ? 'Das Mikrofon ist für diese App nicht erlaubt. Du kannst das Mikrofon auf der Tastatur nehmen.' : fallback);
      };
      speech.onend = () => {
        el.classList.remove('listening');
        speech = null;
      };
      speech.start();
    } catch (e) {
      el.classList.remove('listening');
      speech = null;
      toast(fallback);
    }
  },

  // --- Monat wechseln, Export ---
  month(el) {
    const d = new Date(ui.histMonth.y, ui.histMonth.m + Number(el.dataset.d), 1);
    ui.histMonth = { y: d.getFullYear(), m: d.getMonth() };
    render();
  },

  // --- Erster Start: Arbeitsort aus einer Vorlage oder selbst anlegen ---
  tplAdd(el) {
    const p = M.placeTemplates().find((x) => x.id === el.dataset.id);
    if (!p || M.placeIds().includes(p.id)) return;
    state.settings.places.push(p);
    placesChanged();
    if (ui.sheet) closeSheet();
    render();
    toast(`„${p.name}“ ist angelegt.`);
  },
  tplOwn() {
    if (ui.sheet) closeSheet();
    ui.tab = 'set';
    // Kurz warten, bis das alte Fenster ganz geschlossen ist
    setTimeout(() => actions.placeAdd(), 60);
  },

  // --- Arbeitsorte und ihre Kategorien bearbeiten ---
  placeEdit(el) {
    const p = M.allPlaces().find((x) => x.id === el.dataset.id);
    if (p) sheetPlace(p);
  },
  placeAdd() {
    const p = M.newPlace();
    state.settings.places.push(p);
    placesChanged();
    render();
    sheetPlace(p);
    const name = $('#sheet input[data-input="placeName"]');
    if (name) {
      name.focus();
      name.select();
    }
  },
  placeIcon(el) {
    const p = sheetPlaceObj();
    if (!p) return;
    p.icon = el.dataset.icon;
    placesChanged();
    refreshPlaceSheet();
  },
  placeColor(el) {
    const p = sheetPlaceObj();
    if (!p) return;
    p.color = Number(el.dataset.color);
    placesChanged();
    refreshPlaceSheet();
  },
  // Ins Archiv verschieben oder zurückholen
  placeHide() {
    const p = sheetPlaceObj();
    if (!p) return;
    ui.sheet.confirm = null;
    if (!p.hidden && M.visiblePlaces().length <= 1) {
      refreshPlaceSheet();
      return sheetErr('Mindestens ein Arbeitsort muss zur Auswahl bleiben.');
    }
    p.hidden = !p.hidden;
    if (p.hidden && ui.rep.place === p.id) ui.rep.place = 'all';
    placesChanged();
    refreshPlaceSheet();
    toast(p.hidden ? 'Der Arbeitsort liegt jetzt im Archiv.' : 'Der Arbeitsort ist wieder in der Auswahl.');
  },
  // Löschen: erst die Rückfrage zeigen
  placeDel() {
    if (!sheetPlaceObj()) return;
    ui.sheet.confirm = { kind: 'place' };
    refreshPlaceSheet();
    $('#sheet').scrollTop = 0;
  },
  placeDelYes() {
    const p = sheetPlaceObj();
    if (!p) return;
    const mine = state.blocks.filter((b) => b.place === p.id);
    const canDelete = M.visiblePlaces().some((x) => x !== p);
    if (!canDelete || mine.some((b) => M.stateOf(b) !== 'done')) {
      ui.sheet.confirm = null;
      return refreshPlaceSheet();
    }
    state.blocks = state.blocks.filter((b) => b.place !== p.id);
    for (const b of mine) store.deleteBlock(b.id).catch(saveFailed);
    const list = state.settings.places;
    list.splice(list.indexOf(p), 1);
    if (ui.rep.place === p.id) ui.rep.place = 'all';
    placesChanged();
    closeSheet();
    render();
    toast(mine.length ? 'Arbeitsort und seine Zeiten gelöscht.' : 'Arbeitsort gelöscht.');
  },
  confirmNo() {
    if (!ui.sheet) return;
    ui.sheet.confirm = null;
    refreshPlaceSheet();
  },
  catAdd() {
    const p = sheetPlaceObj();
    const input = $('#cat-new');
    if (!p || !input) return;
    const name = input.value.trim();
    if (!name) return sheetErr('Bitte zuerst einen Namen für die neue Kategorie eintippen.');
    if (p.categories.some((c) => c.toLowerCase() === name.toLowerCase())) return sheetErr(`Die Kategorie „${name}“ gibt es hier schon.`);
    p.categories.push(name);
    placesChanged();
    refreshPlaceSheet();
  },
  catDefault(el) {
    const p = sheetPlaceObj();
    const i = Number(el.dataset.i);
    if (!p || i <= 0 || i >= p.categories.length) return;
    p.categories.unshift(p.categories.splice(i, 1)[0]);
    placesChanged();
    refreshPlaceSheet();
  },
  // Kategorie entfernen: erst die Rückfrage zeigen
  catDel(el) {
    const p = sheetPlaceObj();
    const i = Number(el.dataset.i);
    if (!p || !(i >= 0 && i < p.categories.length)) return;
    if (p.categories.length <= 1) return sheetErr('Mindestens eine Kategorie muss bleiben.');
    ui.sheet.confirm = { kind: 'cat', i };
    refreshPlaceSheet();
    $('#sheet').scrollTop = 0;
  },
  catDelYes() {
    const p = sheetPlaceObj();
    const c = ui.sheet && ui.sheet.confirm;
    if (!p || !c || c.kind !== 'cat') return;
    if (p.categories.length > 1) p.categories.splice(c.i, 1);
    ui.sheet.confirm = null;
    placesChanged();
    refreshPlaceSheet();
  },

  setTheme(el) {
    state.settings.theme = el.dataset.theme;
    applyTheme();
    saveSettings();
    const view = $('#view');
    const top = view.scrollTop;
    render();
    view.scrollTop = top;
  },

  // --- Kategorie ---
  // „Weitere“ klappt die übrigen Kategorien auf und wieder zu
  catMore(el) {
    const open = ui.catsOpen !== el.dataset.id;
    ui.catsOpen = open ? el.dataset.id : null;
    el.textContent = open ? 'Weniger ▴' : 'Weitere ▾';
    el.setAttribute('aria-expanded', String(open));
    const wrap = el.parentElement.nextElementSibling;
    if (wrap) wrap.classList.toggle('open', open);
  },

  setCat(el) {
    const b = byId(el.dataset.id);
    if (!b) return;
    ui.catsOpen = null;
    b.category = el.dataset.cat;
    saveBlock(b);
    render();
  },

  // --- Berichte ---
  repMode(el) {
    ui.repMode = el.dataset.mode;
    render();
    $('#view').scrollTop = 0;
  },
  taxKind(el) {
    ui.taxKind = el.dataset.kind;
    render();
  },
  // --- Krankentage ---
  sickMonth(el) {
    const d = new Date(ui.sickMonth.y, ui.sickMonth.m + Number(el.dataset.d), 1);
    ui.sickMonth = { y: d.getFullYear(), m: d.getMonth() };
    render();
  },
  sickToggle(el) {
    const k = el.dataset.day;
    const adding = !sickDays().includes(k);
    const ts = keyToTs(k);
    const worked = adding ? sumRange(now(), ts, M.addDays(ts, 1)) : 0;
    // An dem Tag ist schon Arbeitszeit erfasst: erst nachfragen
    if (worked > 0) {
      return openSheet(
        `<h2>An diesem Tag hast du gearbeitet</h2>
        <p>Am ${M.fmtDate(ts)} sind <b>${M.fmtDur(worked)} Stunden</b> Arbeitszeit erfasst. Möchtest du den Tag trotzdem als krank markieren?</p>
        <p class="muted">Die erfasste Arbeitszeit bleibt dabei unverändert.</p>
        <button class="btn primary" data-act="sickYes">Ja, als krank markieren</button>
        ${CANCEL}`,
        { type: 'sick', day: k }
      );
    }
    setSick(k, adding);
  },
  sickYes() {
    const k = ui.sheet && ui.sheet.day;
    closeSheet();
    if (k) setSick(k, true);
  },
  taxShift(el) {
    ui.taxAnchor = shiftAnchor(ui.taxKind, ui.taxAnchor, Number(el.dataset.d));
    render();
  },
  repKind(el) {
    const kind = el.dataset.kind;
    if (kind === 'frei' && ui.rep.kind !== 'frei') {
      // Mit dem Zeitraum beginnen, der gerade zu sehen ist
      const per = repPeriod();
      ui.rep.from = M.dayKey(per.from);
      ui.rep.to = M.dayKey(M.addDays(per.to, -1));
    }
    ui.rep.kind = kind;
    render();
  },
  repShift(el) {
    ui.rep.anchor = shiftAnchor(ui.rep.kind, ui.rep.anchor, Number(el.dataset.d));
    render();
  },
  repNow() {
    ui.rep.anchor = Date.now();
    render();
  },
  repPlace(el) {
    ui.rep.place = el.dataset.place;
    render();
  },
  colInfo(el) {
    const c = lastRep && lastRep.series[Number(el.dataset.i)];
    const out = $('#col-info');
    if (!c || !out) return;
    const ids = lastRep.all ? M.placeIds().filter((id) => c.parts[id] > 0) : [];
    const parts = ids.length > 1 ? ` (${ids.map((id) => `${placeName(id)} ${M.fmtDur(c.parts[id])}`).join(' · ')})` : ids.length === 1 ? ` (${placeName(ids[0])})` : '';
    out.textContent = `${c.full}: ${M.fmtDur(c.ms)} Std.${parts}${c.sick ? ` · ${nDays(c.sick)} krank markiert` : ''}`;
    out.classList.remove('muted');
    document.querySelectorAll('.cols .col').forEach((x) => x.classList.toggle('on', x === el));
    el.parentElement.classList.add('picked');
  },

  async exp(el) {
    const rep = currentReport();
    if (!rep.rows.length) return toast('In diesem Zeitraum gibt es noch keine Zeiten.');
    const pdf = el.dataset.kind === 'pdf';
    const safe = rep.fileLabel.replace(/[^A-Za-z0-9ÄÖÜäöüß]+/g, '-').replace(/^-|-$/g, '') || 'Bericht';
    const name = `Arbeitszeit-${safe}-${rep.period.key}.${pdf ? 'pdf' : 'xlsx'}`;
    const type = pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    let file;
    try {
      file = new File([pdf ? reportPdf(rep) : reportXlsx(rep)], name, { type });
    } catch (e) {
      console.error(e);
      return toast('Der Bericht konnte nicht erstellt werden.');
    }
    await deliverFile(file, el.dataset.mode, `${rep.title}, ${rep.label}`);
  },

  // ----- Datensicherung -----

  setBackupEvery(el) {
    state.settings.backupEvery = el.dataset.every;
    saveSettings();
    const view = $('#view');
    const top = view.scrollTop;
    render();
    view.scrollTop = top;
  },

  backupOpen() {
    openSheet(backupSheetHtml(), { type: 'backup' });
  },

  backupLater() {
    // Erst morgen wieder erinnern
    state.settings.backupSnooze = M.addDays(M.startOfDay(now()), 1);
    saveSettings();
    render();
  },

  async backup(el) {
    const mode = el.dataset.mode;
    const ok = await deliverFile(backupFile(mode === 'share'), mode, 'Work Time Tracker: Sicherung');
    if (!ok) return;
    state.settings.lastBackup = Date.now();
    delete state.settings.backupSnooze;
    saveSettings();
    if (mode === 'share') toast('Danke! Die Sicherung ist gespeichert.');
    if (ui.sheet && ui.sheet.type === 'backup') closeSheet();
    else if (ui.sheet && ui.sheet.type === 'old') swapSheet(oldSheetHtml(), ui.sheet);
    const view = $('#view');
    const top = view.scrollTop;
    render();
    view.scrollTop = top;
  },

  // Neue Fassung holen: Die Zeiten bleiben dabei auf dem Handy, nur die App wird neu geladen.
  async checkVersion() {
    if (!navigator.onLine) return toast('Dafür braucht das Handy Internet (WLAN oder mobile Daten).');
    toast('Einen Moment, die App lädt neu …');
    await checkUpdate();
    setTimeout(() => location.reload(), 600);
  },

  // Dateiauswahl öffnen. Das Auswahlfeld hängt bewusst nicht im Bildschirm (#view):
  // Auf Android wird die App beim Zurückkehren aus der Dateiauswahl neu gezeichnet,
  // ein Feld im Bildschirm wäre dann schon ersetzt und die gewählte Datei käme nie an.
  restorePick() {
    const old = $('#restore-file');
    if (old) old.remove();
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'restore-file';
    input.hidden = true;
    // Ohne diese Angabe bietet Android zuerst Kamera und Mediathek an statt der Dateien.
    input.accept = '.json,.txt,application/json,text/plain,application/octet-stream';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();
      if (file) restoreFromFile(file);
    });
    document.body.append(input);
    input.click();
  },

  async restoreDo(el) {
    const r = pendingRestore;
    if (!r) return closeSheet();
    const replace = el.dataset.how === 'replace';
    let d;
    let toSave;
    if (replace) {
      d = prepareData(r.blocks, { ...r.settings, lastBackup: r.created || Date.now() });
      delete d.settings.backupSnooze;
      toSave = d.blocks;
    } else {
      const have = new Set(state.blocks.map((b) => b.id));
      toSave = r.blocks.filter((b) => !have.has(b.id));
      const inc = M.mergeSettings(r.settings, true);
      const s = { ...state.settings, places: [...state.settings.places] };
      for (const p of inc.places) if (!s.places.some((q) => q.id === p.id)) s.places.push(p);
      s.sickDays = [...new Set([...(state.settings.sickDays || []), ...(r.settings.sickDays || [])])].sort();
      if (!s.userName && inc.userName) s.userName = inc.userName;
      d = prepareData([...state.blocks, ...toSave], s);
    }
    try {
      await store.saveAll(toSave, d.settings, replace);
    } catch (err) {
      console.error(err);
      return sheetErr('Das Einlesen hat leider nicht geklappt. Auf dem Handy hat sich nichts verändert.');
    }
    adoptData(d);
    pendingRestore = null;
    ui.detailId = null;
    store.askPersistent();
    closeSheet();
    render();
    toast(replace ? `Fertig: ${d.blocks.length} Arbeitsblöcke eingelesen.` : `Fertig: ${toSave.length} Arbeitsblöcke ergänzt.`);
  },

  oldOpen() {
    openSheet(oldSheetHtml(), { type: 'old' });
  },

  oldKeep() {
    state.settings.oldDataOk = oldData(now()).cutoff;
    saveSettings();
    if (ui.sheet) closeSheet();
    render();
    toast('Gut, die alten Daten bleiben. Im nächsten Schuljahr fragt die App wieder.');
  },

  async oldDel() {
    const old = oldData(now());
    const ids = old.blocks.map((b) => b.id);
    try {
      await store.deleteBlocks(ids);
    } catch (err) {
      console.error(err);
      return sheetErr('Das Löschen hat leider nicht geklappt.');
    }
    const gone = new Set(ids);
    state.blocks = state.blocks.filter((b) => !gone.has(b.id));
    state.settings.sickDays = sickDays().filter((k) => !old.sick.includes(k));
    saveSettings();
    closeSheet();
    render();
    toast('Die alten Daten sind gelöscht.');
  },
};

const inputs = {
  // Notiz eines Abschnitts: wird beim Tippen gespeichert
  segnote(el) {
    const b = byId(el.dataset.id);
    if (!b) return;
    const ev = b.events[Number(el.dataset.idx)];
    if (!ev) return;
    const v = el.value.trim();
    if (v) ev.note = v;
    else delete ev.note;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveBlock(b), 300);
  },

  placeName(el) {
    const p = sheetPlaceObj();
    if (!p) return;
    p.name = el.value.trim().slice(0, 40) || 'Arbeitsort';
    saveSettings();
  },

  set(el) {
    const key = el.dataset.key;
    const s = state.settings;
    if (key === 'userName') s.userName = el.value.trim();
    else {
      const n = Number(el.value);
      if (!Number.isFinite(n) || n < 1 || n > 48) return;
      s[key] = n;
    }
    saveSettings();
  },
};

// ---------- Start ----------

document.addEventListener('click', (e) => {
  if (e.target.id === 'backdrop') {
    closeSheet();
    return render();
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el, e);
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (el && inputs[el.dataset.input]) inputs[el.dataset.input](el);
});

// Felder, die erst nach fertiger Eingabe wirken (z. B. ein gewähltes Datum)
const changes = {
  repDate(el) {
    if (!el.value) return;
    ui.rep[el.dataset.key] = el.value;
    render();
  },

  // Kategorie umbenennen: Die bisherigen Arbeitsblöcke an diesem Ort bekommen den neuen Namen mit.
  catName(el) {
    const p = sheetPlaceObj();
    const i = Number(el.dataset.i);
    if (!p || !(i >= 0 && i < p.categories.length)) return;
    const old = p.categories[i];
    const name = el.value.trim();
    if (name === old) return;
    if (!name || p.categories.some((c, k) => k !== i && c.toLowerCase() === name.toLowerCase())) {
      el.value = old;
      return sheetErr(name ? `Die Kategorie „${name}“ gibt es hier schon.` : 'Eine Kategorie braucht einen Namen.');
    }
    p.categories[i] = name;
    for (const b of state.blocks) {
      if (b.place === p.id && b.category === old) {
        b.category = name;
        saveBlock(b);
      }
    }
    saveSettings();
  },

  showSick(el) {
    state.settings.showSick = el.checked;
    saveSettings();
    const view = $('#view');
    const top = view.scrollTop;
    render();
    view.scrollTop = top;
  },

  placeFlag(el) {
    const p = sheetPlaceObj();
    if (!p) return;
    p[el.dataset.key] = el.checked;
    saveSettings();
  },
};

// Sicherungsdatei wurde ausgewählt
async function restoreFromFile(file) {
  let r;
  try {
    r = readBackup(await file.text());
  } catch (err) {
    console.error(err);
    r = { err: 'Die Datei ließ sich nicht öffnen.' };
  }
  // Falls noch ein anderes Fenster offen ist, wird sein Inhalt ersetzt.
  const show = ui.sheet ? swapSheet : openSheet;
  if (r.err) {
    pendingRestore = null;
    return show(`<h2>Das hat nicht geklappt</h2><p>${esc(r.err)}</p><button class="btn" data-act="closeSheet">Schließen</button>`);
  }
  pendingRestore = r;
  show(restoreSheetHtml(), { type: 'restore' });
}

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && changes[el.dataset.change]) changes[el.dataset.change](el);
});

// Die Zurück-Taste des Handys schließt erst ein Fenster, dann die Detailansicht.
window.addEventListener('popstate', () => {
  if (skipPop > 0) {
    skipPop--;
    return;
  }
  if (ui.sheet) {
    hideSheet();
    render();
  } else if (ui.detailId) {
    ui.detailId = null;
    render();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (reloadPending && reloadNow()) return;
  if (!ui.sheet && !isTyping()) render();
  else tick();
  checkUpdate();
});

// ---------- Neue Fassung der App ----------
//
// Wird die App nur aus dem Hintergrund geholt, lädt sie sich nicht neu. Deshalb fragt sie beim
// Öffnen nach einer neuen Fassung. Ist eine da, lädt sie sich neu, sobald gerade nichts eingegeben wird.

let reloadPending = false;

function checkUpdate() {
  if (!('serviceWorker' in navigator) || !navigator.onLine) return Promise.resolve();
  return navigator.serviceWorker
    .getRegistration()
    .then((reg) => reg && reg.update())
    .catch(() => {});
}

function reloadNow() {
  if (ui.sheet || isTyping()) return false;
  location.reload();
  return true;
}

function watchUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Beim allerersten Öffnen gibt es noch keine alte Fassung, dann ist nichts zu tun.
    if (!hadController) return;
    reloadPending = true;
    reloadNow();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

async function init() {
  try {
    const data = await store.load();
    const blocks = data.blocks.filter((b) => b && Array.isArray(b.events) && b.events.length);
    // Sicherheitsnetz: Jeder gespeicherte Arbeitsblock braucht seinen Arbeitsort in der Liste.
    const d = prepareData(blocks, data.settings);
    adoptData(d);
    if (d.repaired) saveSettings();
  } catch (err) {
    console.error(err);
    $('#view').innerHTML = '<p class="note-box">Die gespeicherten Daten konnten nicht geladen werden. Bitte schließe die App und öffne sie noch einmal.</p>';
    return;
  }
  render();
  setInterval(tick, 5000);
  watchUpdates();
}

init();

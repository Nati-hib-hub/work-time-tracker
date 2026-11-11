// Oberfläche der App: Bildschirme, Knöpfe und Eingaben.

import * as M from './model.js';
import * as store from './store.js';
import { PERIOD_KINDS, buildReport, period, shiftAnchor } from './report.js';
import { reportPdf } from './pdf.js';
import { reportXlsx } from './xlsx.js';

const VERSION = '0.2 · Berichte und Kategorien';

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
  rep: { kind: 'monat', anchor: today.getTime(), place: 'all', from: M.dayKey(today.getTime()), to: M.dayKey(today.getTime()) },
  sheet: null,
};
let lastRep = null;
let skipPop = 0;

const now = () => M.floorMin(Date.now());
const byId = (id) => state.blocks.find((b) => b.id === id);
const openBlock = () =>
  state.blocks.filter((b) => M.stateOf(b) !== 'done').sort((a, b) => M.blockStart(b) - M.blockStart(a))[0] || null;
const placeName = (id) => (state.settings.places[id] && state.settings.places[id].name) || M.PLACE_META[id].defaultName;
const placeLabel = (id) => `${M.PLACE_META[id].icon} ${esc(placeName(id))}`;
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
// Bei gleicher Häufigkeit kommt die zuletzt verwendete Notiz zuerst. Es gibt höchstens fünf Vorschläge.
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
    .slice(0, 5)
    .map((s) => s.n);
}

const missingNotes = (b) => M.segments(b, now()).some((s) => s.kind === 'work' && !s.note);

// ---------- Hinweise beim Öffnen ----------

function hints(b, t) {
  if (!b || b.place === 'fahrt') return [];
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

// ---------- Bausteine ----------

function blockItem(b, t) {
  const st = M.stateOf(b);
  const from = M.fmtTime(M.blockStart(b));
  const to = st === 'done' ? M.fmtTime(M.lastEvent(b).ts) : st === 'paused' ? 'Pause' : 'läuft';
  const p = M.pauseMs(b, t);
  const notes = M.blockNotes(b).join(' · ');
  const cat = b.category && b.category !== M.PLACE_META[b.place].defaultCategory ? ` · ${esc(b.category)}` : '';
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
function catChips(b) {
  const cats = [...M.categoriesFor(b.place)];
  if (b.category && !cats.includes(b.category)) cats.unshift(b.category);
  return `<div class="chips">${cats
    .map((c) => `<button class="chip ${c === b.category ? 'on' : ''}" data-act="setCat" data-id="${b.id}" data-cat="${esc(c)}">${esc(c)}</button>`)
    .join('')}</div>`;
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
  let h = hintsHtml(b, t);

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
      ${chips.length ? `<div class="chips">${chips.map((n) => `<button class="chip" data-act="noteChip" data-id="${b.id}" data-idx="${seg.idx}" data-note="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
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
    <div class="place-chips">${M.PLACE_IDS.map((id) => `<button class="chip place-${id} ${id === b.place ? 'on' : ''}" data-act="setPlace" data-place="${id}">${placeLabel(id)}</button>`).join('')}</div>
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
  const places = `<button class="chip place-all ${r.place === 'all' ? 'on' : ''}" data-act="repPlace" data-place="all">Alle zusammen</button>${M.PLACE_IDS.map(
    (id) => `<button class="chip place-${id} ${id === r.place ? 'on' : ''}" data-act="repPlace" data-place="${id}">${placeLabel(id)}</button>`
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
  const cols = s
    .map((c, i) => {
      const ids = rep.all ? M.PLACE_IDS.filter((id) => c.parts[id] > 0) : c.ms > 0 ? [rep.place] : [];
      const segs = ids.map((id) => `<span class="col-seg place-${id}" style="flex-grow:${Math.round((rep.all ? c.parts[id] : c.ms) / M.MIN)}"></span>`).join('');
      const tip = `${c.full}: ${M.fmtDur(c.ms)} Std.`;
      return `<button class="col" data-act="colInfo" data-i="${i}" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="col-stack" style="height:${((c.ms / (top * M.HOUR)) * 100).toFixed(1)}%">${segs}</span></button>`;
    })
    .join('');
  const labels = s.map((c) => `<span>${esc(c.label)}</span>`).join('');
  const legend =
    rep.all && rep.byPlace.length > 1
      ? `<div class="legend">${M.PLACE_IDS.filter((id) => rep.byPlace.some((p) => p.id === id))
          .map((id) => `<span class="place-${id}"><span class="dot"></span> ${esc(placeName(id))}</span>`)
          .join('')}</div>`
      : '';
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
      <div class="col-labels">${labels}</div>
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

function viewReport() {
  const rep = currentReport();
  lastRep = rep;
  const share = canShareFiles();
  const exportBtns = (kind, label) => `<div class="export-row"><span>${label}</span>
    <button class="btn small" data-act="exp" data-kind="${kind}" data-mode="save">Herunterladen</button>
    ${share ? `<button class="btn small" data-act="exp" data-kind="${kind}" data-mode="share">Teilen</button>` : ''}</div>`;
  const where = rep.all ? '' : ` am Arbeitsort „${esc(rep.placeName)}“`;

  let body;
  if (!rep.rows.length) {
    body = `<p class="muted empty">Für diesen Zeitraum (${esc(rep.label)}) gibt es noch keine Zeiten${where}.</p>`;
  } else {
    body = `<section class="summary"><span>${esc(rep.period.sumLabel.replace(' (ohne Pausen)', ''))}${rep.all ? '' : `<br><small>${esc(rep.placeName)}</small>`}</span><b>${M.fmtDur(rep.totalMs)} Std.</b></section>
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
  ${repControls(rep.period)}
  ${rep.openCount ? `<p class="note-box">Ein Arbeitsblock läuft noch. Er ist bis jetzt (${M.fmtTime(now())} Uhr) mitgezählt.</p>` : ''}
  ${body}`;
}

// ---------- Bildschirm: Einstellungen ----------

function viewSettings() {
  const s = state.settings;
  return `<h2 class="page-title">Einstellungen</h2>
  <p class="muted small">Alles, was du hier änderst, wird sofort gespeichert. Einen Speichern-Knopf braucht es nicht.</p>
  <section class="card">
    <label class="label" for="set-name">Dein Name (steht in den Berichten)</label>
    <input id="set-name" type="text" data-input="set" data-key="userName" value="${esc(s.userName)}" autocomplete="name" placeholder="Vorname Nachname">
  </section>
  <section class="card">
    <h2>Namen der Arbeitsorte</h2>
    ${M.PLACE_IDS.map(
      (id) => `<label class="label place-${id}" for="set-${id}"><span class="dot"></span> ${M.PLACE_META[id].icon} ${M.PLACE_META[id].defaultName}</label>
      <input id="set-${id}" type="text" data-input="set" data-key="place:${id}" value="${esc(s.places[id].name)}" maxlength="40">`
    ).join('')}
  </section>
  <section class="card">
    <h2>Hinweise beim Öffnen</h2>
    <label class="label" for="set-run">Nachfragen, wenn die Uhr länger ohne Pause läuft als (Stunden)</label>
    <input id="set-run" type="number" inputmode="numeric" min="1" max="48" data-input="set" data-key="warnRunHours" value="${s.warnRunHours}">
    <label class="label" for="set-pause">Nachfragen, wenn eine Pause länger dauert als (Stunden)</label>
    <input id="set-pause" type="number" inputmode="numeric" min="1" max="48" data-input="set" data-key="warnPauseHours" value="${s.warnPauseHours}">
    <p class="muted small">Bei Klassenfahrten gibt es diese Hinweise nicht.</p>
  </section>
  <p class="muted small center">Work Time Tracker · Version ${VERSION}<br>Alle Daten liegen nur auf diesem Gerät.</p>`;
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

function sheetPlaces() {
  openSheet(
    `<h2>Wo arbeitest du?</h2>
    <div class="place-grid">${M.PLACE_IDS.map((id) => `<button class="place-btn place-${id}" data-act="pickPlace" data-place="${id}"><span class="place-icon">${M.PLACE_META[id].icon}</span>${esc(placeName(id))}</button>`).join('')}</div>
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
  const t = now();
  const sameMonth = ui.histMonth.y === new Date(t).getFullYear() && ui.histMonth.m === new Date(t).getMonth();
  const day = sameMonth ? M.dayKey(t) : M.dayKey(new Date(ui.histMonth.y, ui.histMonth.m, 1).getTime());
  openSheet(
    `<h2>Arbeitsblock nachtragen</h2>
    <label class="label">Arbeitsort</label>
    <div class="place-chips" id="m-places">${M.PLACE_IDS.map((id, i) => `<button class="chip place-${id} ${i === 0 ? 'on' : ''}" data-act="manualPlace" data-place="${id}">${placeLabel(id)}</button>`).join('')}</div>
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
    { type: 'manual', place: M.PLACE_IDS[0] }
  );
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
    sheetPlaces();
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
    b.category = M.PLACE_META[place].defaultCategory;
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

  // --- Kategorie ---
  setCat(el) {
    const b = byId(el.dataset.id);
    if (!b) return;
    b.category = el.dataset.cat;
    saveBlock(b);
    render();
  },

  // --- Berichte ---
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
    const ids = lastRep.all ? M.PLACE_IDS.filter((id) => c.parts[id] > 0) : [];
    const parts = ids.length > 1 ? ` (${ids.map((id) => `${placeName(id)} ${M.fmtDur(c.parts[id])}`).join(' · ')})` : ids.length === 1 ? ` (${placeName(ids[0])})` : '';
    out.textContent = `${c.full}: ${M.fmtDur(c.ms)} Std.${parts}`;
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
    if (el.dataset.mode === 'share') {
      try {
        await navigator.share({ files: [file], title: `${rep.title}, ${rep.label}` });
      } catch (e) {
        if (e.name !== 'AbortError') toast('Teilen hat nicht geklappt. Versuche es mit „Herunterladen“.');
      }
      return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    toast('Die Datei liegt jetzt im Download-Ordner.');
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

  set(el) {
    const key = el.dataset.key;
    const s = state.settings;
    if (key === 'userName') s.userName = el.value.trim();
    else if (key.startsWith('place:')) {
      const id = key.slice(6);
      s.places[id].name = el.value.trim() || M.PLACE_META[id].defaultName;
    } else {
      const n = Number(el.value);
      if (!Number.isFinite(n) || n < 1 || n > 48) return;
      s[key] = n;
    }
    saveSettings();
  },
};

// ---------- Start ----------

document.addEventListener('click', (e) => {
  if (e.target.id === 'backdrop') return closeSheet();
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
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el || el.dataset.change !== 'repDate' || !el.value) return;
  ui.rep[el.dataset.key] = el.value;
  render();
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
  if (!ui.sheet && !isTyping()) render();
  else tick();
});

async function init() {
  try {
    const data = await store.load();
    state.blocks = data.blocks.filter((b) => b && Array.isArray(b.events) && b.events.length);
    state.settings = M.mergeSettings(data.settings);
  } catch (err) {
    console.error(err);
    $('#view').innerHTML = '<p class="note-box">Die gespeicherten Daten konnten nicht geladen werden. Bitte schließe die App und öffne sie noch einmal.</p>';
    return;
  }
  render();
  setInterval(tick, 5000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();

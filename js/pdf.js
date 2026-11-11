// Erzeugt PDF-Dateien direkt in der App, ohne fremde Programmbibliothek und ohne Internet.
// Verwendet die Schrift Helvetica, die jedes PDF-Programm schon mitbringt.

import { fmtDur, fmtTime, pad } from './model.js';

const PAGE_W = 595.28; // A4 hochkant
const PAGE_H = 841.89;

// Zeichenbreiten von Helvetica (normal und fett) für die Zeichen 32 bis 126
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500,
  389, 280, 389, 584];
// Umlaute und Sonderzeichen: [normal, fett]
const W_EXTRA = {
  196: [667, 722], 214: [778, 778], 220: [722, 722], 223: [611, 611],
  228: [556, 556], 246: [556, 611], 252: [556, 611],
  0x80: [556, 556], 0x84: [333, 500], 0x85: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278],
  0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350], 0x96: [556, 556], 0x97: [1000, 1000], 160: [278, 278],
};
// Zeichen, die im PDF-Zeichensatz (Windows-1252) an anderer Stelle liegen
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x201e: 0x84, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
};

function encode(str) {
  const out = [];
  for (const ch of String(str == null ? '' : str)) {
    const cp = ch.codePointAt(0);
    if ((cp >= 32 && cp < 127) || (cp >= 160 && cp < 256)) out.push(cp);
    else if (CP1252[cp]) out.push(CP1252[cp]);
    else if (cp === 9 || cp === 10 || cp === 13) out.push(32);
    else out.push(63); // unbekanntes Zeichen (z. B. Emoji) wird zu "?"
  }
  return out;
}

function charWidth(c, bold) {
  if (c >= 32 && c <= 126) return (bold ? W_BOLD : W_REG)[c - 32];
  const x = W_EXTRA[c];
  return x ? x[bold ? 1 : 0] : 556;
}

function textWidth(bytes, size, bold) {
  let w = 0;
  for (const c of bytes) w += charWidth(c, bold);
  return (w * size) / 1000;
}

function pdfString(bytes) {
  let s = '(';
  for (const c of bytes) {
    if (c === 40 || c === 41 || c === 92) s += '\\' + String.fromCharCode(c);
    else if (c < 127) s += String.fromCharCode(c);
    else s += '\\' + c.toString(8).padStart(3, '0');
  }
  return s + ')';
}

const num = (v) => (Math.round(v * 100) / 100).toString();

class Doc {
  constructor(landscape) {
    this.w = landscape ? PAGE_H : PAGE_W;
    this.h = landscape ? PAGE_W : PAGE_H;
    this.pages = [];
    this.ops = null;
  }

  page() {
    this.ops = [];
    this.pages.push(this.ops);
  }

  // x, y von links oben gemessen; y ist die Grundlinie der Schrift
  text(x, y, str, o = {}) {
    const size = o.size || 10;
    const bold = !!o.bold;
    const bytes = encode(str);
    if (!bytes.length) return;
    let tx = x;
    if (o.align === 'right') tx = x - textWidth(bytes, size, bold);
    const gray = o.gray == null ? 0 : o.gray;
    this.ops.push(`BT ${gray} g /${bold ? 'F2' : 'F1'} ${size} Tf ${num(tx)} ${num(this.h - y)} Td ${pdfString(bytes)} Tj ET`);
  }

  rect(x, y, w, h, gray) {
    this.ops.push(`${gray} g ${num(x)} ${num(this.h - y - h)} ${num(w)} ${num(h)} re f`);
  }

  line(x1, y1, x2, y2, gray = 0.75, width = 0.5) {
    this.ops.push(`${gray} G ${width} w ${num(x1)} ${num(this.h - y1)} m ${num(x2)} ${num(this.h - y2)} l S`);
  }

  // Bricht einen Text so um, dass er in die Breite maxW passt
  wrap(str, maxW, size, bold) {
    const fits = (s) => textWidth(encode(s), size, bold) <= maxW;
    const words = String(str || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (let w of words) {
      while (!fits(w)) {
        let k = w.length - 1;
        while (k > 1 && !fits(w.slice(0, k))) k--;
        if (cur) {
          lines.push(cur);
          cur = '';
        }
        lines.push(w.slice(0, k));
        w = w.slice(k);
      }
      if (!cur) cur = w;
      else if (fits(cur + ' ' + w)) cur += ' ' + w;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  build(title) {
    const objs = [];
    const add = (s) => {
      objs.push(s);
      return objs.length;
    };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(''); // Platzhalter für die Seitenliste
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    add(`<< /Title ${pdfString(encode(title))} /Producer (Work Time Tracker) >>`);
    const kids = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      const cId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.w} ${this.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cId} 0 R >>`));
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

    let out = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
    return bytes;
  }
}

// Bericht als PDF. "rep" kommt aus report.js.
// Der ausführliche Bericht (eine Zeile pro Arbeitsabschnitt) steht hochkant,
// die Übersicht (eine Zeile pro Arbeitsblock) im Querformat, weil sie mehr Spalten hat.
export function reportPdf(rep) {
  const doc = new Doc(!rep.detailed);
  const L = 40;
  const R = doc.w - 40;
  const FS = 9.5;
  const LH = 12;
  const PADX = 5;
  const BOTTOM = doc.h - 60;

  // Spalten: [Überschrift, Breite, rechtsbündig?]. Die letzte Spalte bekommt den restlichen Platz.
  const defs = rep.detailed
    ? [['Datum', 85], ['Von', 40], ['Bis', 40], ['Pause', 75], ['Stunden', 50, true], ['Tätigkeit (Stichworte)', 0]]
    : [['Datum', 85], ...(rep.all ? [['Arbeitsort', 115]] : []), ['Kategorie', 120], ['Von', 40], ['Bis', 40], ['Pause', 45], ['Stunden', 52, true], ['Notiz', 0]];
  const cols = [];
  let cx = L;
  for (const [label, w, right] of defs) {
    const width = w || R - cx;
    cols.push({ label, x: cx, w: width, right: !!right });
    cx += width;
  }
  const hours = cols.find((c) => c.label === 'Stunden');
  const afterHours = cols[cols.indexOf(hours) + 1];

  let y = 0;
  const header = (first, withTable = true) => {
    doc.page();
    y = 52;
    if (first) {
      doc.text(L, y, rep.title, { size: 16, bold: true });
      y += 20;
      if (rep.userName) {
        doc.text(L, y, rep.userName, { size: 11 });
        y += 15;
      }
      doc.text(L, y, rep.period.line, { size: 11 });
      y += 16;
    } else {
      doc.text(L, y, `${rep.title}, ${rep.label} (Fortsetzung)`, { size: 9, gray: 0.4 });
      y += 12;
    }
    if (!withTable) return;
    doc.rect(L, y, R - L, 20, 0.9);
    for (const c of cols) {
      if (c.right) doc.text(c.x + c.w - PADX, y + 13.5, c.label, { size: FS, bold: true, align: 'right' });
      else doc.text(c.x + PADX, y + 13.5, c.label, { size: FS, bold: true });
    }
    y += 20;
    doc.line(L, y, R, y, 0.45, 0.8);
  };

  const cellsOf = (row) => {
    if (row.type === 'work') return [row.date, fmtTime(row.from), fmtTime(row.to), '', fmtDur(row.ms), row.note];
    if (row.type === 'pause') return ['', '', '', `${fmtTime(row.from)}–${fmtTime(row.to)}`, '', ''];
    return [
      row.date,
      ...(rep.all ? [row.placeName] : []),
      row.category,
      fmtTime(row.from),
      fmtTime(row.to),
      row.pauseMs > 0 ? fmtDur(row.pauseMs) : '',
      fmtDur(row.ms),
      row.note,
    ];
  };

  header(true);

  const prepared = rep.rows.map((row) => {
    const lines = cellsOf(row).map((txt, i) => doc.wrap(txt, cols[i].w - 2 * PADX, FS, false));
    return { row, lines, h: Math.max(1, ...lines.map((l) => l.length)) * LH + 6 };
  });

  for (let i = 0; i < prepared.length; i++) {
    const { row, lines, h } = prepared[i];
    // Ein Arbeitsblock soll möglichst nicht über zwei Seiten verteilt werden.
    if (row.first) {
      let blockH = h;
      for (let k = i + 1; k < prepared.length && !prepared[k].row.first; k++) blockH += prepared[k].h;
      if (y + blockH > BOTTOM && blockH < BOTTOM - 120) header(false);
    }
    if (y + h > BOTTOM) header(false);
    const base = y + 12.5;
    const gray = row.type === 'pause' ? 0.3 : 0;
    lines.forEach((cellLines, c) => {
      const col = cols[c];
      cellLines.forEach((ln, k) => {
        if (col.right) doc.text(col.x + col.w - PADX, base + k * LH, ln, { size: FS, align: 'right', gray });
        else doc.text(col.x + PADX, base + k * LH, ln, { size: FS, gray });
      });
    });
    y += h;
    doc.line(L, y, R, y, 0.82, 0.5);
  }

  if (y + 30 > BOTTOM) header(false);
  doc.line(L, y, R, y, 0.3, 1);
  y += 17;
  doc.text(L + PADX, y, rep.period.sumLabel, { size: 10.5, bold: true });
  doc.text(hours.x + hours.w - PADX, y, fmtDur(rep.totalMs), { size: 10.5, bold: true, align: 'right' });
  doc.text(afterHours.x + PADX, y, 'Stunden', { size: 10.5 });

  // In der Übersicht zusätzlich: Summen je Arbeitsort und je Kategorie
  // Die beiden Listen stehen nebeneinander.
  if (!rep.detailed) {
    const sections = [];
    if (rep.all && rep.byPlace.length) sections.push(['Summe je Arbeitsort (Stunden)', rep.byPlace]);
    if (rep.byCategory.length) sections.push(['Summe je Kategorie (Stunden)', rep.byCategory]);
    const W = 330;
    const rowsMax = Math.max(0, ...sections.map((s) => s[1].length));
    if (y + 34 + rowsMax * 15 > BOTTOM) {
      header(false, false);
      y += 14;
    } else y += 26;
    sections.forEach(([title, items], n) => {
      const x = L + n * (W + 40);
      let sy = y;
      doc.text(x + PADX, sy, title, { size: 10.5, bold: true });
      sy += 6;
      doc.line(x, sy, x + W, sy, 0.45, 0.8);
      for (const it of items) {
        sy += 15;
        doc.text(x + PADX, sy - 3.5, it.name, { size: FS });
        doc.text(x + W - PADX, sy - 3.5, fmtDur(it.ms), { size: FS, align: 'right' });
        doc.line(x, sy, x + W, sy, 0.82, 0.5);
      }
    });
  }

  // Fußzeile auf jeder Seite
  const d = new Date();
  const stamp = `Erstellt am ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  doc.pages.forEach((ops, i) => {
    doc.ops = ops;
    doc.text(L, doc.h - 32, stamp, { size: 8, gray: 0.5 });
    doc.text(R, doc.h - 32, `Seite ${i + 1} von ${doc.pages.length}`, { size: 8, gray: 0.5, align: 'right' });
  });

  return doc.build(`${rep.title}, ${rep.label}`);
}

// Erzeugt Excel-Dateien (.xlsx) direkt in der App, ohne fremde Programmbibliothek und ohne Internet.
// Eine .xlsx-Datei ist ein ZIP-Archiv mit einigen Textdateien darin.

import { fmtTime } from './model.js';

// ---------- ZIP (ohne Komprimierung, die Dateien sind winzig) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const local = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    local.push(new Uint8Array(lh.buffer), name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ---------- Excel-Inhalt ----------

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

const xml = (s) =>
  String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Formatvorlagen (die Nummer ist die Position in cellXfs unten)
export const STYLE = { plain: 0, title: 1, head: 2, text: 3, time: 4, dur: 5, boldText: 6, boldDur: 7 };

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="${NS}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="hh:mm"/><numFmt numFmtId="165" formatCode="[h]:mm"/></numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE1EFE6"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFB0B8BC"/></left><right style="thin"><color rgb="FFB0B8BC"/></right><top style="thin"><color rgb="FFB0B8BC"/></top><bottom style="thin"><color rgb="FFB0B8BC"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const colName = (i) => String.fromCharCode(65 + i);

// Eine Zelle ist: null (leer), Text, Zahl oder { v, s, f } mit Wert, Formatvorlage und Formel.
function cellXml(ref, cell) {
  if (cell == null) return '';
  const c = typeof cell === 'object' ? cell : { v: cell };
  const s = c.s ? ` s="${c.s}"` : '';
  if (c.f) return `<c r="${ref}"${s}><f>${xml(c.f)}</f><v>${c.v}</v></c>`;
  if (c.v == null || c.v === '') return c.s ? `<c r="${ref}"${s}/>` : '';
  if (typeof c.v === 'number') return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(c.v)}</t></is></c>`;
}

function sheetXml(sheet) {
  const cols = sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row.map((cell, c) => cellXml(`${colName(c)}${r + 1}`, cell)).join('');
      return cells ? `<row r="${r + 1}">${cells}</row>` : '';
    })
    .join('');
  return `${XML_HEAD}<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols>${cols}</cols><sheetData>${rows}</sheetData><pageMargins left="0.6" right="0.6" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${sheet.landscape ? 'landscape' : 'portrait'}"/></worksheet>`;
}

// Excel erlaubt in Blattnamen höchstens 31 Zeichen und einige Zeichen gar nicht.
const sheetName = (s) => String(s).replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'Tabelle';

export function makeXlsx(sheets) {
  const files = [
    {
      name: '[Content_Types].xml',
      text: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      text: `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      text: `${XML_HEAD}<workbook xmlns="${NS}" xmlns:r="${NS_REL}"><sheets>${sheets
        .map((s, i) => `<sheet name="${xml(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: `${XML_HEAD}<Relationships xmlns="${NS_PKG}">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', text: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s) })),
  ];
  return zip(files);
}

// Uhrzeit als Excel-Zahl (Anteil eines Tages), damit Excel damit rechnen kann
function clock(ts) {
  const d = new Date(ts);
  return (d.getHours() * 60 + d.getMinutes()) / 1440;
}

// Ein Tabellenblatt für einen Bericht. "rep" kommt aus report.js.
export function reportSheet(rep) {
  const S = STYLE;
  const T = (v) => ({ v, s: S.text });
  const heads = rep.detailed
    ? ['Datum', 'Von', 'Bis', 'Pause', 'Stunden', 'Tätigkeit (Stichworte)']
    : ['Datum', ...(rep.all ? ['Arbeitsort'] : []), 'Kategorie', 'Von', 'Bis', 'Pause', 'Stunden', 'Notiz'];
  const widths = rep.detailed ? [16, 8, 8, 14, 10, 48] : [17, ...(rep.all ? [24] : []), 24, 8, 8, 8, 10, 48];
  const hoursIdx = heads.indexOf('Stunden');

  const rows = [
    [{ v: rep.title, s: S.title }],
    [rep.userName ? `Name: ${rep.userName}` : null],
    [rep.period.line],
    [],
    heads.map((v) => ({ v, s: S.head })),
  ];
  const firstData = rows.length + 1;
  for (const r of rep.rows) {
    if (r.type === 'work') {
      rows.push([T(r.date), { v: clock(r.from), s: S.time }, { v: clock(r.to), s: S.time }, T(''), { v: r.ms / 86400000, s: S.dur }, T(r.note)]);
    } else if (r.type === 'pause') {
      rows.push([T(''), T(''), T(''), T(`${fmtTime(r.from)}–${fmtTime(r.to)}`), T(''), T('')]);
    } else {
      rows.push([
        T(r.date),
        ...(rep.all ? [T(r.placeName)] : []),
        T(r.category),
        { v: clock(r.from), s: S.time },
        { v: clock(r.to), s: S.time },
        r.pauseMs > 0 ? { v: r.pauseMs / 86400000, s: S.dur } : { v: '', s: S.dur },
        { v: r.ms / 86400000, s: S.dur },
        T(r.note),
      ]);
    }
  }
  const lastData = rows.length;
  const col = colName(hoursIdx);
  const sumRow = heads.map(() => ({ v: '', s: S.boldText }));
  sumRow[0] = { v: rep.period.sumLabel, s: S.boldText };
  sumRow[hoursIdx] = { v: rep.totalMs / 86400000, s: S.boldDur };
  if (lastData >= firstData) sumRow[hoursIdx].f = `SUM(${col}${firstData}:${col}${lastData})`;
  rows.push(sumRow);

  // In der Übersicht zusätzlich: Summen je Arbeitsort und je Kategorie
  const section = (title, items) => {
    rows.push([], [{ v: title, s: S.boldText }, { v: 'Stunden', s: S.boldText }]);
    for (const it of items) rows.push([T(it.name), { v: it.ms / 86400000, s: S.dur }]);
  };
  if (!rep.detailed) {
    if (rep.all && rep.byPlace.length) section('Summe je Arbeitsort', rep.byPlace);
    if (rep.byCategory.length) section('Summe je Kategorie', rep.byCategory);
  }

  return { name: rep.label.replace(/\//g, '-'), widths, rows, landscape: !rep.detailed };
}

export function reportXlsx(rep) {
  return makeXlsx([reportSheet(rep)]);
}

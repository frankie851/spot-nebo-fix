#!/usr/bin/env node
// Stáhne z oficiálních zdrojů data za posledních 12 celých kalendářních měsíců a uloží je do data/:
//   data/prices.json  – ceny denního trhu OTE (EUR/MWh) po čtvrthodinách
//   data/fx.json      – kurz EUR/CZK ČNB pro každý kalendářní den
//   data/tdd/*.json   – normalizované TDD OTE (relativní koeficienty × 10 000)
//   data/meta.json    – období, datum stažení a zdroje
//
// Spuštění:  node scripts/update-data.mjs            (inkrementálně – stáhne jen chybějící dny)
//            node scripts/update-data.mjs --full     (vše znovu)
//            node scripts/update-data.mjs --to 2026-10-31   (konec období, jinak poslední celý měsíc)
// Za proxy (např. firemní síť) spusťte s NODE_USE_ENV_PROXY=1 (Node ≥ 22.21).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, eachDay, quartersInDay, buildQuarterGrid } from '../calc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

const SRC = {
  ote: (d) => `https://www.ote-cr.cz/pw-data/chart-data/01?language=cs&report_date=${d}`,
  otePage: 'https://www.ote-cr.cz/cs/kratkodobe-trhy/elektrina/denni-trh',
  cnb: (y) => `https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt?rok=${y}`,
  tdd: (y) => `https://www.ote-cr.cz/pubweb/attachments/20/${y}/Normalizovane_TDD_15MIN_${y}_CZ.zip`,
  tddPage: 'https://www.ote-cr.cz/cs/statistika/typove-diagramy-dodavek-elektriny/normalizovane-tdd',
};

// Sloupce XLSX → klíče souborů. TDD4 = D01d/D02d, TDD5 = akumulace (regionálně), TDD6 = přímotop/TČ, TDD7 = D61d.
const TDD_COLUMNS = {
  'TDD4 ČR': 'TDD4',
  'TDD5 Jižní Čechy': 'TDD5-JC', 'TDD5 Jižní Morava': 'TDD5-JM', 'TDD5 Praha': 'TDD5-P',
  'TDD5 Severní Čechy': 'TDD5-SC', 'TDD5 Severní Morava': 'TDD5-SM', 'TDD5 Střední Čechy': 'TDD5-STC',
  'TDD5 Východní Čechy': 'TDD5-VC', 'TDD5 Západní Čechy': 'TDD5-ZC',
  'TDD6 ČR': 'TDD6', 'TDD7 ČR': 'TDD7',
};

const args = process.argv.slice(2);
const FULL = args.includes('--full');
const argTo = args.includes('--to') ? args[args.indexOf('--to') + 1] : null;

// ---------------------------------------------------------------------------
// Pomocné funkce
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { binary = false, tries = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'spot-nebo-fix-data-updater' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`Stažení selhalo: ${url} (${lastErr?.message})`);
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

/** Zapíše soubor jen při změně obsahu, aby GitHub Action necommitovala zbytečně. */
async function writeIfChanged(path, obj) {
  const text = JSON.stringify(obj) + '\n';
  const old = existsSync(path) ? await readFile(path, 'utf8') : null;
  if (old === text) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return true;
}

function lastCompleteMonthEnd(today = new Date()) {
  const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return new Date(firstOfMonth - 864e5).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// OTE – denní trh
// ---------------------------------------------------------------------------

/** Vrátí čtvrthodinové ceny dne (EUR/MWh). Hodinové období (do 30. 9. 2025) rozepíše na 4 čtvrthodiny. */
async function fetchOteDay(date) {
  const json = JSON.parse(await get(SRC.ote(date)));
  const lines = json?.data?.dataLine ?? [];
  const q = lines.find((l) => /^15min cena/i.test(l.title));
  const h = lines.find((l) => /^Cena \(EUR\/MWh\)/i.test(l.title)) ?? lines.find((l) => /^60min cena/i.test(l.title));
  const expected = quartersInDay(date);
  let prices;
  if (q) {
    prices = q.point.map((p) => +p.y);
  } else if (h && h.point.length * 4 === expected) {
    prices = h.point.flatMap((p) => [+p.y, +p.y, +p.y, +p.y]);
  } else {
    throw new Error(`OTE ${date}: neznámý formát (${lines.map((l) => l.title).join(', ')})`);
  }
  if (prices.length !== expected) throw new Error(`OTE ${date}: ${prices.length} period, očekáváno ${expected}`);
  if (prices.some((p) => !Number.isFinite(p))) throw new Error(`OTE ${date}: neplatná cena`);
  return prices.map((p) => Math.round(p * 100) / 100);
}

// ---------------------------------------------------------------------------
// ČNB – kurzy
// ---------------------------------------------------------------------------

/** Parsuje rok.txt: hlavička "Datum|1 AUD|…|1 EUR|…" se může v roce opakovat při změně měn. */
export function parseCnbYear(text) {
  const rates = {};
  let col = -1, amount = 1;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split('|');
    if (cells[0] === 'Datum') {
      col = cells.findIndex((c) => / EUR$/.test(c));
      amount = col >= 0 ? +cells[col].split(' ')[0] : 1;
      continue;
    }
    if (col < 0) continue;
    const [d, m, y] = cells[0].split('.');
    const v = +String(cells[col]).replace(',', '.');
    if (y && Number.isFinite(v)) rates[`${y}-${m}-${d}`] = v / amount;
  }
  return rates;
}

// ---------------------------------------------------------------------------
// TDD – ZIP s XLSX (bez externích závislostí)
// ---------------------------------------------------------------------------

/** Minimální čtečka ZIP: vrací Map(název → Buffer). */
function unzip(buf) {
  const files = new Map();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Neplatný ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + size);
    files.set(name, method === 0 ? data : inflateRawSync(data));
    p += 46 + nameLen + extraLen + commLen;
  }
  return files;
}

const xmlText = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Načte list normalizovaných TDD: vrací { [klíč]: { [datum]: number[] } }. */
function parseTddXlsx(xlsx) {
  const files = unzip(xlsx);
  const sst = [...files.get('xl/sharedStrings.xml').toString('utf8').matchAll(/<si>(.*?)<\/si>/gs)].map((m) => xmlText(m[1]));
  const sheet = files.get('xl/worksheets/sheet1.xml').toString('utf8');
  const out = Object.fromEntries(Object.values(TDD_COLUMNS).map((k) => [k, {}]));
  let header = null;
  for (const m of sheet.matchAll(/<row r="\d+"[^>]*>(.*?)<\/row>/gs)) {
    const cells = {};
    for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const v = /<v>(.*?)<\/v>/s.exec(c[3] ?? '');
      if (!v) continue;
      cells[c[1]] = /t="s"/.test(c[2]) ? sst[+v[1]] : +v[1];
    }
    if (cells.A === 'Den') {
      header = {};
      for (const [col, name] of Object.entries(cells)) {
        const key = TDD_COLUMNS[String(name).replace(/\s+/g, ' ').trim()];
        if (key) header[col] = key;
      }
      continue;
    }
    if (!header || typeof cells.A !== 'number' || typeof cells.B !== 'number') continue;
    const date = new Date(Date.UTC(1899, 11, 30) + cells.A * 864e5).toISOString().slice(0, 10);
    for (const [col, key] of Object.entries(header)) {
      (out[key][date] ??= [])[cells.B - 1] = cells[col];
    }
  }
  if (!header || Object.keys(header).length !== Object.keys(TDD_COLUMNS).length) {
    throw new Error('TDD: v XLSX chybí očekávané sloupce');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hlavní běh
// ---------------------------------------------------------------------------

async function main() {
  const to = argTo ?? lastCompleteMonthEnd();
  // 12 celých měsíců končících dnem `to`: začátek = 1. den měsíce o 11 měsíců dřív.
  const [ty, tm] = [+to.slice(0, 4), +to.slice(5, 7)];
  const start = tm === 12 ? `${ty}-01-01` : `${ty - 1}-${String(tm + 1).padStart(2, '0')}-01`;
  const days = eachDay(start, to);
  console.log(`Období: ${start} – ${to} (${days.length} dní)`);
  const grid = buildQuarterGrid(start, to);

  // --- OTE ---------------------------------------------------------------
  const old = FULL ? null : await readJson(join(DATA, 'prices.json'), null);
  const cache = new Map();
  if (old?.days) for (const [d, arr] of Object.entries(old.days)) cache.set(d, arr);
  const missing = days.filter((d) => !cache.has(d));
  console.log(`OTE: ${days.length - missing.length} dní z mezipaměti, stahuji ${missing.length}…`);
  let done = 0;
  await pool(missing, 6, async (d) => {
    cache.set(d, await fetchOteDay(d));
    if (++done % 50 === 0) console.log(`  ${done}/${missing.length}`);
  });
  const priceDays = Object.fromEntries(days.map((d) => [d, cache.get(d)]));
  const flatPrices = days.flatMap((d) => priceDays[d]);
  if (flatPrices.length !== grid.length) throw new Error(`OTE: ${flatPrices.length} čtvrthodin ≠ mřížka ${grid.length}`);

  // --- ČNB ---------------------------------------------------------------
  // Pro dny bez vyhlášení (víkend, svátek, 1. leden) platí poslední vyhlášený kurz,
  // proto stahujeme i rok před začátkem období.
  const firstYear = +start.slice(0, 4);
  const years = [firstYear - 1, ...new Set(days.map((d) => +d.slice(0, 4)))];
  const published = {};
  for (const y of new Set(years)) Object.assign(published, parseCnbYear(await get(SRC.cnb(y))));
  const fx = {};
  let last = null;
  for (const d of eachDay(addDays(start, -10), to)) {
    if (published[d]) last = published[d];
    if (d >= start) {
      if (!last) throw new Error(`ČNB: chybí kurz pro ${d}`);
      fx[d] = last;
    }
  }

  // --- TDD ---------------------------------------------------------------
  const tddMeta = await readJson(join(DATA, 'tdd', 'index.json'), null);
  let tddChanged = false;
  if (FULL || !tddMeta || tddMeta.from !== start || tddMeta.to !== to) {
    const tddYears = [...new Set(days.map((d) => +d.slice(0, 4)))];
    const merged = Object.fromEntries(Object.values(TDD_COLUMNS).map((k) => [k, {}]));
    for (const y of tddYears) {
      console.log(`TDD: stahuji normalizované TDD ${y}…`);
      const zip = unzip(await get(SRC.tdd(y), { binary: true }));
      const [, xlsx] = [...zip.entries()].find(([n]) => /\.xlsx$/i.test(n));
      const parsed = parseTddXlsx(xlsx);
      for (const k of Object.keys(merged)) Object.assign(merged[k], parsed[k]);
    }
    const classes = {};
    for (const [key, byDay] of Object.entries(merged)) {
      const flat = [];
      for (const d of days) {
        const arr = byDay[d];
        if (!arr || arr.length !== quartersInDay(d) || arr.some((v) => !Number.isFinite(v))) {
          throw new Error(`TDD ${key} ${d}: ${arr?.length ?? 0} hodnot, očekáváno ${quartersInDay(d)}`);
        }
        flat.push(...arr.map((v) => Math.round(v * 10000)));
      }
      if (flat.length !== grid.length) throw new Error(`TDD ${key}: délka ≠ mřížka`);
      tddChanged = (await writeIfChanged(join(DATA, 'tdd', `${key}.json`), { key, from: start, to, scale: 10000, values: flat })) || tddChanged;
      classes[key] = flat.length;
    }
    tddChanged = (await writeIfChanged(join(DATA, 'tdd', 'index.json'), {
      from: start, to, source: SRC.tddPage, files: tddYears.map(SRC.tdd), classes,
    })) || tddChanged;
  } else {
    console.log('TDD: období beze změny, používám uložená data');
  }

  // --- Zápis -------------------------------------------------------------
  const pricesChanged = await writeIfChanged(join(DATA, 'prices.json'), {
    unit: 'EUR/MWh', resolution: '15min', from: start, to, source: SRC.otePage, days: priceDays,
  });
  const fxChanged = await writeIfChanged(join(DATA, 'fx.json'), {
    unit: 'CZK/EUR', from: start, to, source: 'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/', rates: fx,
  });
  const changed = pricesChanged || fxChanged || tddChanged;
  if (changed || !existsSync(join(DATA, 'meta.json'))) {
    await writeIfChanged(join(DATA, 'meta.json'), {
      from: start, to, lastPriceDay: to, quarters: grid.length,
      generated: new Date().toISOString().slice(0, 10),
      sources: { prices: SRC.otePage, fx: SRC.cnb('RRRR'), tdd: SRC.tddPage },
    });
  }
  console.log(changed ? 'Data aktualizována.' : 'Beze změny.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });

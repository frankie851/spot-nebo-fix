// calc.js – výpočty bez vazby na DOM (běží v prohlížeči i v Node).
// Všechny ceny v tomto modulu jsou "jednotkově neutrální": funkce násobí a sčítají,
// o DPH rozhoduje volající (app.js převádí sazby bez DPH na ceny vč. DPH přes withVat()).

export const TZ = 'Europe/Prague';
export const QUARTER_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Čas a kalendář
// ---------------------------------------------------------------------------

const dtf = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Lokální (pražský) čas pro UTC milisekundy. */
export function localParts(ms) {
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(ms))) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute,
  };
}

/** UTC milisekundy lokální půlnoci daného dne (YYYY-MM-DD). */
export function localMidnightUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // V ČR je posun +1 h nebo +2 h; vyzkoušíme oba a vezmeme ten, který dá 00:00.
  for (const off of [1, 2]) {
    const ms = Date.UTC(y, m - 1, d, -off);
    const lp = localParts(ms);
    if (lp.date === dateStr && lp.hour === 0 && lp.minute === 0) return ms;
  }
  throw new Error(`Nelze určit půlnoc pro ${dateStr}`);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Počet čtvrthodin v lokálním dni (92 / 96 / 100). */
export function quartersInDay(dateStr) {
  return Math.round((localMidnightUtc(addDays(dateStr, 1)) - localMidnightUtc(dateStr)) / QUARTER_MS);
}

/** Velikonoční neděle (anonymní gregoriánský algoritmus). */
export function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Státní svátky a ostatní svátky ČR (zákon č. 245/2000 Sb.). */
export function czechHolidays(year) {
  const fixed = ['01-01', '05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-24', '12-25', '12-26']
    .map((md) => `${year}-${md}`);
  const easter = easterSunday(year);
  return new Set([...fixed, addDays(easter, -2), addDays(easter, 1)]);
}

const holidayCache = new Map();
export function isHoliday(dateStr) {
  const y = +dateStr.slice(0, 4);
  if (!holidayCache.has(y)) holidayCache.set(y, czechHolidays(y));
  return holidayCache.get(y).has(dateStr);
}

/**
 * Čtvrthodinová mřížka v lokálním čase od `from` do `to` (včetně, YYYY-MM-DD).
 * Vrací pole objektů { date, month: 'YYYY-MM', hour, minute, weekend, summer, dayIdx }.
 * Den přechodu na letní čas má 92 čtvrthodin, na zimní 100.
 */
export function buildQuarterGrid(from, to) {
  const days = eachDay(from, to);
  const grid = [];
  days.forEach((date, dayIdx) => {
    const start = localMidnightUtc(date);
    const n = Math.round((localMidnightUtc(addDays(date, 1)) - start) / QUARTER_MS);
    const [y, m, d] = date.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const weekend = dow === 0 || dow === 6 || isHoliday(date);
    const summer = m >= 4 && m <= 9;
    let lp = null;
    for (let q = 0; q < n; q++) {
      const ms = start + q * QUARTER_MS;
      // Lokální čas stačí počítat jednou za hodinu UTC (posun se mění jen na celou hodinu).
      if (q % 4 === 0) lp = localParts(ms);
      grid.push({ date, month: date.slice(0, 7), hour: lp.hour, minute: (q % 4) * 15, weekend, summer, dayIdx });
    }
  });
  return grid;
}

/** Indexy začátků dnů v mřížce (pro operace po dnech). */
export function dayRanges(grid) {
  const ranges = [];
  for (let i = 0; i < grid.length; i++) {
    if (i === 0 || grid[i].dayIdx !== grid[i - 1].dayIdx) ranges.push([i, i]);
    ranges[ranges.length - 1][1] = i + 1;
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Obecné pomocné funkce
// ---------------------------------------------------------------------------

export function sum(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

export const withVat = (amount, vat) => amount * (1 + vat);

/** Normalizuje řadu tak, aby součet byl 1 (TDD jsou v souboru relativní koeficienty). */
export function normalize(values) {
  const s = sum(values);
  if (!(s > 0)) throw new Error('Nelze normalizovat nulovou řadu');
  return values.map((v) => v / s);
}

/** Spotřeba po čtvrthodinách (MWh) = roční spotřeba × normalizovaný TDD. */
export function consumptionProfile(annualMWh, tddValues) {
  return normalize(tddValues).map((v) => v * annualMWh);
}

// ---------------------------------------------------------------------------
// Ceny
// ---------------------------------------------------------------------------

/** Fix: spotřeba × cena silové elektřiny. */
export function energyFix(cons, pricePerMWh) {
  return sum(cons) * pricePerMWh;
}

/** Spot: Σ spotřeba × cena (EUR/MWh) × kurz (Kč/EUR). */
export function energySpot(cons, pricesEur, fx) {
  let s = 0;
  for (let i = 0; i < cons.length; i++) s += cons[i] * pricesEur[i] * fx[i];
  return s;
}

/** Dynamický tarif: Σ spotřeba × základní cena × (1 + odchylka pásma). */
export function energyDynamic(cons, pctPerQ, basePrice) {
  let s = 0;
  for (let i = 0; i < cons.length; i++) s += cons[i] * basePrice * (1 + pctPerQ[i] / 100);
  return s;
}

/** Proměnné regulované složky: distribuce VT/NT + složky za MWh (daň, systémové služby…). */
export function regulatedVariable(cons, ntMask, vt, nt, perMWh) {
  let s = 0;
  for (let i = 0; i < cons.length; i++) s += cons[i] * ((ntMask && ntMask[i] ? nt : vt) + perMWh);
  return s;
}

/** POZE: zákazník platí nižší z (spotřeba × Kč/MWh) a (měsíční platba podle jističe × počet měsíců). */
export function pozeAnnual(totalMWh, poze, months = 12) {
  return Math.min(totalMWh * poze.perMWh, poze.monthly * months);
}

function inWindows(hour, windows) {
  return windows.some(([from, to]) => hour >= from && hour < to);
}

/** Maska nízkého tarifu podle oken NT ({ workday: [[od, do]…], weekend: […] }). */
export function ntMaskFor(grid, windows) {
  if (!windows) return null;
  return grid.map((q) => (inWindows(q.hour, q.weekend ? windows.weekend : windows.workday) ? 1 : 0));
}

/** Odchylka pásma dynamického tarifu (%) pro každou čtvrthodinu. */
export function dynamicPctPerQuarter(grid, product) {
  const seasons = Object.values(product.seasons);
  return grid.map((q) => {
    const m = +q.month.slice(5, 7);
    const season = seasons.find((s) => s.months.includes(m));
    const band = (q.weekend ? season.weekend : season.workday).find((b) => q.hour >= b.from && q.hour < b.to);
    if (!band) throw new Error(`Chybí pásmo pro ${q.date} ${q.hour}:00`);
    return band.pct;
  });
}

// ---------------------------------------------------------------------------
// Posun spotřeby
// ---------------------------------------------------------------------------

/**
 * Přesune podíl `frac` (0–1) denní spotřeby do `k` nejlevnějších čtvrthodin téhož dne podle `rank`
 * (nižší = levnější). Každá čtvrthodina odevzdá stejný podíl své spotřeby, přesunutá energie
 * se rozdělí rovným dílem. Denní i roční součet zůstává stejný.
 */
export function shiftLoad(cons, rank, frac, ranges, k = 16) {
  if (!frac) return cons.slice();
  const out = cons.map((v) => v * (1 - frac));
  for (const [a, b] of ranges) {
    let moved = 0;
    for (let i = a; i < b; i++) moved += cons[i] * frac;
    const idx = [];
    for (let i = a; i < b; i++) idx.push(i);
    idx.sort((x, y) => rank[x] - rank[y] || x - y);
    const n = Math.min(k, idx.length);
    for (let j = 0; j < n; j++) out[idx[j]] += moved / n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Výpočet tří variant
// ---------------------------------------------------------------------------

/**
 * Spočítá roční a měsíční náklady pro fix, spot a dynamický tarif.
 * Vstupní jednotkové ceny jsou bez DPH (Kč/MWh, Kč/měsíc), výsledky jsou × (1 + vat).
 *
 * @param {object} p
 * @param {object[]} p.grid      čtvrthodinová mřížka (buildQuarterGrid)
 * @param {number[]} p.cons      spotřeba MWh po čtvrthodinách
 * @param {number[]} p.spotEur   spotová cena EUR/MWh po čtvrthodinách
 * @param {number[]} p.fx        kurz Kč/EUR po čtvrthodinách
 * @param {number}   p.vat       sazba DPH (0.21)
 * @param {object}   p.regulated { vt, nt, ntMask, perMWh, monthly, poze: { perMWh, monthly } }
 * @param {object}   p.fix       { price, monthlyFee }
 * @param {object}   p.spot      { margin, monthlyFee }
 * @param {object}   p.dynamic   { base, pct[], monthlyFee }
 * @param {number}   p.shiftPct  0–30 % přesunu do nejlevnějších hodin (jen spot a dynamický tarif)
 */
export function computeVariants(p) {
  const { grid, cons, spotEur, fx, vat, regulated, shiftPct = 0 } = p;
  const n = grid.length;
  if (cons.length !== n || spotEur.length !== n || fx.length !== n) throw new Error('Délky řad nesouhlasí s mřížkou');
  const months = [...new Set(grid.map((q) => q.month))];
  const monthIdx = new Map(months.map((m, i) => [m, i]));
  const ranges = dayRanges(grid);
  const spotKc = spotEur.map((e, i) => e * fx[i]);
  const frac = Math.max(0, Math.min(30, shiftPct)) / 100;

  const defs = {
    fix: { cons, unit: () => p.fix.price, monthlyFee: p.fix.monthlyFee },
    spot: {
      cons: shiftLoad(cons, spotKc, frac, ranges),
      unit: (i) => spotKc[i] + p.spot.margin, monthlyFee: p.spot.monthlyFee,
    },
    dynamic: {
      cons: shiftLoad(cons, p.dynamic.pct, frac, ranges),
      unit: (i) => p.dynamic.base * (1 + p.dynamic.pct[i] / 100), monthlyFee: p.dynamic.monthlyFee,
    },
  };

  const variants = {};
  for (const [name, d] of Object.entries(defs)) {
    const m = months.map(() => ({ energy: 0, regulated: 0, fixedFees: 0, poze: 0, mwh: 0 }));
    for (let i = 0; i < n; i++) {
      const c = d.cons[i];
      const row = m[monthIdx.get(grid[i].month)];
      row.mwh += c;
      row.energy += c * d.unit(i);
      row.regulated += c * ((regulated.ntMask && regulated.ntMask[i] ? regulated.nt : regulated.vt) + regulated.perMWh);
    }
    const totalMWh = sum(m.map((r) => r.mwh));
    const pozeByMWh = totalMWh * regulated.poze.perMWh <= regulated.poze.monthly * months.length;
    for (const r of m) {
      r.fixedFees = regulated.monthly + d.monthlyFee;
      r.poze = pozeByMWh ? r.mwh * regulated.poze.perMWh : regulated.poze.monthly;
    }
    const k = 1 + vat;
    const monthly = m.map((r) => (r.energy + r.regulated + r.fixedFees + r.poze) * k);
    variants[name] = {
      total: sum(monthly),
      energy: sum(m.map((r) => r.energy)) * k,
      regulated: sum(m.map((r) => r.regulated + r.poze)) * k,
      fixedFees: sum(m.map((r) => r.fixedFees)) * k,
      totalMWh,
      monthly,
      cons: d.cons,
    };
  }
  return { months, variants };
}

/** Průměr hodnot podle hodiny dne (0–23), volitelně vážený. */
export function hourlyAverage(grid, values, weights = null) {
  const s = new Array(24).fill(0), w = new Array(24).fill(0);
  grid.forEach((q, i) => {
    const wt = weights ? weights[i] : 1;
    s[q.hour] += values[i] * wt;
    w[q.hour] += wt;
  });
  return s.map((v, h) => (w[h] ? v / w[h] : 0));
}

/** Podíl spotřeby v jednotlivých hodinách dne (součet = 1). */
export function hourlyShare(grid, cons) {
  const s = new Array(24).fill(0);
  grid.forEach((q, i) => { s[q.hour] += cons[i]; });
  const t = sum(s);
  return s.map((v) => (t ? v / t : 0));
}

// ---------------------------------------------------------------------------
// CSV s průběhovým měřením (zpracování jen v prohlížeči)
// ---------------------------------------------------------------------------

function splitCsvLine(line, delim) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Načte CSV: rozpozná oddělovač (; tabulátor ,), první neprázdný řádek je hlavička. */
export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [], delimiter: ';' };
  const first = lines[0];
  const delimiter = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
  return {
    headers: splitCsvLine(first, delimiter),
    rows: lines.slice(1).map((l) => splitCsvLine(l, delimiter)),
    delimiter,
  };
}

export function parseNumber(s) {
  let t = String(s ?? '').replace(/[\s ]/g, '').replace(/[^\d,.\-eE+]/g, '');
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(',', '.');
  return t === '' ? NaN : Number(t);
}

/** Čas z CSV → { date: 'YYYY-MM-DD', min: minuty od půlnoci } v lokálním čase. */
export function parseTime(s) {
  const str = String(s ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(str);
  if (m) {
    if (m[6]) {
      const lp = localParts(Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}:00${m[6] === 'Z' ? 'Z' : m[6].replace(/(\d{2})(\d{2})$/, '$1:$2')}`));
      return { date: lp.date, min: lp.hour * 60 + lp.minute };
    }
    return fixDay(`${m[1]}-${m[2]}-${m[3]}`, +m[4] * 60 + +m[5]);
  }
  m = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\s+(\d{1,2}):(\d{2})/.exec(str);
  if (m) return fixDay(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, +m[4] * 60 + +m[5]);
  return null;
}

function fixDay(date, min) {
  return min >= 1440 ? { date: addDays(date, 1), min: min - 1440 } : { date, min };
}

const naiveMinutes = (t) => {
  const [y, mo, d] = t.date.split('-').map(Number);
  return Date.UTC(y, mo - 1, d) / 60000 + t.min;
};

/**
 * Převede řádky CSV na čtvrthodinovou spotřebu (MWh) v mřížce. Data se párují podle data bez roku
 * (MM-DD HH:MM), takže lze použít i měření z jiného roku. Bere se posledních 12 měsíců CSV.
 * Chybějící čtvrthodiny se doplní podle TDD ve stejném poměru jako naměřená data.
 *
 * @param {string[][]} rows
 * @param {{timeCol:number, valueCol:number, timeIsEnd:boolean, unit:'kWh'|'kW'}} opt
 */
export function profileFromCsv(rows, opt, grid, tddValues) {
  const recs = [];
  for (const r of rows) {
    const t = parseTime(r[opt.timeCol]);
    const v = parseNumber(r[opt.valueCol]);
    if (t && Number.isFinite(v)) recs.push({ t, v, n: naiveMinutes(t) });
  }
  if (!recs.length) throw new Error('V CSV jsem nenašel žádné řádky s časem a hodnotou.');
  // Interval: medián rozdílů sousedních časů (v původním pořadí – zachová duplicitní hodinu při změně času).
  const diffs = [];
  for (let i = 1; i < recs.length; i++) { const d = recs[i].n - recs[i - 1].n; if (d > 0) diffs.push(d); }
  diffs.sort((a, b) => a - b);
  const interval = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 15;
  if (![15, 30, 60].includes(interval)) throw new Error(`Nepodporovaný interval měření: ${interval} min (podporuji 15, 30 a 60 min).`);
  const maxN = Math.max(...recs.map((r) => r.n));
  const keep = recs.filter((r) => r.n > maxN - 365 * 1440);

  const gridIdx = new Map();
  const seenGrid = new Map();
  grid.forEach((q, i) => {
    const base = `${q.date.slice(5)} ${q.hour}:${q.minute}`;
    const occ = seenGrid.get(base) ?? 0;
    seenGrid.set(base, occ + 1);
    gridIdx.set(`${base}#${occ}`, i);
  });

  const cons = new Array(grid.length).fill(null);
  const seen = new Map();
  const parts = interval / 15;
  let matched = 0;
  for (const { t, v } of keep) {
    const kWh = opt.unit === 'kW' ? v * (interval / 60) : v;
    let start = opt.timeIsEnd ? t.min - interval : t.min;
    let date = t.date;
    if (start < 0) { start += 1440; date = addDays(date, -1); }
    for (let k = 0; k < parts; k++) {
      const mm = start + k * 15;
      const base = `${date.slice(5)} ${Math.floor(mm / 60)}:${mm % 60}`;
      const occ = seen.get(base) ?? 0;
      seen.set(base, occ + 1);
      const i = gridIdx.get(`${base}#${occ}`);
      if (i === undefined || cons[i] !== null) continue;
      cons[i] = kWh / parts / 1000;
      matched++;
    }
  }
  if (!matched) throw new Error('Žádný řádek CSV se nepodařilo přiřadit k období výpočtu.');
  let measured = 0, tddCovered = 0;
  cons.forEach((c, i) => { if (c !== null) { measured += c; tddCovered += tddValues[i]; } });
  const scale = tddCovered > 0 ? measured / tddCovered : 0;
  const filled = cons.map((c, i) => (c === null ? tddValues[i] * scale : c));
  return { cons: filled, matched, coverage: matched / grid.length, measuredMWh: measured, interval };
}

// ---------------------------------------------------------------------------
// Sestavení regulovaných složek z tariffs.json
// ---------------------------------------------------------------------------

/**
 * Z tariffs.json vybere ceny pro distributora, sazbu a jistič (vše bez DPH)
 * ve tvaru, který očekává computeVariants().
 */
export function regulatedFor(tariffs, grid, distributor, sazba, breakerId) {
  const rates = tariffs.distributors[distributor]?.sazby[sazba];
  const breaker = tariffs.breakers.find((b) => b.id === breakerId);
  if (!rates || !breaker) throw new Error(`Neznámá kombinace ${distributor} / ${sazba} / ${breakerId}`);
  const c = tariffs.common;
  const ntWindows = rates.nt != null ? tariffs.ntHours[sazba] : null;
  return {
    vt: rates.vt,
    nt: rates.nt ?? rates.vt,
    ntMask: ntMaskFor(grid, ntWindows),
    perMWh: c.electricityTax.value + c.systemServices.value,
    monthly: rates.breaker[breaker.tier] + c.nonNetworkInfra.value,
    poze: { perMWh: c.poze.perMWh, monthly: c.poze.perAmpPhase * breaker.amps * breaker.phases },
  };
}

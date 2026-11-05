import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildQuarterGrid, quartersInDay, czechHolidays, easterSunday, dayRanges,
  normalize, consumptionProfile, energyFix, energySpot, energyDynamic, regulatedVariable,
  computeVariants, shiftLoad, dynamicPctPerQuarter, ntMaskFor, pozeAnnual,
  parseCsv, profileFromCsv, hourlyAverage, withVat, sum,
} from '../calc.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

// Mřížka dvou čtvrthodin pro jednoduché příklady.
const tinyGrid = buildQuarterGrid('2026-01-05', '2026-01-05').slice(0, 2);

const zeroRegulated = { vt: 0, nt: 0, ntMask: null, perMWh: 0, monthly: 0, poze: { perMWh: 0, monthly: 0 } };

test('fix: 3 MWh × (3 000 + 2 515,08) Kč/MWh = 16 545,24 Kč (bez stálých plateb)', () => {
  const cons = [1.5, 1.5];
  close(energyFix(cons, 3000) + regulatedVariable(cons, null, 2515.08, 0, 0), 16545.24);
  // Totéž přes celý výpočet variant (ceny už vč. DPH → vat 0, stálé platby 0).
  const r = computeVariants({
    grid: tinyGrid, cons, spotEur: [0, 0], fx: [25, 25], vat: 0,
    regulated: { ...zeroRegulated, vt: 2515.08 },
    fix: { price: 3000, monthlyFee: 0 }, spot: { margin: 0, monthlyFee: 0 },
    dynamic: { base: 0, pct: [0, 0], monthlyFee: 0 }, shiftPct: 0,
  });
  close(r.variants.fix.total, 16545.24);
});

test('spot: 2 × 0,5 MWh, ceny 100 a 0 EUR/MWh, kurz 25 Kč/EUR → silová elektřina 1 250 Kč', () => {
  close(energySpot([0.5, 0.5], [100, 0], [25, 25]), 1250);
  const r = computeVariants({
    grid: tinyGrid, cons: [0.5, 0.5], spotEur: [100, 0], fx: [25, 25], vat: 0,
    regulated: zeroRegulated, fix: { price: 0, monthlyFee: 0 }, spot: { margin: 0, monthlyFee: 0 },
    dynamic: { base: 0, pct: [0, 0], monthlyFee: 0 }, shiftPct: 0,
  });
  close(r.variants.spot.energy, 1250);
  close(r.variants.spot.total, 1250);
});

test('spot: marže se přičítá za každou MWh', () => {
  const r = computeVariants({
    grid: tinyGrid, cons: [0.5, 0.5], spotEur: [100, 0], fx: [25, 25], vat: 0,
    regulated: zeroRegulated, fix: { price: 0, monthlyFee: 0 }, spot: { margin: 300, monthlyFee: 0 },
    dynamic: { base: 0, pct: [0, 0], monthlyFee: 0 }, shiftPct: 0,
  });
  close(r.variants.spot.energy, 1250 + 300);
});

test('dynamický tarif: celá spotřeba v pásmu −50 % → polovina základní ceny', () => {
  const cons = [0.7, 0.3];
  close(energyDynamic(cons, [-50, -50], 3900), 0.5 * 3900 * 1);
  close(energyDynamic(cons, [0, 0], 3900), 3900);
});

test('dynamický tarif: pásma ČEZ podle sezóny a dne', () => {
  const dyn = readJson('../dynamic.json');
  const product = dyn.products[dyn.default];
  const g = buildQuarterGrid('2026-07-07', '2026-07-07'); // úterý, léto (6. 7. je svátek)
  const pct = dynamicPctPerQuarter(g, product);
  assert.equal(pct[3 * 4], -50);      // 03:00
  assert.equal(pct[12 * 4], -50);     // 12:00 v létě
  assert.equal(pct[6 * 4], 25);       // 06:00
  const w = dynamicPctPerQuarter(buildQuarterGrid('2026-01-05', '2026-01-05'), product);
  assert.equal(w[12 * 4], -10);       // 12:00 v zimě
  const sv = dynamicPctPerQuarter(buildQuarterGrid('2026-04-06', '2026-04-06'), product); // Velikonoční pondělí
  assert.equal(sv[6 * 4], 10);        // víkendové pásmo 5–11 h
});

test('den přechodu na letní čas má 92 čtvrthodin, na zimní 100', () => {
  assert.equal(quartersInDay('2026-03-29'), 92);
  assert.equal(quartersInDay('2026-10-25'), 100);
  assert.equal(quartersInDay('2025-10-26'), 100);
  assert.equal(quartersInDay('2026-06-15'), 96);
  const g = buildQuarterGrid('2026-03-29', '2026-03-29');
  assert.equal(g.length, 92);
  assert.ok(!g.some((q) => q.hour === 2), 'hodina 2:00 v den přechodu na letní čas neexistuje');
  const z = buildQuarterGrid('2026-10-25', '2026-10-25');
  assert.equal(z.filter((q) => q.hour === 2).length, 8, 'hodina 2:00 je při přechodu na zimní čas dvakrát');
  assert.equal(buildQuarterGrid('2025-11-01', '2026-10-31').length, 35040);
});

test('roční součet TDD = 1 a délka odpovídá mřížce', () => {
  const meta = readJson('../data/meta.json');
  const grid = buildQuarterGrid(meta.from, meta.to);
  for (const key of ['TDD4', 'TDD5-P', 'TDD6', 'TDD7']) {
    const tdd = readJson(`../data/tdd/${key}.json`);
    assert.equal(tdd.values.length, grid.length, key);
    close(sum(normalize(tdd.values)), 1, 1e-9);
  }
  const cons = consumptionProfile(3.5, readJson('../data/tdd/TDD4.json').values);
  close(sum(cons), 3.5, 1e-9);
});

test('data: ceny a kurzy pokrývají celé období', () => {
  const meta = readJson('../data/meta.json');
  const prices = readJson('../data/prices.json');
  const fx = readJson('../data/fx.json');
  const grid = buildQuarterGrid(meta.from, meta.to);
  const flat = Object.values(prices.days).flat();
  assert.equal(flat.length, grid.length);
  assert.ok(flat.every(Number.isFinite));
  for (const q of grid) assert.ok(fx.rates[q.date] > 20 && fx.rates[q.date] < 30, q.date);
});

test('svátky: Velikonoce 2026 a pevné svátky', () => {
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2025), '2025-04-20');
  const h = czechHolidays(2026);
  for (const d of ['2026-04-03', '2026-04-06', '2026-05-08', '2026-07-06', '2026-12-26']) assert.ok(h.has(d), d);
  assert.ok(!h.has('2026-04-07'));
});

// --- Posun spotřeby -------------------------------------------------------

function sampleCase(shiftPct) {
  const grid = buildQuarterGrid('2026-01-05', '2026-01-11');
  const cons = grid.map((q) => 0.0001 * (1 + (q.hour >= 17 && q.hour < 21 ? 2 : 0)));
  const spotEur = grid.map((q) => 50 + 100 * Math.sin((q.hour / 24) * Math.PI));
  const dyn = readJson('../dynamic.json');
  return computeVariants({
    grid, cons, spotEur, fx: grid.map(() => 25), vat: 0.21,
    regulated: { vt: 2000, nt: 0, ntMask: null, perMWh: 200, monthly: 150, poze: { perMWh: 495, monthly: 0 } },
    fix: { price: 3000, monthlyFee: 100 }, spot: { margin: 300, monthlyFee: 100 },
    dynamic: { base: 3223.14, pct: dynamicPctPerQuarter(grid, dyn.products[dyn.default]), monthlyFee: 135 },
    shiftPct,
  });
}

test('posun 0 % nemění výsledek', () => {
  const a = sampleCase(0);
  const grid = buildQuarterGrid('2026-01-05', '2026-01-11');
  const cons = grid.map(() => 1);
  assert.deepEqual(shiftLoad(cons, grid.map((_, i) => i), 0, dayRanges(grid)), cons);
  const b = sampleCase(0);
  assert.deepEqual(a, b);
  close(a.variants.spot.totalMWh, a.variants.fix.totalMWh);
});

test('posun nemění roční (ani denní) spotřebu a nezdražuje spot ani dynamický tarif', () => {
  const base = sampleCase(0);
  for (const pct of [10, 20, 30]) {
    const s = sampleCase(pct);
    close(s.variants.spot.totalMWh, base.variants.spot.totalMWh, 1e-12);
    close(s.variants.dynamic.totalMWh, base.variants.dynamic.totalMWh, 1e-12);
    assert.ok(s.variants.spot.energy <= base.variants.spot.energy + 1e-9);
    assert.ok(s.variants.dynamic.energy <= base.variants.dynamic.energy + 1e-9);
    close(s.variants.fix.total, base.variants.fix.total);
  }
  const grid = buildQuarterGrid('2026-03-29', '2026-03-30');
  const cons = grid.map((_, i) => 1 + (i % 7));
  const shifted = shiftLoad(cons, grid.map((q) => (q.hour * 37) % 11), 0.3, dayRanges(grid));
  for (const [a, b] of dayRanges(grid)) close(sum(shifted.slice(a, b)), sum(cons.slice(a, b)), 1e-9);
  assert.ok(shifted.every((v) => v >= 0));
});

// --- Regulované složky ------------------------------------------------------

test('VT/NT podle oken NT a DPH', () => {
  const grid = buildQuarterGrid('2026-01-05', '2026-01-05');
  const mask = ntMaskFor(grid, { workday: [[0, 6]], weekend: [[0, 24]] });
  assert.equal(mask.filter(Boolean).length, 24);
  const cons = grid.map(() => 1 / 96);
  close(regulatedVariable(cons, mask, 1000, 100, 0), 0.75 * 1000 + 0.25 * 100);
  close(withVat(100, 0.21), 121);
});

test('POZE: účtuje se nižší z platby podle spotřeby a podle jističe', () => {
  close(pozeAnnual(3, { perMWh: 495, monthly: 0 }), 0);
  close(pozeAnnual(3, { perMWh: 495, monthly: 200 }), 1485);
  close(pozeAnnual(10, { perMWh: 495, monthly: 200 }), 2400);
});

// --- CSV ------------------------------------------------------------------

test('CSV: středník, desetinná čárka, čas konce intervalu', () => {
  const text = 'Datum a čas;Spotřeba [kWh]\n05.01.2026 00:15;0,25\n05.01.2026 00:30;0,5\n';
  const { headers, rows } = parseCsv(text);
  assert.deepEqual(headers, ['Datum a čas', 'Spotřeba [kWh]']);
  assert.equal(rows.length, 2);
  const grid = buildQuarterGrid('2026-01-05', '2026-01-05');
  const tdd = grid.map(() => 1);
  const res = profileFromCsv(rows, { timeCol: 0, valueCol: 1, timeIsEnd: true, unit: 'kWh' }, grid, tdd);
  close(res.cons[0], 0.00025);
  close(res.cons[1], 0.0005);
  assert.equal(res.matched, 2);
});

test('CSV: hodinová data se rozdělí na čtvrthodiny, ISO čas, čárka jako oddělovač', () => {
  const text = 'time,kwh\n2026-01-05T00:00:00,1.0\n2026-01-05T01:00:00,2.0\n2026-01-05T02:00:00,2.0\n';
  const { rows } = parseCsv(text);
  const grid = buildQuarterGrid('2026-01-05', '2026-01-05');
  const res = profileFromCsv(rows, { timeCol: 0, valueCol: 1, timeIsEnd: false, unit: 'kWh' }, grid, grid.map(() => 1));
  close(res.cons[0], 0.00025);
  close(res.cons[4], 0.0005);
  assert.equal(res.matched, 12);
  // Chybějící čtvrthodiny se doplní podle TDD tak, aby poměr odpovídal naměřeným datům.
  close(sum(res.cons), 0.005 * 96 / 12, 1e-12);
});

test('průměr podle hodiny dne', () => {
  const grid = buildQuarterGrid('2026-01-05', '2026-01-06');
  const avg = hourlyAverage(grid, grid.map((q) => q.hour * 10));
  assert.equal(avg.length, 24);
  close(avg[5], 50);
});

// --- Porovnání s ceníkem dodavatele ----------------------------------------

test('dynamický tarif odpovídá výpočtu podle ceníku ČEZ Prodej (D02d i D25d, ČEZ Distribuce, 3× 25 A)', async () => {
  const { regulatedFor } = await import('../calc.js');
  const tariffs = readJson('../tariffs.json');
  const dyn = readJson('../dynamic.json');
  const product = dyn.products[dyn.default];
  const meta = readJson('../data/meta.json');
  const grid = buildQuarterGrid(meta.from, meta.to);
  const pct = dynamicPctPerQuarter(grid, product);
  // Hodnoty vč. DPH opsané z ceníku (ř. 25–32 celková jednotková cena, ř. 2, 5–12 a 22 stálé platby).
  const CENIK = {
    D02d: { vt: { '25': 7623.05, '10': 7038.05, '-10': 6258.05, '-50': 4698.05 }, monthly: 163.35 + 309.76 + 15.57, tdd: 'TDD4' },
    D25d: {
      vt: { '25': 7833.44, '10': 7248.44, '-10': 6468.44, '-50': 4908.44 },
      nt: { '25': 5248.94, '10': 4663.94, '-10': 3883.94, '-50': 2323.94 },
      monthly: 163.35 + 325.49 + 15.57, tdd: 'TDD5-SC',
    },
  };
  for (const [sazba, c] of Object.entries(CENIK)) {
    const cons = consumptionProfile(3, readJson(`../data/tdd/${c.tdd}.json`).values);
    const regulated = regulatedFor(tariffs, grid, 'cez', sazba, '3x25');
    const r = computeVariants({
      grid, cons, spotEur: grid.map(() => 0), fx: grid.map(() => 25), vat: tariffs.vat.value, regulated,
      fix: { price: 0, monthlyFee: 0 }, spot: { margin: 0, monthlyFee: 0 },
      dynamic: { base: product.basePrice.value, pct, monthlyFee: product.monthlyFee.value }, shiftPct: 0,
    });
    let expected = 12 * c.monthly; // POZE: nižší z výpočtů = 0 Kč (podle jističe 0,00 Kč/A)
    cons.forEach((q, i) => { expected += q * (regulated.ntMask?.[i] ? c.nt : c.vt)[pct[i]]; });
    close(r.variants.dynamic.total, expected, 1); // rozdíl jen ze zaokrouhlení cen v ceníku
  }
});

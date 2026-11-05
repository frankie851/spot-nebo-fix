// app.js – práce s DOM a grafy. Výpočty jsou v calc.js.
// Data se čtou jen z lokálních souborů (data/*.json, tariffs.json, dynamic.json);
// nahrané CSV zůstává v prohlížeči.

import {
  buildQuarterGrid, consumptionProfile, normalize, computeVariants, dynamicPctPerQuarter,
  hourlyAverage, hourlyShare, parseCsv, profileFromCsv, regulatedFor, sum,
} from './calc.js';

const $ = (id) => document.getElementById(id);
const nf0 = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kc = (v) => `${nf0.format(Math.round(v))} Kč`;
const czDate = (iso) => { const [y, m, d] = iso.split('-'); return `${+d}. ${+m}. ${y}`; };
const MONTHS = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];

const VARIANTS = [
  { key: 'fix', name: 'Fixní cena', color: '--c-fix' },
  { key: 'spot', name: 'Spot', color: '--c-spot' },
  { key: 'dynamic', name: 'Dynamický tarif', color: '--c-dyn' },
];

const HOUSEHOLDS = {
  flat: { sazba: 'D02d', mwh: 1.8, breaker: '3x25', hint: 'Byt: typicky sazba D02d, 1–2,5 MWh ročně.' },
  house: { sazba: 'D02d', mwh: 3.5, breaker: '3x25', hint: 'Rodinný dům bez elektrického vytápění: typicky D02d.' },
  heatpump: { sazba: 'D56d', mwh: 9, breaker: '3x25', hint: 'Tepelné čerpadlo: sazba D56d (22 h nízkého tarifu) nebo D57d.' },
  pv: { sazba: 'D02d', mwh: 2.5, breaker: '3x25', hint: 'Zadejte jen spotřebu odebranou ze sítě. Výroba FVE se nemodeluje, použije se profil TDD4.' },
};

const state = { csv: null, csvProfile: null, tddCache: new Map(), charts: {} };

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Nelze načíst ${path} (${res.status})`);
  return res.json();
}

async function loadTdd(key) {
  if (!state.tddCache.has(key)) state.tddCache.set(key, loadJson(`data/tdd/${key}.json`).then((j) => j.values));
  return state.tddCache.get(key);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function num(id) {
  const v = parseFloat(String($(id).value).replace(',', '.'));
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function fillSelect(sel, options, value) {
  sel.replaceChildren(...options.map(([v, label]) => new Option(label, v, false, v === value)));
}

// ---------------------------------------------------------------------------

async function init() {
  const [meta, prices, fx, tariffs, dynamic] = await Promise.all([
    loadJson('data/meta.json'), loadJson('data/prices.json'), loadJson('data/fx.json'),
    loadJson('tariffs.json'), loadJson('dynamic.json'),
  ]);
  const grid = buildQuarterGrid(meta.from, meta.to);
  const spotEur = Object.keys(prices.days).sort().flatMap((d) => prices.days[d]);
  if (spotEur.length !== grid.length) throw new Error('Data cen neodpovídají období.');
  const fxQ = grid.map((q) => fx.rates[q.date]);
  const product = dynamic.products[dynamic.default];
  Object.assign(state, { meta, grid, spotEur, fxQ, tariffs, product, dynPct: dynamicPctPerQuarter(grid, product) });

  const vat = tariffs.vat.value;
  fillSelect($('distributor'), Object.entries(tariffs.distributors).map(([k, d]) => [k, d.name]), 'cez');
  fillSelect($('sazba'), Object.entries(tariffs.sazbyInfo).map(([k, s]) => [k, s.label]), 'D02d');
  fillSelect($('breaker'), tariffs.breakers.map((b) => [b.id, b.label]), '3x25');
  $('dynBase').value = (product.basePrice.value * (1 + vat)).toFixed(0);
  $('dynFee').value = (product.monthlyFee.value * (1 + vat)).toFixed(2);
  updateRegions();

  $('data-date').textContent = `Ceny denního trhu a kurzy za období ${czDate(meta.from)} – ${czDate(meta.to)} `
    + `(poslední den s daty ${czDate(meta.lastPriceDay)}, aktualizováno ${czDate(meta.generated)}). `
    + `Regulované ceny: ${tariffs.year}. Dynamický tarif: ${product.supplier}, ceník od ${czDate(product.validFrom)}.`;

  $('household').addEventListener('change', applyHousehold);
  $('distributor').addEventListener('change', () => { updateRegions(); schedule(); });
  $('sazba').addEventListener('change', () => { updateRegions(); schedule(); });
  $('shift').addEventListener('input', () => { $('shift-out').textContent = `${$('shift').value} %`; schedule(); });
  $('form').addEventListener('input', (e) => { if (e.target.id !== 'csvFile') schedule(); });
  $('form').addEventListener('submit', (e) => e.preventDefault());
  setupCsv();
  applyHousehold();
}

function applyHousehold() {
  const h = HOUSEHOLDS[$('household').value];
  $('sazba').value = h.sazba;
  $('breaker').value = h.breaker;
  if (!state.csvProfile) $('mwh').value = h.mwh;
  $('household-hint').textContent = h.hint;
  updateRegions();
  schedule();
}

function updateRegions() {
  const { tariffs } = state;
  const isTdd5 = tariffs.sazbyInfo[$('sazba').value].tdd === 'TDD5';
  $('region-field').hidden = !isTdd5;
  const regions = tariffs.distributors[$('distributor').value].tdd5Regions;
  const cur = $('region').value;
  fillSelect($('region'), regions.map((r) => [r, tariffs.tdd5RegionLabels[r]]), regions.includes(cur) ? cur : regions[0]);
}

function tddKey() {
  const cls = state.tariffs.sazbyInfo[$('sazba').value].tdd;
  return cls === 'TDD5' ? `TDD5-${$('region').value}` : cls;
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => recalc().catch(showError), 120);
}

function showError(e) {
  console.error(e);
  $('summary').textContent = `Chyba: ${e.message}`;
}

// ---------------------------------------------------------------------------
// Výpočet a vykreslení
// ---------------------------------------------------------------------------

async function recalc() {
  const { grid, tariffs } = state;
  const vat = tariffs.vat.value;
  const net = (v) => v / (1 + vat);
  const tdd = await loadTdd(tddKey());
  let cons;
  if (state.csvProfile) {
    cons = state.csvProfile.cons;
    $('mwh').value = sum(cons).toFixed(2);
  } else {
    cons = consumptionProfile(Math.max(0.1, num('mwh')), tdd);
  }

  const regulated = regulatedFor(tariffs, grid, $('distributor').value, $('sazba').value, $('breaker').value);
  const params = {
    grid, cons, spotEur: state.spotEur, fx: state.fxQ, vat, regulated,
    fix: { price: net(num('fixPrice')), monthlyFee: net(num('fixFee')) },
    spot: { margin: net(num('spotMargin')), monthlyFee: net(num('spotFee')) },
    dynamic: { base: net(num('dynBase')), pct: state.dynPct, monthlyFee: net(num('dynFee')) },
  };
  const shiftPct = +$('shift').value;
  const base = computeVariants({ ...params, shiftPct: 0 });
  const res = shiftPct ? computeVariants({ ...params, shiftPct }) : base;

  renderCards(res, base, shiftPct);
  renderMonthly(res);
  renderHourly(cons, res, shiftPct);
}

function renderCards(res, base, shiftPct) {
  const list = VARIANTS.map((v) => ({ ...v, r: res.variants[v.key], b: base.variants[v.key] }));
  const best = list.reduce((a, b) => (b.r.total < a.r.total ? b : a));
  const worst = list.reduce((a, b) => (b.r.total > a.r.total ? b : a));
  $('summary').innerHTML = `Nejlevněji vychází <strong>${best.name.toLowerCase()}</strong>: ${kc(best.r.total)} za rok, `
    + `o ${kc(worst.r.total - best.r.total)} méně než ${worst.name.toLowerCase()}. Částky jsou včetně DPH.`;

  $('cards').replaceChildren(...list.map((v) => {
    const el = document.createElement('article');
    el.className = `card${v === best ? ' best' : ''}`;
    el.style.setProperty('--c', cssVar(v.color));
    const diff = v.r.total - best.r.total;
    const shiftNote = shiftPct && v.key !== 'fix'
      ? `<p class="shift-effect">Posun ${shiftPct} %: ${v.r.total <= v.b.total ? 'úspora' : 'navýšení'} ${kc(Math.abs(v.b.total - v.r.total))} oproti bez posunu</p>`
      : '';
    el.innerHTML = `
      <h3><span>${v.name}</span>${v === best ? '<span class="tag">Nejlevnější</span>' : ''}</h3>
      <div class="total">${kc(v.r.total)}</div>
      <div class="vat">za rok vč. DPH · ${nf2.format(v.r.total / v.r.totalMWh / 1000)} Kč/kWh</div>
      <p class="diff ${v === best ? 'best-txt' : ''}">${v === best ? 'Nejnižší náklady' : `o ${kc(diff)} dráž`}</p>
      <dl>
        <dt>Silová elektřina</dt><dd>${kc(v.r.energy)}</dd>
        <dt>Distribuce, daň a poplatky</dt><dd>${kc(v.r.regulated)}</dd>
        <dt>Stálé platby</dt><dd>${kc(v.r.fixedFees)}</dd>
      </dl>
      ${shiftNote}`;
    return el;
  }));
}

function chartColors() {
  return { text: cssVar('--muted'), grid: cssVar('--border') };
}

function renderMonthly(res) {
  const { text, grid } = chartColors();
  const labels = res.months.map((m) => `${MONTHS[+m.slice(5) - 1]} ${m.slice(2, 4)}`);
  const datasets = VARIANTS.map((v) => ({
    label: v.name, data: res.variants[v.key].monthly.map(Math.round),
    backgroundColor: cssVar(v.color), borderRadius: 3, maxBarThickness: 18,
  }));
  upsertChart('monthly', 'chart-monthly', {
    type: 'bar',
    data: { labels, datasets },
    options: baseOptions(text, grid, {
      y: { ticks: { color: text, callback: (v) => nf0.format(v) }, grid: { color: grid } },
      x: { ticks: { color: text, maxRotation: 0, autoSkip: true }, grid: { display: false } },
    }, (ctx) => `${ctx.dataset.label}: ${kc(ctx.parsed.y)}`),
  });
}

function renderHourly(cons, res, shiftPct) {
  const { text, grid } = chartColors();
  const g = state.grid;
  const priceKc = state.spotEur.map((p, i) => p * state.fxQ[i]);
  const avg = hourlyAverage(g, priceKc);
  const share = hourlyShare(g, cons).map((v) => v * 100);
  const datasets = [
    { type: 'line', label: 'Průměrná spotová cena (Kč/MWh)', data: avg.map(Math.round), yAxisID: 'y',
      borderColor: cssVar('--c-spot'), backgroundColor: cssVar('--c-spot'), tension: 0.3, pointRadius: 2, borderWidth: 2, order: 0 },
    { type: 'bar', label: 'Vaše spotřeba (% za den)', data: share, yAxisID: 'y1',
      backgroundColor: cssVar('--c-cons'), borderRadius: 2, order: 1 },
  ];
  if (shiftPct) {
    datasets.push({ type: 'bar', label: `Spotřeba po posunu ${shiftPct} %`, data: hourlyShare(g, res.variants.spot.cons).map((v) => v * 100),
      yAxisID: 'y1', backgroundColor: cssVar('--c-dyn'), borderRadius: 2, order: 2 });
  }
  upsertChart('hourly', 'chart-hourly', {
    type: 'bar',
    data: { labels: [...Array(24).keys()].map((h) => `${h}`), datasets },
    options: baseOptions(text, grid, {
      x: { title: { display: true, text: 'hodina dne', color: text }, ticks: { color: text, maxRotation: 0 }, grid: { display: false } },
      y: { position: 'left', title: { display: true, text: 'Kč/MWh', color: text }, ticks: { color: text, callback: (v) => nf0.format(v) }, grid: { color: grid } },
      y1: { position: 'right', title: { display: true, text: '% spotřeby', color: text }, ticks: { color: text, callback: (v) => `${v} %` }, grid: { display: false }, beginAtZero: true },
    }, (ctx) => (ctx.dataset.yAxisID === 'y1'
      ? `${ctx.dataset.label}: ${nf2.format(ctx.parsed.y)} %`
      : `${ctx.dataset.label}: ${nf0.format(ctx.parsed.y)}`)),
  });
}

function baseOptions(text, grid, scales, label) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', labels: { color: text, boxWidth: 12, usePointStyle: true } },
      tooltip: { callbacks: { label } },
    },
    scales,
  };
}

function upsertChart(key, canvasId, config) {
  if (!window.Chart) return;
  const ch = state.charts[key];
  if (ch) {
    ch.data = config.data;
    ch.options = config.options;
    ch.update();
  } else {
    state.charts[key] = new window.Chart($(canvasId), config);
  }
}

// ---------------------------------------------------------------------------
// CSV – vše jen lokálně přes FileReader, nic se neodesílá
// ---------------------------------------------------------------------------

function readFileText(file, encoding) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file, encoding);
  });
}

function setStatus(msg, err = false) {
  $('csv-status').textContent = msg;
  $('csv-status').classList.toggle('err', err);
}

function setupCsv() {
  $('csvFile').addEventListener('change', async () => {
    const file = $('csvFile').files[0];
    if (!file) return;
    try {
      let text = await readFileText(file, 'utf-8');
      if (text.includes('�')) text = await readFileText(file, 'windows-1250');
      state.csv = parseCsv(text);
      const opts = state.csv.headers.map((h, i) => [String(i), h || `Sloupec ${i + 1}`]);
      const timeGuess = state.csv.headers.findIndex((h) => /čas|cas|datum|date|time|od|do/i.test(h));
      const valGuess = state.csv.headers.findIndex((h) => /kwh|kw|spotř|spotr|odběr|odber|hodnota|value|činn/i.test(h));
      fillSelect($('csvTime'), opts, String(timeGuess >= 0 ? timeGuess : 0));
      fillSelect($('csvValue'), opts, String(valGuess >= 0 && valGuess !== timeGuess ? valGuess : Math.min(1, opts.length - 1)));
      if (state.csv.headers.some((h) => /\bkW\b(?!h)/i.test(h))) $('csvUnit').value = 'kW';
      $('csv-map').hidden = false;
      setStatus(`Načteno ${nf0.format(state.csv.rows.length)} řádků. Zkontrolujte sloupce a klikněte na „Použít měření“.`);
    } catch (e) {
      setStatus(`Soubor se nepodařilo přečíst: ${e.message}`, true);
    }
  });

  $('csvApply').addEventListener('click', async () => {
    if (!state.csv) return;
    try {
      const tdd = normalize(await loadTdd(tddKey()));
      const res = profileFromCsv(state.csv.rows, {
        timeCol: +$('csvTime').value, valueCol: +$('csvValue').value,
        timeIsEnd: $('csvEnd').value === '1', unit: $('csvUnit').value,
      }, state.grid, tdd);
      state.csvProfile = res;
      $('mwh').disabled = true;
      const pct = Math.round(res.coverage * 100);
      setStatus(`Použito měření (interval ${res.interval} min): pokrývá ${pct} % čtvrthodin období, naměřeno ${nf2.format(res.measuredMWh)} MWh.`
        + (pct < 100 ? ' Chybějící čtvrthodiny jsou doplněny podle TDD ve stejném poměru.' : '')
        + (pct < 50 ? ' Měření pokrývá méně než polovinu roku, výsledek je jen hrubý odhad.' : ''));
      schedule();
    } catch (e) {
      setStatus(e.message, true);
    }
  });

  $('csvClear').addEventListener('click', () => {
    state.csvProfile = null;
    state.csv = null;
    $('csvFile').value = '';
    $('csv-map').hidden = true;
    $('mwh').disabled = false;
    $('mwh').value = HOUSEHOLDS[$('household').value].mwh;
    setStatus('Výpočet opět používá typový diagram dodávky (TDD).');
    schedule();
  });
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => schedule());

init().catch(showError);

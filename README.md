# Spot, nebo fix?

Statický web, který domácnosti spočítá roční náklady na elektřinu ve třech variantách na skutečných cenách
posledních 12 celých měsíců:

- **spot**: 15minutové ceny denního trhu OTE × kurz ČNB + marže dodavatele,
- **fix**: cena silové elektřiny, kterou zadá uživatel,
- **dynamický tarif**: pevná pásma (výchozí ČEZ Prodej, ceník od 1. 6. 2026).

Ke všem třem variantám se připočtou stejné regulované složky (distribuce VT/NT, jistič, systémové služby, daň,
POZE, nesíťová infrastruktura) a DPH. Posuvník ukáže, kolik ušetří přesun 0–30 % spotřeby do nejlevnějších hodin.

## Spuštění

Potřebujete Node.js 20 nebo novější (bez dalších balíčků).

```bash
node scripts/serve.mjs
```

Otevřete <http://localhost:8080/>. Stránka musí běžet přes HTTP (ne `file://`), protože načítá soubory `data/*.json`.
Web lze nasadit na libovolný statický hosting (GitHub Pages, Netlify…); stačí nahrát celý adresář.

Testy:

```bash
node --test
```

## Struktura

| Soubor | Obsah |
|---|---|
| `index.html`, `styles.css`, `app.js` | UI (formulář, karty, grafy Chart.js z cdnjs) |
| `calc.js` | všechny výpočty, bez vazby na DOM (časová mřížka, TDD, varianty, posun spotřeby, CSV) |
| `data/prices.json` | ceny denního trhu OTE v EUR/MWh po čtvrthodinách, po dnech |
| `data/fx.json` | kurz EUR/CZK ČNB pro každý kalendářní den (víkend/svátek = poslední vyhlášený) |
| `data/tdd/*.json` | normalizované TDD OTE (koeficient × 10 000) pro třídy 4, 5 (8 regionů), 6, 7 |
| `data/meta.json` | období dat a datum aktualizace |
| `tariffs.json` | distribuce a poplatky podle distributora a sazby, každá položka se zdrojem a rokem |
| `dynamic.json` | pásma dynamického tarifu (časy a % odchylky od základní ceny) |
| `scripts/update-data.mjs` | stažení dat z OTE a ČNB |
| `.github/workflows/update-data.yml` | denní spuštění skriptu a commit změněných dat |

## Zdroje dat

| Data | Adresa | Formát |
|---|---|---|
| Ceny denního trhu | `https://www.ote-cr.cz/pw-data/chart-data/01?language=cs&report_date=RRRR-MM-DD` | JSON, `data.dataLine[]`; řada „15min cena (EUR/MWh)“ (96 period, 92/100 při změně času); do 30. 9. 2025 hodinová řada „Cena (EUR/MWh)“ |
| Kurzy ČNB | `https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt?rok=RRRR` | text, oddělovač `\|`, hlavička `Datum\|…\|1 EUR\|…`, datum `DD.MM.RRRR`, desetinná čárka |
| Normalizované TDD | `https://www.ote-cr.cz/pubweb/attachments/20/RRRR/Normalizovane_TDD_15MIN_RRRR_CZ.zip` | ZIP s XLSX, hlavička na řádku 4, sloupce Den (sériové datum Excelu), Perioda 1–100, TDD1–8 |
| Distribuce a poplatky 2026 | ceníky ČEZ Prodej pro území [ČEZ Distribuce](https://www.cez.cz/webpublic/file/edee/ceniky/moo_ele_cez_dynamicky_tarif_01062026_012026.pdf), [EG.D](https://www.cez.cz/webpublic/file/edee/ceniky/moo_ele_egd_dynamicky_tarif_01062026_012026.pdf), [PREdistribuce](https://www.cez.cz/webpublic/file/edee/ceniky/moo_ele_pre_dynamicky_tarif_01062026_012026.pdf); [cenový výměr ERÚ 13/2025](https://eru.gov.cz/sites/default/files/obsah/prilohy/erv172025.pdf) a [15/2025](https://eru.gov.cz/sites/default/files/obsah/prilohy/erv192025.pdf) | PDF, ručně přepsáno do `tariffs.json` |

Prohlížeč nikdy nevolá OTE ani ČNB. Čte jen soubory v tomto repozitáři.
Nahrané CSV s průběhovým měřením se zpracuje přes `FileReader` jen v prohlížeči a nikam se neodesílá.

## Ruční aktualizace dat

```bash
node scripts/update-data.mjs
```

- Skript stáhne posledních 12 **celých** kalendářních měsíců. Už stažené dny bere z `data/prices.json`,
  takže běžný běh trvá pár sekund. TDD stahuje jen při změně období.
- `--full` stáhne vše znovu, `--to 2026-10-31` nastaví konec období ručně.
- Za firemní proxy použijte `NODE_USE_ENV_PROXY=1 node scripts/update-data.mjs` (Node ≥ 22.21).
- Skript skončí chybou a nic nepřepíše, pokud nějaký den nemá správný počet čtvrthodin, chybí kurz nebo TDD.
- Po aktualizaci spusťte `node --test`. Testy kontrolují i úplnost dat.

GitHub Action `.github/workflows/update-data.yml` dělá totéž denně v 15:37 UTC a commitne jen změněné soubory
v `data/`. Ve vlastním repozitáři je třeba v *Settings → Actions → General → Workflow permissions* povolit
„Read and write permissions“. Ručně ji spustíte v záložce *Actions* tlačítkem *Run workflow*.
Zaškrtnutím „Stáhnout všechna data znovu (--full)“ stáhne všechna data znovu bez mezipaměti.

Pokud by OTE změnil adresu nebo formát exportu, dočasně stačí jednou měsíčně ručně stáhnout data
a spustit skript na jiném počítači. Funkce `fetchOteDay` a `parseCnbYear` jsou na začátku skriptu.

## Úprava `tariffs.json` na nový rok

Ceny distribuce na další rok zveřejňují distributoři a dodavatelé po cenovém rozhodnutí ERÚ (obvykle v listopadu
a prosinci). Všechny částky v `tariffs.json` jsou **bez DPH** (v cenících jsou uvedeny v závorce).

1. Stáhněte nové ceníky pro všechna tři území. Nejjednodušší je ceník dynamického tarifu ČEZ Prodej
   (tabulka „Distribuční část ceny“), nebo přímo ceníky ČEZ Distribuce, EG.D a PREdistribuce.
2. Pro každého distributora (`distributors.cez|egd|pre.sazby`) a sazbu přepište:
   - `vt`: řádek „Vysoký tarif“ (Kč/MWh),
   - `nt`: řádek „Nízký tarif“ (u D01d a D02d zůstává `null`),
   - `breaker`: měsíční platba za jistič pro každé pásmo (`3x10|1x25`, `3x16` … `3x63`).
3. V `common` zkontrolujte daň z elektřiny, cenu za systémové služby, nesíťovou infrastrukturu a POZE
   (cenový výměr ERÚ „ceny za související službu v elektroenergetice“ na <https://eru.gov.cz/cenove-vymery>).
   POZE: `perMWh` a `perAmpPhase`; účtuje se nižší z obou.
4. Změňte u položek `year`, `source`/`url` a nahoře `year`; u DPH změňte `vat.value`, pokud se změní sazba.
5. Časy nízkého tarifu (`ntHours`) jsou typická okna. Pokud znáte své HDO, upravte je
   (`[od, do)` v hodinách lokálního času).
6. Spusťte `node --test`. Test „dynamický tarif odpovídá výpočtu podle ceníku ČEZ“ obsahuje čísla
   vč. DPH opsaná z ceníku. Po změně cen ho aktualizujte podle nového ceníku (ř. 25–33).

### Nová pásma dynamického tarifu

Do `dynamic.json → products` přidejte novou položku se stejnou strukturou. Uveďte `basePrice` (bez DPH),
`monthlyFee`, `seasons` s měsíci a pásma `{ from, to, pct }` pro pracovní dny a pro víkendy a svátky.
Pak nastavte `default` na nový klíč.

## Zjednodušení

- Profil spotřeby = roční spotřeba × normalizovaný TDD třídy sazby, bez teplotního přepočtu.
  Sazby: D01d/D02d → TDD4, D25d/D26d/D27d → TDD5 (podle regionu), D35d/D45d/D56d/D57d → TDD6, D61d → TDD7.
- Časy nízkého tarifu jsou typická okna podle sazby, skutečné HDO se liší místo od místa.
- Regulované ceny a ceník dynamického tarifu 2026 se používají na celé období, i na listopad a prosinec 2025.
- Posun spotřeby: z každé čtvrthodiny se odebere zvolený podíl a celek se rozdělí rovným dílem
  do 16 nejlevnějších čtvrthodin téhož dne. U spotu podle spotové ceny, u dynamického tarifu podle pásma.
- Domácnost s FVE: zadává se spotřeba ze sítě, výroba ani přetoky se nemodelují.
- CSV: páruje se podle data bez roku (MM-DD HH:MM). Bere se posledních 12 měsíců souboru,
  chybějící čtvrthodiny se doplní podle TDD ve stejném poměru jako naměřená data.

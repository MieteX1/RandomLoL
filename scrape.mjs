// scrape.mjs — zbiera dane z Lolalytics do data.js
// Użycie:  node scrape.mjs
// Opcje:   --min-games 500     minimum gier championa na danej roli
//          --min-lane-pct 2    minimum % gier championa grane na tej roli
//          --only Jinx,Ashe    tylko wybrani championowie (do testów)
//          --min-item-pct 0.3  minimum % gier championa na roli, w których item występuje (odcina rzadkie)
//          --min-start-pct 0.5 minimum % gier, w których zestaw startowy jest grany (odcina rzadkie)
//          --delay 400         przerwa między żądaniami w ms
//          --dump              zapisuje surowy HTML stron buildów (diagnostyka)
// Wymaga Node.js 18+ (wbudowany fetch). Zero zależności.

import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const MIN_GAMES = Number(opt('min-games', 100));
const MIN_LANE_PCT = Number(opt('min-lane-pct', 0.1));
const MIN_ITEM_PCT = Number(opt('min-item-pct', 0)); // item musi wystąpić w >= tylu % gier championa na tej roli
const MIN_START_PCT = Number(opt('min-start-pct', 0)); // zestaw startowy musi być grany w >= tylu % gier
const DELAY = Number(opt('delay', 400));
const DUMP = args.includes('--dump'); // zapisuje surowy HTML stron buildów do plików dump-*.html (do diagnozy)
const ONLY = opt('only', '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const LANES = ['top', 'jungle', 'middle', 'bottom', 'support'];
const SLUG_OVERRIDES = { 'Nunu & Willump': 'nunu', 'Renata Glasc': 'renata' };
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; personal-random-champ-tool)',
  'Accept-Language': 'en',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, asJson = false, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return asJson ? await res.json() : await res.text();
    } catch (e) {
      if (i === tries) throw new Error(`${url}: ${e.message}`);
      await sleep(1000 * i);
    }
  }
}

// ---------- Data Dragon: championowie i pula przedmiotów ----------
const version = (await get('https://ddragon.leagueoflegends.com/api/versions.json', true))[0];
console.log('Data Dragon wersja:', version);

const champJson = await get(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`, true);
const itemJson = await get(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`, true);

const slugOf = (name) => SLUG_OVERRIDES[name] ?? name.toLowerCase().replace(/[^a-z0-9]/g, '');

// Pula "sensownych" przedmiotów: gotowe (nic z nich się nie buduje), kupowalne na Summoner's Rift,
// bez konsumpcji/trinketów. Buty (tier 2) osobno.
const itemNames = {};
const itemCost = {};
const finalItems = new Set();
const bootItems = new Set();
for (const [id, it] of Object.entries(itemJson.data)) {
  if (!it.maps?.['11'] || !it.gold?.purchasable) continue;
  if (it.into?.length) continue;
  const tags = it.tags ?? [];
  if (tags.includes('Consumable') || tags.includes('Trinket') || tags.includes('Jungle')) continue;
  if (!it.from?.length) continue; // odpada Doran's, podstawowe itemy
  if (tags.includes('Boots')) {
    bootItems.add(id);
    itemNames[id] = it.name;
    itemCost[id] = it.gold.total;
  } else if ((it.gold?.total ?? 0) >= 1000) {
    finalItems.add(id);
    itemNames[id] = it.name;
    itemCost[id] = it.gold.total;
  }
}
console.log(`Pula itemów: ${finalItems.size} gotowych + ${bootItems.size} butów (wg tagów Data Dragon)`);

// Buty bierzemy wprost z tabeli "Boots" z Lolalytics. Data Dragon służy tylko do nazwy i ceny;
// odrzucamy podstawowe Boots of Speed i inne tanie wpisy (< 700 g), a także 9999 ("brak butów").
const seenBoots = new Set();
function bootOk(id) {
  const it = itemJson.data[id];
  if (!it || (it.gold?.total ?? 0) < 700) return false;
  itemNames[id] = it.name;
  itemCost[id] = it.gold.total;
  seenBoots.add(id);
  return true;
}

// ---------- Parsowanie stron Lolalytics ----------
const toText = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<img[^>]*?alt="([^"]*)"[^>]*>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

function parseLanePercents(text) {
  const out = {};
  for (const lane of LANES) {
    const m = text.match(new RegExp(`${lane}\\s+lane\\s+([\\d.]+)%`, 'i'));
    if (m) out[lane] = parseFloat(m[1]);
  }
  return out;
}

// Lolalytics (Qwik) wkłada cały stan strony do <script type="qwik/json">. Tabele itemów leżą tam jako
// tablice wierszy [id, winrate, pickrate, gry, minuta zakupu]:
//   state.item  = zakładka "All Items", state.boots = zakładka "Boots", state.item1..item5 = sloty.
// Referencje w tym JSON-ie to napisy w base36 wskazujące indeks w tablicy "objs".
function parseState(html) {
  const m = html.match(/<script type="qwik\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let O;
  try {
    O = JSON.parse(m[1]).objs;
  } catch {
    return null;
  }
  const isRef = (v) => typeof v === 'string' && /^[0-9a-z]+$/.test(v) && parseInt(v, 36) < O.length;
  const deref = (v) => (isRef(v) ? O[parseInt(v, 36)] : v);
  const root = O.find((o) => o && typeof o === 'object' && !Array.isArray(o) && 'item' in o && 'boots' in o && 'item1' in o);
  if (!root) return null;
  const table = (key) => {
    const arr = deref(root[key]);
    if (!Array.isArray(arr)) return [];
    const rows = [];
    for (const r of arr) {
      const row = deref(r);
      if (!Array.isArray(row) || row.length < 4) continue;
      const [id, wr, pr, games, time] = row.map(deref);
      if ([id, wr, pr, games].some((x) => typeof x !== 'number')) continue;
      rows.push({ id: String(id), wr, pr, games, time: typeof time === 'number' ? time : null });
    }
    return rows;
  };
  const h = deref(root.header);
  const header = h && typeof h === 'object'
    ? Object.fromEntries(['wr', 'n', 'pr', 'br', 'tier', 'rank', 'rankTotal'].map((k) => [k, deref(h[k])]))
    : {};
  // Zestawy startowe: wiersze ["1086_2003_2003", winrate, pickrate, gry]; powtórzone ID = liczba sztuk
  const startSets = [];
  const ss = deref(root.startSet);
  if (Array.isArray(ss)) {
    for (const r of ss) {
      const row = deref(r);
      if (!Array.isArray(row) || row.length < 4) continue;
      const [key, wr, pr, games] = row.map(deref);
      if (typeof key !== 'string' || [wr, pr, games].some((x) => typeof x !== 'number')) continue;
      const ids = key.split('_').filter((x) => /^\d+$/.test(x));
      if (ids.length) startSets.push({ ids, wr, pr, games });
    }
  }
  return { all: table('item'), boots: table('boots'), header, startSets };
}

// Nazwa i cena itemu z Data Dragon (potrzebne też dla itemów startowych, których nie ma w puli buildów)
function nameItem(id) {
  const it = itemJson.data[id];
  if (!it) return false;
  itemNames[id] = it.name;
  itemCost[id] = it.gold?.total ?? 0;
  return true;
}

function parseBuildPage(html) {
  const text = toText(html);
  const gm = text.match(/([\d,]{2,})\s+Games\b/);
  const games = gm ? Number(gm[1].replace(/,/g, '')) : 0;
  const wm = text.match(/([\d.]+)%\s+Win Rate/);
  const winrate = wm ? parseFloat(wm[1]) : null;
  const state = parseState(html);
  if (state && state.all.length) {
    // Zakładki "All Items" i "Boots" ze stanu strony; odcinamy rzadkie itemy (min. % gier tej roli)
    const hd = state.header;
    const laneGames = typeof hd.n === 'number' ? hd.n : games;
    const minGames = Math.max(10, (laneGames * MIN_ITEM_PCT) / 100);
    const itemStats = {};
    const items = [];
    const boots = [];
    for (const r of state.all) {
      if (finalItems.has(r.id) && r.games >= minGames) {
        items.push(r.id);
        itemStats[r.id] = { wr: r.wr, pr: r.pr, games: r.games, time: r.time };
      }
    }
    for (const r of state.boots) {
      if (r.games >= minGames && bootOk(r.id)) {
        boots.push(r.id);
        itemStats[r.id] = { wr: r.wr, pr: r.pr, games: r.games, time: r.time };
      }
    }
    // Zestawy startowe: tylko te, które gra co najmniej MIN_START_PCT% (reszta to rzadkie wyjątki);
    // gdyby żaden nie przeszedł progu, zostaje najpopularniejszy
    const sets = state.startSets.filter((s) => s.ids.every(nameItem));
    let startSets = sets.filter((s) => s.pr >= MIN_START_PCT).slice(0, 8);
    if (!startSets.length && sets.length) startSets = [sets[0]];
    return {
      startSets,
      games: laneGames,
      winrate: typeof hd.wr === 'number' ? hd.wr : winrate,
      tier: typeof hd.tier === 'string' ? hd.tier : null,
      rank: hd.rank ?? null,
      rankTotal: hd.rankTotal ?? null,
      pickRate: hd.pr ?? null,
      banRate: hd.br ?? null,
      items, boots, itemStats,
    };
  }
  // Awaryjnie (gdyby Lolalytics zmienił format): same ikony itemów z HTML-a, bez statystyk
  const ids = new Set();
  for (const m of html.matchAll(/item64\/(\d+)\.webp/g)) ids.add(m[1]);
  const items = [...ids].filter((id) => finalItems.has(id));
  const boots = [...ids].filter((id) => bootItems.has(id));
  return { games, winrate, items, boots, itemStats: {} };
}

// ---------- Główna pętla ----------
let champs = Object.values(champJson.data).map((c) => ({
  id: c.id,
  name: c.name,
  slug: slugOf(c.name),
  title: c.title,
  tags: c.tags,
  partype: c.partype,
  difficulty: c.info?.difficulty,
}));
if (ONLY.length) champs = champs.filter((c) => ONLY.includes(c.name.toLowerCase()) || ONLY.includes(c.id.toLowerCase()));

const result = {};
let done = 0;

async function processChampion(c) {
  const base = `https://lolalytics.com/lol/${c.slug}/build/`;
  const basePage = await get(base);
  await sleep(DELAY);
  const pcts = parseLanePercents(toText(basePage));
  const candidates = LANES.filter((l) => (pcts[l] ?? 0) >= MIN_LANE_PCT);
  if (!candidates.length) {
    console.warn(`  ! ${c.name}: nie znaleziono ról (zła nazwa w URL? zmiana HTML?)`);
    return;
  }
  for (const lane of candidates) {
    const html = await get(`${base}?lane=${lane}`);
    await sleep(DELAY);
    if (DUMP) await writeFile(`dump-${c.slug}-${lane}.html`, html);
    const p = parseBuildPage(html);
    if (p.games < MIN_GAMES) continue;
    if (p.items.length + p.boots.length < 5) {
      console.warn(`  ! ${c.name} ${lane}: za mało itemów (${p.items.length}), pomijam`);
      continue;
    }
    result[c.name] ??= {
      id: c.id, name: c.name, slug: c.slug, title: c.title,
      tags: c.tags, partype: c.partype, difficulty: c.difficulty, lanes: {},
    };
    result[c.name].lanes[lane] = {
      games: p.games,
      winrate: p.winrate,
      lanePct: pcts[lane],
      items: p.items,
      boots: p.boots,
      itemStats: p.itemStats,
      startSets: p.startSets ?? [],
      tier: p.tier, rank: p.rank, rankTotal: p.rankTotal, pickRate: p.pickRate, banRate: p.banRate,
    };
  }
}

async function worker(queue) {
  while (queue.length) {
    const c = queue.shift();
    try {
      await processChampion(c);
    } catch (e) {
      console.warn(`  ! ${c.name}: ${e.message}`);
    }
    done++;
    if (done % 10 === 0 || done === champs.length) console.log(`${done}/${champs.length}`);
  }
}

const queue = [...champs];
await Promise.all([worker(queue), worker(queue), worker(queue)]);

const patchMatch = (await get('https://lolalytics.com/lol/tierlist/').catch(() => '')).match(/Patch\s+(\d+\.\d+)/i);
const data = {
  generated: new Date().toISOString(),
  patch: patchMatch ? patchMatch[1] : null,
  ddragonVersion: version,
  minGames: MIN_GAMES,
  items: itemNames,
  itemCost,
  allBoots: seenBoots.size ? [...seenBoots] : [...bootItems],
  champions: result,
};

await writeFile('data.js', 'window.LOL_DATA = ' + JSON.stringify(data) + ';\n');

const perLane = Object.fromEntries(LANES.map((l) => [l, 0]));
for (const c of Object.values(result)) for (const l of Object.keys(c.lanes)) perLane[l]++;
console.log('Gotowe! Zapisano data.js. Championów per rola:', perLane);

let lanesTotal = 0, lanesWithStats = 0, lanesWithBoots = 0;
for (const c of Object.values(result))
  for (const l of Object.values(c.lanes)) {
    lanesTotal++;
    if (Object.keys(l.itemStats ?? {}).length) lanesWithStats++;
    if (l.boots.length) lanesWithBoots++;
  }
console.log(`Role ze statystykami itemów: ${lanesWithStats}/${lanesTotal}; role z butami z Lolalytics: ${lanesWithBoots}/${lanesTotal}`);
if (lanesWithStats === 0) console.warn('UWAGA: nie udało się odczytać statystyk itemów. Uruchom: node scrape.mjs --only Jinx --dump  i prześlij mi plik dump-jinx-bottom.html');
if (lanesWithBoots === 0) console.warn('UWAGA: brak butów w danych z Lolalytics (strona pewnie ładuje je dopiero po kliknięciu zakładki Boots).');

// P0 probe for the Qloo hackathon API (SPEC "P0 실측").
// Usage: node scripts/probe.ts [--fresh]
// Raw responses are written outside this repository (PROBE_DIR, default ../.private/probe)
// and are never committed: Qloo response data must not be stored in a public repository.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Params = Record<string, string | number | boolean | undefined>;

interface ProbeResult {
  name: string;
  status: number;
  ms: number;
  rate: Record<string, string>;
  body: unknown;
}

function isProbeResult(value: unknown): value is ProbeResult {
  if (value === null || typeof value !== "object") return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  if (!("status" in value) || typeof value.status !== "number" ||
      !Number.isInteger(value.status) || value.status < 100 || value.status > 599) return false;
  if (!("ms" in value) || typeof value.ms !== "number" ||
      !Number.isFinite(value.ms) || value.ms < 0) return false;
  if (!("rate" in value) || value.rate === null ||
      typeof value.rate !== "object" || Array.isArray(value.rate)) return false;
  return Object.values(value.rate).every((v) => typeof v === "string") && "body" in value;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env: Record<string, string> = {};
if (existsSync(join(root, ".env.local"))) {
  for (const raw of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
}
const BASE = env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
if (BASE !== "https://hackathon.api.qloo.com") {
  throw new Error("QLOO_BASE_URL must be the approved hackathon HTTPS origin");
}
const KEY = env.QLOO_API_KEY;
if (!KEY) throw new Error("QLOO_API_KEY missing in .env.local");
const API_KEY: string = KEY;
const PROBE_DIR = resolve(root, process.env.PROBE_DIR ?? "../.private/probe");
const FRESH = process.argv.includes("--fresh");
mkdirSync(PROBE_DIR, { recursive: true });

/** Walks an unknown JSON value by object keys; returns undefined when a step is missing. */
function at(value: unknown, ...keys: string[]): unknown {
  let cur = value;
  for (const k of keys) {
    if (cur === null || typeof cur !== "object" || !(k in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function keysOf(value: unknown): string {
  return value !== null && typeof value === "object" ? Object.keys(value).join(",") : String(value);
}

/** Insights/search payloads put rows under results.entities, results, or entities depending on the route. */
function rows(r: ProbeResult): unknown[] {
  const fromResults = at(r.body, "results", "entities") ?? at(r.body, "results");
  return list(Array.isArray(fromResults) ? fromResults : at(r.body, "entities"));
}

function names(items: unknown[], n: number, extra?: (e: unknown) => string): string {
  return items
    .slice(0, n)
    .map((e) => `${String(at(e, "name"))}${extra ? `(${extra(e)})` : ""}`)
    .join(" | ");
}

let lastCall = 0;
async function throttle(): Promise<void> {
  const wait = lastCall + 260 - Date.now(); // stays under 4 requests per second
  if (wait > 0) {
    const { promise, resolve: done } = Promise.withResolvers<void>();
    setTimeout(done, wait);
    await promise;
  }
  lastCall = Date.now();
}

async function q(name: string, path: string, params: Params = {}): Promise<ProbeResult> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") search.set(k, String(v));
  const url = `${BASE}${path}?${search.toString()}`;
  const file = join(PROBE_DIR, `${name}.${createHash("sha1").update(url).digest("hex").slice(0, 10)}.json`);
  if (!FRESH && existsSync(file)) {
    const cached: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isProbeResult(cached) || cached.name !== name) {
      throw new Error(`Invalid probe cache: ${name}`);
    }
    return cached;
  }

  await throttle();
  const started = Date.now();
  const res = await fetch(url, {
    headers: { "X-Api-Key": API_KEY, accept: "application/json" },
    redirect: "error",
  });
  const ms = Date.now() - started;
  const rate: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k.includes("ratelimit") || k.includes("retry")) rate[k] = v;
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJson: text.slice(0, 500) };
  }
  const result: ProbeResult = { name, status: res.status, ms, rate, body };
  writeFileSync(file, JSON.stringify({ ...result, request: { path, params } }, null, 2));
  return result;
}

function line(r: ProbeResult, extra = ""): void {
  const err = r.status >= 400 ? ` err=${JSON.stringify(r.body).slice(0, 200)}` : "";
  console.log(`[${r.status}] ${r.name} n=${rows(r).length} ${r.ms}ms ${extra}${err}`);
}

const fmt = (v: unknown): string => (typeof v === "number" ? v.toFixed(3) : String(v));

async function main(): Promise<void> {
  const report: Record<string, unknown> = {};

  // ---------- S1: seeds ----------
  const seedSpecs: Array<[string, string, string]> = [
    ["jb", "Japanese Breakfast", "urn:entity:artist"],
    ["pastlives", "Past Lives", "urn:entity:movie"],
    ["a24", "A24", "urn:entity:brand"],
    ["bargatze", "Nate Bargatze", "urn:entity:person"],
    ["tedlasso", "Ted Lasso", "urn:entity:tv_show"],
    ["smartless", "SmartLess", "urn:entity:podcast"],
    ["mfm", "My Favorite Murder", "urn:entity:podcast"],
    ["omitb", "Only Murders in the Building", "urn:entity:tv_show"],
  ];
  const ids: Record<string, string> = {};
  const pops: Record<string, number> = {};
  for (const [key, query, type] of seedSpecs) {
    const r = await q(`search-${key}`, "/search", { query, types: type, take: 3 });
    const top = rows(r)[0];
    const id = at(top, "entity_id");
    const pop = at(top, "popularity");
    if (typeof id === "string") ids[key] = id;
    if (typeof pop === "number") pops[key] = pop;
    line(r, `top=${String(at(top, "name"))} types=${String(at(top, "types") ?? at(top, "type"))} pop=${fmt(pop)}`);
    if (key === "jb") report.searchEntityKeys = keysOf(top);
  }

  const cityNames = ["Philadelphia", "Boston", "Washington", "New York City", "Baltimore", "Pittsburgh", "Providence", "Richmond"];
  const cityIds: Record<string, string> = {};
  for (const c of cityNames) {
    const r = await q(`search-city-${c.replace(/\W/g, "")}`, "/search", { query: c, types: "urn:entity:destination", take: 3 });
    const top = rows(r)[0];
    const id = at(top, "entity_id");
    if (typeof id === "string") cityIds[c] = id;
    line(r, `top=${String(at(top, "name"))} disamb=${String(at(top, "disambiguation") ?? "")}`);
  }
  const rl = await q("search-locality-philly", "/search", { query: "Philadelphia", types: "urn:entity:locality", take: 3 });
  line(rl, `top=${String(at(rows(rl)[0], "name"))}`);

  const music = [ids.jb, ids.pastlives, ids.a24].filter(Boolean).join(",");
  const affinity = (e: unknown) => fmt(at(e, "query", "affinity"));

  // ---------- P0-3 / S2: destination ----------
  const d1 = await q("dest-discover", "/v2/insights", {
    "filter.type": "urn:entity:destination",
    "signal.interests.entities": music,
    "filter.geocode.country_code": "US",
    take: 20,
    "feature.explainability": true,
  });
  line(d1, `first=${names(rows(d1), 6, affinity)}`);
  report.destEntityKeys = keysOf(rows(d1)[0]);
  report.destQuery = at(rows(d1)[0], "query");
  const d2 = await q("dest-results-entities", "/v2/insights", {
    "filter.type": "urn:entity:destination",
    "signal.interests.entities": music,
    "filter.results.entities": Object.values(cityIds).join(","),
    take: 20,
    "feature.explainability": true,
  });
  line(d2, `ranked=${names(rows(d2), 10, affinity)}`);
  const d3 = await q("dest-results-entities-headliner-only", "/v2/insights", {
    "filter.type": "urn:entity:destination",
    "signal.interests.entities": ids.jb,
    "filter.results.entities": Object.values(cityIds).join(","),
    take: 20,
  });
  line(d3, `ranked=${names(rows(d3), 10, affinity)}`);

  // ---------- P0-1 / S3: heatmap ----------
  for (const [name, extra] of [
    ["heatmap-basic", {}],
    ["heatmap-dimensions", { "output.heatmap.boundary": "urn:geohash", "heatmap.dimensions": "popularity,price_level" }],
  ] as const) {
    const r = await q(name, "/v2/insights", {
      "filter.type": "urn:heatmap",
      "filter.location.query": "Philadelphia",
      "signal.interests.entities": music,
      ...extra,
    });
    const cells = list(at(r.body, "results", "heatmap"));
    console.log(`[${r.status}] ${name} cells=${cells.length} ${r.ms}ms sample=${JSON.stringify(cells[0] ?? r.body).slice(0, 300)}`);
  }

  // ---------- P0-2, P0-5 / S3-B, S4: places ----------
  const p1 = await q("place-city-p1", "/v2/insights", {
    "filter.type": "urn:entity:place",
    "filter.location.query": "Philadelphia",
    "signal.interests.entities": music,
    take: 50,
    "feature.explainability": true,
  });
  const places = rows(p1);
  line(p1, `first=${names(places, 4, affinity)}`);
  report.placeEntityKeys = keysOf(places[0]);
  report.placePropertiesKeys = keysOf(at(places[0], "properties"));
  report.placeLocation = at(places[0], "location") ?? at(places[0], "properties", "geocode") ?? null;
  report.placeQuery = at(places[0], "query") ?? null;
  report.placeTagsSample = list(at(places[0], "tags")).slice(0, 6);
  const p2 = await q("place-city-p2", "/v2/insights", {
    "filter.type": "urn:entity:place",
    "filter.location.query": "Philadelphia",
    "signal.interests.entities": music,
    take: 50,
    page: 2,
  });
  const p1ids = new Set(places.map((e) => at(e, "entity_id")));
  line(p2, `overlapWithP1=${rows(p2).filter((e) => p1ids.has(at(e, "entity_id"))).length}`);

  // ---------- P0-4, P0-11: tags ----------
  for (const term of ["music venue", "concert", "comedy club", "comedy", "theater", "theatre", "record store", "bookstore", "bar", "nightclub", "live music"]) {
    const r = await q(`tags-${term.replace(/\W/g, "")}`, "/v2/tags", { "filter.query": term, take: 15 });
    const tags = list(at(r.body, "results", "tags")).length ? list(at(r.body, "results", "tags")) : rows(r);
    console.log(`[${r.status}] tags "${term}" n=${tags.length} ${tags.slice(0, 8).map((t) => String(at(t, "id") ?? at(t, "tag_id"))).join(" , ")}`);
  }

  // ---------- P0-5 / S5: artist candidates + explainability ----------
  const a1 = await q("artist-cands", "/v2/insights", {
    "filter.type": "urn:entity:artist",
    "signal.interests.entities": ids.jb,
    "filter.popularity.max": pops.jb,
    "filter.exclude.entities": ids.jb,
    "bias.trends": "high",
    take: 20,
    "feature.explainability": true,
  });
  const artists = rows(a1);
  line(a1, `first=${names(artists, 6, (e) => fmt(at(e, "popularity")))}`);
  report.artistQuery = at(artists[0], "query") ?? null;

  // ---------- P0-7: trending ----------
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 7 * 864e5);
  const window = { "filter.start_date": start.toISOString().slice(0, 10), "filter.end_date": end.toISOString().slice(0, 10), take: 30 };
  for (const [i, a] of artists.slice(0, 5).entries()) {
    const r = await q(`trending-artist-${i}`, "/v2/trending", {
      "filter.type": "urn:entity:artist",
      "signal.interests.entities": String(at(a, "entity_id")),
      ...window,
    });
    const tr = list(at(r.body, "results", "trending"));
    console.log(`[${r.status}] trending ${String(at(a, "name"))} weeks=${tr.length} last=${JSON.stringify(tr[0] ?? r.body).slice(0, 220)}`);
  }

  // ---------- P0-8: filter.results.entities on places, compared across candidates ----------
  const placeIds = places.slice(0, 12).map((e) => String(at(e, "entity_id"))).join(",");
  for (const [i, a] of artists.slice(0, 2).entries()) {
    const r = await q(`place-fit-cand-${i}`, "/v2/insights", {
      "filter.type": "urn:entity:place",
      "signal.interests.entities": String(at(a, "entity_id")),
      "filter.results.entities": placeIds,
      take: 12,
    });
    line(r, `${String(at(a, "name"))} affinities=${rows(r).slice(0, 6).map(affinity).join(",")}`);
  }

  // ---------- P0-6 / S6: brands + compare ----------
  const b1 = await q("brand-cands", "/v2/insights", {
    "filter.type": "urn:entity:brand",
    "signal.interests.entities": music,
    take: 20,
    "feature.explainability": true,
  });
  const brands = rows(b1);
  line(b1, `first=${names(brands, 6, (e) => fmt(at(e, "popularity")))}`);
  report.brandQuery = at(brands[0], "query") ?? null;
  const brandId = at(brands[0], "entity_id");
  if (typeof brandId === "string") {
    const c1 = await q("compare-seeds-brand", "/v2/analysis/compare", {
      "a.signal.interests.entities": music,
      "b.signal.interests.entities": brandId,
    });
    const cr = at(c1.body, "results");
    const common = list(at(cr, "tags"));
    console.log(
      `[${c1.status}] compare keys=${keysOf(cr)} common=${common.length} a=${list(at(cr, "a")).length} b=${list(at(cr, "b")).length} sample=${JSON.stringify(common[0] ?? list(at(cr, "a"))[0] ?? c1.body).slice(0, 250)}`,
    );
  }

  // ---------- P0-10: comedy / podcast support candidates ----------
  const pe = await q("person-cands", "/v2/insights", {
    "filter.type": "urn:entity:person",
    "signal.interests.entities": ids.bargatze,
    "filter.exclude.entities": ids.bargatze,
    take: 20,
    "feature.explainability": true,
  });
  line(pe, `first=${names(rows(pe), 8)}`);
  const po = await q("podcast-cands", "/v2/insights", {
    "filter.type": "urn:entity:podcast",
    "signal.interests.entities": ids.smartless,
    "filter.exclude.entities": ids.smartless,
    take: 20,
  });
  line(po, `first=${names(rows(po), 8)}`);
  for (const [key, type] of [["bargatze", "urn:entity:person"], ["smartless", "urn:entity:podcast"]] as const) {
    const r = await q(`trending-${key}`, "/v2/trending", { "filter.type": type, "signal.interests.entities": ids[key], ...window });
    const tr = list(at(r.body, "results", "trending"));
    console.log(`[${r.status}] trending ${key} weeks=${tr.length} last=${JSON.stringify(tr[0] ?? r.body).slice(0, 200)}`);
  }

  // ---------- Round 2: trending coverage ----------
  const trendProbes: Array<[string, string, string]> = [["Taylor Swift", "urn:entity:artist", "artist"], ["Olivia Rodrigo", "urn:entity:artist", "artist"]];
  for (const [query, type] of trendProbes) {
    const s = await q(`search-${query.replace(/\W/g, "")}`, "/search", { query, types: type, take: 1 });
    const id = at(rows(s)[0], "entity_id");
    if (typeof id !== "string") continue;
    const r = await q(`trending-${query.replace(/\W/g, "")}`, "/v2/trending", { "filter.type": type, "signal.interests.entities": id, ...window });
    console.log(`[${r.status}] trending ${query} weeks=${list(at(r.body, "results", "trending")).length}`);
  }
  for (const [key, type] of [["jb", "urn:entity:artist"], ["pastlives", "urn:entity:movie"], ["a24", "urn:entity:brand"], ["mfm", "urn:entity:podcast"]] as const) {
    const r = await q(`trending-seed-${key}`, "/v2/trending", { "filter.type": type, "signal.interests.entities": ids[key], ...window });
    const tr = list(at(r.body, "results", "trending"));
    const vel = tr.map((x) => at(x, "velocity_fold_change")).filter((v) => typeof v === "number" && v !== 0).length;
    console.log(`[${r.status}] trending seed ${key} weeks=${tr.length} nonzeroVelocityWeeks=${vel}`);
  }

  // ---------- Round 2: trend lift (bias.trends off vs high) ----------
  const a0 = await q("artist-cands-trends-off", "/v2/insights", {
    "filter.type": "urn:entity:artist",
    "signal.interests.entities": ids.jb,
    "filter.popularity.max": pops.jb,
    "filter.exclude.entities": ids.jb,
    "bias.trends": "off",
    take: 20,
  });
  const offRank: Record<string, number> = {};
  rows(a0).forEach((e, i) => (offRank[String(at(e, "entity_id"))] = i + 1));
  console.log(
    `[${a0.status}] trend lift (rank off -> high): ${artists
      .slice(0, 10)
      .map((e, i) => `${String(at(e, "name"))}:${offRank[String(at(e, "entity_id"))] ?? ">20"}->${i + 1}`)
      .join(" | ")}`,
  );

  // ---------- Round 2: compare variants ----------
  if (typeof brandId === "string") {
    for (const [name, extra] of [
      ["compare-type-place", { "filter.type": "urn:entity:place" }],
      ["compare-type-movie", { "filter.type": "urn:entity:movie" }],
      ["compare-subtype-genre", { "filter.subtype": "urn:tag:genre" }],
    ] as const) {
      const r = await q(name, "/v2/analysis/compare", { "a.signal.interests.entities": music, "b.signal.interests.entities": brandId, ...extra });
      const cr = at(r.body, "results");
      const a = list(at(cr, "a")).map((t) => String(at(t, "name")));
      const b = new Set(list(at(cr, "b")).map((t) => String(at(t, "name"))));
      console.log(
        `[${r.status}] ${name} common=${list(at(cr, "tags")).length} a=${a.length} b=${b.size} nameOverlap=${a.filter((n) => b.has(n)).length} match=${list(at(cr, "matchEntities")).length} sample=${JSON.stringify(list(at(cr, "tags"))[0] ?? list(at(cr, "matchEntities"))[0] ?? "").slice(0, 200)}`,
      );
    }
    // Brand audience vs stop places: same place set as the opener city fit.
    for (const [i, br] of brands.slice(0, 3).entries()) {
      const r = await q(`brand-place-fit-${i}`, "/v2/insights", {
        "filter.type": "urn:entity:place",
        "signal.interests.entities": String(at(br, "entity_id")),
        "filter.results.entities": placeIds,
        take: 12,
      });
      line(r, `${String(at(br, "name"))} affinities=${rows(r).slice(0, 6).map(affinity).join(",")}`);
    }
  }

  // ---------- Round 2: venue and partner searches with tags ----------
  const venueProbes: Array<[string, string, string, string]> = [
    ["venue-music-philly", "Philadelphia", "urn:tag:genre:place:live_music_venue", music],
    ["venue-concerthall-philly", "Philadelphia", "urn:tag:genre:place:concert_hall", music],
    ["venue-comedy-philly", "Philadelphia", "urn:tag:genre:place:comedy_club", ids.bargatze],
    ["partner-record-philly", "Philadelphia", "urn:tag:genre:place:record_store", music],
    ["partner-books-philly", "Philadelphia", "urn:tag:genre:place:book_store", music],
    ["partner-bar-philly", "Philadelphia", "urn:tag:genre:place:restaurant:bar", music],
  ];
  for (const [name, city, tag, signal] of venueProbes) {
    const r = await q(name, "/v2/insights", {
      "filter.type": "urn:entity:place",
      "filter.location.query": city,
      "filter.tags": tag,
      "signal.interests.entities": signal,
      take: 10,
      "feature.explainability": true,
    });
    line(r, `first=${names(rows(r), 6, (e) => String(at(e, "properties", "neighborhood") ?? "-"))}`);
  }
  for (const term of ["performing arts", "auditorium", "arena", "amphitheater", "intimate", "small venue", "large venue", "standing room"]) {
    const r = await q(`tags2-${term.replace(/\W/g, "")}`, "/v2/tags", { "filter.query": term, take: 10 });
    const tags = list(at(r.body, "results", "tags"));
    console.log(`[${r.status}] tags "${term}" ${tags.slice(0, 8).map((t) => String(at(t, "id"))).join(" , ")}`);
  }

  // ---------- Round 2: comedian filter, non-music heatmaps ----------
  const pe2 = await q("person-cands-comedian", "/v2/insights", {
    "filter.type": "urn:entity:person",
    "signal.interests.entities": ids.bargatze,
    "filter.exclude.entities": ids.bargatze,
    "filter.tags": "urn:tag:genre:person:comedian",
    "filter.popularity.max": pops.bargatze,
    take: 20,
  });
  line(pe2, `first=${names(rows(pe2), 8, (e) => fmt(at(e, "popularity")))}`);
  for (const [key, city] of [["bargatze", "Boston"], ["smartless", "Chicago"]] as const) {
    const r = await q(`heatmap-${key}`, "/v2/insights", { "filter.type": "urn:heatmap", "filter.location.query": city, "signal.interests.entities": ids[key] });
    console.log(`[${r.status}] heatmap ${key} ${city} cells=${list(at(r.body, "results", "heatmap")).length}`);
  }

  // ---------- Round 3: venue size tags, non-music city ranking and venues ----------
  for (const [name, tags] of [
    ["venue-size-small", "urn:tag:genre:place:live_music_venue,urn:tag:setting:qloo:small_intimate_venue"],
    ["venue-size-large", "urn:tag:genre:place:live_music_venue,urn:tag:setting:qloo:large_venue"],
  ] as const) {
    const r = await q(name, "/v2/insights", {
      "filter.type": "urn:entity:place",
      "filter.location.query": "Philadelphia",
      "filter.tags": tags,
      "operator.filter.tags": "intersection",
      "signal.interests.entities": music,
      take: 10,
    });
    line(r, `first=${names(rows(r), 8)}`);
  }
  for (const key of ["bargatze", "smartless"] as const) {
    const r = await q(`dest-results-${key}`, "/v2/insights", {
      "filter.type": "urn:entity:destination",
      "signal.interests.entities": ids[key],
      "filter.results.entities": Object.values(cityIds).join(","),
      take: 20,
      "feature.explainability": true,
    });
    line(r, `ranked=${names(rows(r), 8, affinity)}`);
  }
  const pv = await q("venue-podcast-chicago", "/v2/insights", {
    "filter.type": "urn:entity:place",
    "filter.location.query": "Chicago",
    "filter.tags": "urn:tag:genre:place:performing_arts_theater",
    "signal.interests.entities": ids.smartless,
    take: 10,
  });
  line(pv, `first=${names(rows(pv), 8)}`);

  // ---------- Round 4: cross-city comparability and non-music anchor presets ----------
  const bv = await q("venue-music-boston", "/v2/insights", {
    "filter.type": "urn:entity:place",
    "filter.location.query": "Boston",
    "filter.tags": "urn:tag:genre:place:live_music_venue",
    "signal.interests.entities": music,
    take: 10,
  });
  const pv1 = await q("venue-music-philly", "/v2/insights", {
    "filter.type": "urn:entity:place",
    "filter.location.query": "Philadelphia",
    "filter.tags": "urn:tag:genre:place:live_music_venue",
    "signal.interests.entities": music,
    take: 10,
    "feature.explainability": true,
  });
  const mean = (xs: unknown[]): number => {
    const v = xs.map((e) => at(e, "query", "affinity")).filter((x): x is number => typeof x === "number");
    return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  };
  const joint = await q("venue-joint-philly-boston", "/v2/insights", {
    "filter.type": "urn:entity:place",
    "signal.interests.entities": music,
    "filter.results.entities": [...rows(pv1), ...rows(bv)].map((e) => String(at(e, "entity_id"))).join(","),
    take: 20,
  });
  const bostonIds = new Set(rows(bv).map((e) => at(e, "entity_id")));
  const jointRows = rows(joint);
  console.log(
    `[${joint.status}] cross-city separate: philly=${mean(rows(pv1)).toFixed(3)} boston=${mean(rows(bv)).toFixed(3)} | joint: philly=${mean(jointRows.filter((e) => !bostonIds.has(at(e, "entity_id")))).toFixed(3)} boston=${mean(jointRows.filter((e) => bostonIds.has(at(e, "entity_id")))).toFixed(3)} n=${jointRows.length}`,
  );
  for (const [key, seeds] of [["standup", [ids.bargatze, ids.tedlasso]], ["podcast", [ids.smartless, ids.omitb]]] as const) {
    const r = await q(`dest-preset-${key}`, "/v2/insights", {
      "filter.type": "urn:entity:destination",
      "signal.interests.entities": seeds.join(","),
      "filter.results.entities": Object.values(cityIds).join(","),
      take: 20,
      "feature.explainability": true,
    });
    line(r, `ranked=${names(rows(r), 8, affinity)}`);
  }

  // ---------- P0-9: rate limit headers ----------
  report.rateHeaders = (await q("rate-check", "/search", { query: "Boston", types: "urn:entity:destination", take: 1 })).rate;
  console.log("REPORT", JSON.stringify({ ids, pops, cityIds, ...report }, null, 2));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

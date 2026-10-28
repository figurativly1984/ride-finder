// Builds the compact timetable the website routes over.
// Inputs: MARTA's GTFS zip, Emory's shuttle GTFS (if Passio publishes one) or emory-shuttles.json.
// Output: site/data/*.json
//
// Usage: node build/build.mjs [--marta path-or-url] [--emory path-or-url] [--out site/data] [--days 45]
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const MARTA_SRC = args.marta || process.env.MARTA_GTFS_URL || "https://itsmarta.com/google_transit_feed/google_transit.zip";
const EMORY_SRC = args.emory ?? process.env.EMORY_GTFS_URL ?? "https://passio3.com/emory/passioTransit/gtfs/google_transit.zip";
const OUT = args.out || join(HERE, "..", "site", "data");
const WINDOW_DAYS = parseInt(args.days || "45", 10);
const TODAY = args.today || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).replaceAll("-", "");

// ---------- small utilities ----------
function parseCSVLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
}
async function eachRow(file, fn) {
  if (!existsSync(file)) return false;
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  let header = null;
  for await (let line of rl) {
    if (!header) { header = parseCSVLine(line.replace(/^﻿/, "")).map(h => h.trim()); continue; }
    if (!line.trim()) continue;
    const v = parseCSVLine(line); const row = {};
    header.forEach((h, i) => (row[h] = (v[i] ?? "").trim()));
    fn(row);
  }
  return true;
}
const toMin = t => { const [h, m, s] = t.split(":").map(Number); return Math.round(h * 60 + m + (s || 0) / 60); };
const ymd = d => d.toISOString().slice(0, 10).replaceAll("-", "");
const parseYmd = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const windowDates = (() => { const out = []; const d0 = parseYmd(TODAY); d0.setUTCDate(d0.getUTCDate() - 1); for (let i = 0; i <= WINDOW_DAYS; i++) { const d = new Date(d0); d.setUTCDate(d.getUTCDate() + i); out.push(ymd(d)); } return out; })();
const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

async function fetchZip(src, label) {
  const dir = mkdtempSync(join(tmpdir(), "gtfs-"));
  let zip = src;
  if (/^https?:/.test(src)) {
    const res = await fetch(src, { headers: { "User-Agent": "ride-finder-build (github.com/figurativly1984/ride-finder)" }, redirect: "follow" });
    if (!res.ok) throw new Error(`${label}: download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`${label}: not a zip file`);
    zip = join(dir, "feed.zip"); writeFileSync(zip, buf);
  }
  execFileSync("unzip", ["-o", "-q", zip, "-d", dir]);
  return dir;
}

// ---------- GTFS feed → common model ----------
// model: { stops: Map(id -> {name,lat,lon}), routes: Map(id -> {...}), services: Map(id -> Set(dates)), trips: [{id, route, service, stops:[ids], times:[min]}] }
async function readGTFS(dir, label) {
  const stops = new Map(), routes = new Map(), services = new Map(), tripMeta = new Map(), tripStops = new Map();
  await eachRow(join(dir, "stops.txt"), r => { if (r.location_type && r.location_type !== "0") return; stops.set(r.stop_id, { name: r.stop_name, lat: +r.stop_lat, lon: +r.stop_lon }); });
  await eachRow(join(dir, "routes.txt"), r => routes.set(r.route_id, { short: r.route_short_name, long: r.route_long_name, type: +r.route_type, color: r.route_color || "", text: r.route_text_color || "" }));
  const inWindow = new Set(windowDates);
  await eachRow(join(dir, "calendar.txt"), r => {
    const set = new Set();
    for (const d of windowDates) { if (d < r.start_date || d > r.end_date) continue; if (r[DOW[parseYmd(d).getUTCDay()]] === "1") set.add(d); }
    services.set(r.service_id, set);
  });
  await eachRow(join(dir, "calendar_dates.txt"), r => {
    if (!inWindow.has(r.date)) { if (!services.has(r.service_id)) services.set(r.service_id, new Set()); return; }
    if (!services.has(r.service_id)) services.set(r.service_id, new Set());
    if (r.exception_type === "1") services.get(r.service_id).add(r.date); else services.get(r.service_id).delete(r.date);
  });
  await eachRow(join(dir, "trips.txt"), r => { const s = services.get(r.service_id); if (s && s.size) tripMeta.set(r.trip_id, { route: r.route_id, service: r.service_id, headsign: r.trip_headsign || "" }); });
  let rows = 0;
  await eachRow(join(dir, "stop_times.txt"), r => {
    if (!tripMeta.has(r.trip_id)) return;
    const t = r.departure_time || r.arrival_time; if (!t) return; // untimed stops are skipped
    let a = tripStops.get(r.trip_id); if (!a) tripStops.set(r.trip_id, (a = []));
    a.push([+r.stop_sequence, r.stop_id, toMin(t)]); rows++;
  });
  const trips = [];
  for (const [id, list] of tripStops) {
    list.sort((x, y) => x[0] - y[0]);
    const m = tripMeta.get(id);
    trips.push({ id, route: m.route, service: m.service, headsign: m.headsign, stops: list.map(x => x[1]), times: list.map(x => x[2]) });
  }
  console.log(`${label}: ${stops.size} stops, ${routes.size} routes, ${trips.length} trips in window, ${rows} stop times`);
  return { stops, routes, services, trips };
}

// Emory fallback: expand emory-shuttles.json into the same model
function readEmoryJSON() {
  const j = JSON.parse(readFileSync(join(HERE, "emory-shuttles.json"), "utf8"));
  const stops = new Map(Object.entries(j.stops).map(([k, v]) => [k, { name: v.name, lat: v.lat, lon: v.lon }]));
  const routes = new Map(), services = new Map([["wk", new Set()], ["we", new Set()]]);
  for (const d of windowDates) { const w = parseYmd(d).getUTCDay(); services.get(w === 0 || w === 6 ? "we" : "wk").add(d); }
  const trips = [];
  for (const r of j.routes) {
    routes.set(r.id, { short: r.id, long: r.name, type: 3, color: "012169", text: "FFFFFF" });
    r.trips.forEach((spec, si) => {
      const starts = spec.starts ? spec.starts.map(toMin) : (() => { const a = []; for (let t = toMin(spec.first); t <= toMin(spec.last); t += spec.headway) a.push(t); return a; })();
      starts.forEach((t0, k) => trips.push({ id: `E-${r.id}-${spec.days}-${si}-${k}`, route: r.id, service: spec.days, headsign: j.stops[spec.pattern[spec.pattern.length - 1][0]].name, stops: spec.pattern.map(p => p[0]), times: spec.pattern.map(p => t0 + p[1]) }));
    });
  }
  console.log(`Emory (posted timetables): ${stops.size} stops, ${routes.size} routes, ${trips.length} trips`);
  return { stops, routes, services, trips, source: "timetables" };
}

// ---------- merge and encode ----------
function hav(a, b) { const R = 6371000, t = x => (x * Math.PI) / 180; const dLa = t(b.lat - a.lat), dLo = t(b.lon - a.lon); const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }

function encode(feeds) {
  const stopIdx = new Map(), stops = [], routeIdx = new Map(), routes = [], serviceIdx = new Map(), services = [];
  const sKey = (a, id) => a + ":" + id;
  feeds.forEach((f, agency) => {
    const used = new Set(f.trips.flatMap(t => t.stops));
    for (const id of used) { const s = f.stops.get(id); if (!s || !isFinite(s.lat)) continue; stopIdx.set(sKey(agency, id), stops.length); stops.push([id, s.name, +s.lat.toFixed(6), +s.lon.toFixed(6), agency]); }
    for (const [id, r] of f.routes) { routeIdx.set(sKey(agency, id), routes.length); routes.push([agency, r.short, r.long, r.type, r.color, r.text]); }
    for (const [id, set] of f.services) { if (!set.size) continue; serviceIdx.set(sKey(agency, id), services.length); services.push({ a: agency, id, dates: [...set].sort() }); }
  });
  // patterns per service
  const bySvc = services.map(() => new Map());
  feeds.forEach((f, agency) => {
    for (const t of f.trips) {
      const si = serviceIdx.get(sKey(agency, t.service)), ri = routeIdx.get(sKey(agency, t.route));
      if (si == null || ri == null) continue;
      const idx = t.stops.map(id => stopIdx.get(sKey(agency, id)));
      if (idx.some(x => x == null) || idx.length < 2) continue;
      const key = ri + "|" + idx.join(",");
      let p = bySvc[si].get(key); if (!p) bySvc[si].set(key, (p = { r: ri, h: t.headsign, s: idx, t: [] }));
      const d = [t.id, t.times[0]]; for (let i = 1; i < t.times.length; i++) d.push(Math.max(0, t.times[i] - t.times[i - 1]));
      p.t.push(d);
    }
  });
  const svcFiles = bySvc.map((m, i) => { const p = [...m.values()]; p.forEach(x => x.t.sort((a, b) => a[1] - b[1])); return { file: `svc-${i}.json`, p }; });
  // footpaths: stops within 400 m, nearest 15
  const cell = 0.005, grid = new Map(); const gk = (la, lo) => Math.floor(la / cell) + "," + Math.floor(lo / cell);
  stops.forEach((s, i) => { const k = gk(s[2], s[3]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const transfers = stops.map((s, i) => {
    const a = { lat: s[2], lon: s[3] }, ci = Math.floor(s[2] / cell), cj = Math.floor(s[3] / cell), near = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const j of grid.get(ci + di + "," + (cj + dj)) || []) {
      if (j === i) continue; const d = hav(a, { lat: stops[j][2], lon: stops[j][3] }); if (d <= 400) near.push([j, d]);
    }
    near.sort((x, y) => x[1] - y[1]);
    return near.slice(0, 15).map(([j, d]) => [j, Math.max(1, Math.ceil((d * 1.25) / 80))]);
  });
  return { stops, routes, services, svcFiles, transfers };
}

// ---------- main ----------
const marta = await readGTFS(await fetchZip(MARTA_SRC, "MARTA"), "MARTA");
if (!marta.trips.length) throw new Error("MARTA feed has no trips in the next " + WINDOW_DAYS + " days");
let emory = null;
if (EMORY_SRC && EMORY_SRC !== "none") {
  try { emory = await readGTFS(await fetchZip(EMORY_SRC, "Emory"), "Emory GTFS"); if (!emory.trips.length) { console.log("Emory GTFS has no current trips; using posted timetables."); emory = null; } else emory.source = "gtfs"; }
  catch (e) { console.log("Emory GTFS unavailable (" + e.message + "); using posted timetables."); }
}
if (!emory) emory = readEmoryJSON();

const enc = encode([marta, emory]);
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });
const write = (name, obj) => { const s = JSON.stringify(obj); writeFileSync(join(OUT, name), s); return s.length; };
let total = 0;
total += write("stops.json", enc.stops);
total += write("routes.json", enc.routes);
total += write("transfers.json", enc.transfers);
total += write("services.json", enc.services.map((s, i) => ({ a: s.a, id: s.id, dates: s.dates, file: enc.svcFiles[i].file })));
enc.svcFiles.forEach(f => (total += write(f.file, f.p)));
write("meta.json", { built: new Date().toISOString(), today: TODAY, windowDays: WINDOW_DAYS, emorySource: emory.source, marta: MARTA_SRC });
console.log(`Wrote ${enc.stops.length} stops, ${enc.routes.length} routes, ${enc.services.length} services, ${(total / 1e6).toFixed(1)} MB to ${OUT}`);

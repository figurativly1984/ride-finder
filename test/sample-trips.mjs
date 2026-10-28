// Plans a few real trips on the built timetable and prints them (used as a smoke test in CI).
import { Network, raptor } from "../site/router.js";
import { readFileSync } from "node:fs";
const dir = process.argv[2] || "site/data";
const J = f => JSON.parse(readFileSync(dir + "/" + f, "utf8"));
const meta = J("meta.json");
const net = new Network({ stops: J("stops.json"), routes: J("routes.json"), transfers: J("transfers.json"), services: J("services.json") });
// next weekday after the build date
let ymd = meta.today; const dow = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))).getUTCDay();
const next = s => { const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8) + 1)); return d.toISOString().slice(0, 10).replaceAll("-", ""); };
ymd = next(ymd); while ([0, 6].includes(dow(ymd))) ymd = next(ymd);
const day = await net.loadDay(ymd, async f => J(f));
const fmt = m => { m = Math.round(m); return `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, "0")}`; };
const P = { "Clairmont Campus": [33.7985, -84.3125], "Woodruff Library": [33.7906, -84.3244], "Emory Hospital": [33.7925, -84.3206], "Ponce City Market": [33.7726, -84.3655], "Decatur Square": [33.7748, -84.2963], "Airport": [33.6407, -84.4462], "Lindbergh Center": [33.8236, -84.3696], "Georgia Tech": [33.7756, -84.3963], "Indian Trail P&R": [33.9298, -84.1753] };
const trips = [["Clairmont Campus", "Ponce City Market", 8 * 60], ["Woodruff Library", "Airport", 15 * 60 + 30], ["Ponce City Market", "Clairmont Campus", 18 * 60], ["Decatur Square", "Emory Hospital", 7 * 60 + 30], ["Georgia Tech", "Woodruff Library", 12 * 60], ["Lindbergh Center", "Clairmont Campus", 22 * 60 + 30], ["Indian Trail P&R", "Emory Hospital", 6 * 60 + 30], ["Emory Hospital", "Indian Trail P&R", 16 * 60 + 15], ["Woodruff Library", "Indian Trail P&R", 18 * 60]];
const out = [];
for (const [a, b, t0] of trips) {
  const o = { lat: P[a][0], lon: P[a][1] }, d = { lat: P[b][0], lon: P[b][1] };
  const t1 = Date.now(); const js = raptor(net, day, { origin: o, dest: d, t0 }); const ms = Date.now() - t1;
  out.push(`${a} -> ${b} at ${fmt(t0)} on ${ymd} (${ms} ms): ` + (js.length ? js.map(j => `[${Math.round(j.arrive - t0)} min, arrive ${fmt(j.arrive)}] ` + j.legs.map(l => l.type === "walk" ? `walk ${l.mins}` : `${net.routes[l.pattern.r][1]}${net.routes[l.pattern.r][0] ? "(" + (meta.agencies[net.routes[l.pattern.r][0]] || {}).name + ")" : ""} ${net.stops[l.from][1]} ${fmt(l.trip.times[l.fromPos])} > ${net.stops[l.to][1]} ${fmt(l.trip.times[l.toPos])}`).join(" | ")).join("  ||  ") : "NO TRIP FOUND"));
}
for (const line of out) console.log(line);
// Diagnostics for the regional services
for (const [ai, a] of (meta.agencies || []).entries()) {
  if (ai < 2) continue;
  const rs = net.routes.filter(r => r[0] === ai).map(r => `${r[1]} ${r[2]}`.trim());
  const pats = day.patterns.filter(p => p.agency === ai);
  console.log(`${a.name}${a.staleSince ? " (schedule ended " + a.staleSince + ")" : ""}: ${rs.length} routes [${rs.slice(0, 25).join("; ")}], ${pats.reduce((n, p) => n + p.trips.length, 0)} trips on ${ymd}`);
}
const it = P["Indian Trail P&R"];
const near = net.nearStops(it[0], it[1], 3000).slice(0, 8).map(([s, w, d]) => `${net.stops[s][1]} [${(meta.agencies[net.stops[s][4]] || {}).name}] ${Math.round(d)}m`);
console.log("Stops near Indian Trail P&R point: " + near.join("; "));
const x415 = day.patterns.filter(p => /415/.test(net.routes[p.r][1]));
console.log("Route 415 patterns on " + ymd + ": " + x415.map(p => `${p.trips.length} trips: ${net.stops[p.s[0]][1]} -> ${net.stops[p.s[p.s.length - 1]][1]} (first ${Math.floor(p.trips[0].times[0] / 60)}:${String(p.trips[0].times[0] % 60).padStart(2, "0")})`).join(" | "));
console.log("Stops named Indian Trail: " + net.stops.filter(s => /indian trail/i.test(s[1])).map(s => `${s[1]} [${(meta.agencies[s[4]] || {}).name}] ${s[2]},${s[3]}`).join("; "));
console.log("Route 415 stops: " + x415.map(p => p.s.map(i => net.stops[i][1]).join(" > ")).join(" || "));

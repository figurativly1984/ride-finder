// Trip planner over the combined MARTA + Emory shuttle timetable (RAPTOR algorithm).
// Times are minutes after midnight (America/New_York) of the service date.
export const WALK_M_PER_MIN = 80, DETOUR = 1.25;
const INF = 1e9;

export function hav(aLat, aLon, bLat, bLon) {
  const R = 6371000, t = x => (x * Math.PI) / 180;
  const dLa = t(bLat - aLat), dLo = t(bLon - aLon);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(aLat)) * Math.cos(t(bLat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const walkMinutes = m => Math.max(1, Math.ceil((m * DETOUR) / WALK_M_PER_MIN));

export class Network {
  constructor({ stops, routes, transfers, services }) {
    this.stops = stops; this.routes = routes; this.transfers = transfers; this.services = services;
    this.dayCache = new Map();
  }
  // Loads every trip running on `ymd` (plus late trips from the day before that run past midnight).
  async loadDay(ymd, fetchJson) {
    if (this.dayCache.has(ymd)) return this.dayCache.get(ymd);
    const prev = shiftYmd(ymd, -1);
    const want = [];
    this.services.forEach(s => { if (s.dates.includes(ymd)) want.push([s, 0]); if (s.dates.includes(prev)) want.push([s, -1440]); });
    const files = await Promise.all(want.map(([s]) => fetchJson(s.file)));
    const patterns = [];
    files.forEach((pats, i) => {
      const off = want[i][1];
      for (const p of pats) {
        const trips = [];
        for (const t of p.t) {
          const n = p.s.length, times = new Int32Array(n); let x = t[1] + off;
          times[0] = x; for (let k = 1; k < n; k++) { x += t[k + 1]; times[k] = x; }
          if (off < 0 && times[n - 1] < 0) continue; // finished before midnight
          trips.push({ id: String(t[0]), times });
        }
        if (!trips.length) continue;
        trips.sort((a, b) => a.times[0] - b.times[0]);
        patterns.push({ r: p.r, h: p.h, s: p.s, trips, agency: this.routes[p.r][0], maxRun: 0 });
      }
    });
    const stopPatterns = this.stops.map(() => []);
    patterns.forEach((p, pi) => p.s.forEach((s, pos) => stopPatterns[s].push([pi, pos])));
    const tripIndex = new Map();
    patterns.forEach((p, pi) => p.trips.forEach((t, ti) => tripIndex.set(t.id, [pi, ti])));
    const day = { ymd, patterns, stopPatterns, tripIndex };
    this.dayCache.set(ymd, day);
    return day;
  }
  nearStops(lat, lon, maxM) {
    const out = [];
    this.stops.forEach((s, i) => { const d = hav(lat, lon, s[2], s[3]); if (d <= maxM) out.push([i, walkMinutes(d), d]); });
    return out.sort((a, b) => a[2] - b[2]);
  }
}

export function shiftYmd(ymd, days) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + days));
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

// opts: { origin:{lat,lon}, dest:{lat,lon}, t0, maxRounds, allow(agency)->bool, delays: Map(tripId -> minutes), maxWalkM }
export function raptor(net, day, opts) {
  const { origin, dest, t0 } = opts;
  const K = opts.maxRounds || 5, allow = opts.allow || (() => true), delays = opts.delays || new Map();
  const maxWalk = opts.maxWalkM || 800;
  const n = net.stops.length;
  const near = (pt, m) => net.nearStops(pt.lat, pt.lon, m).filter(([s]) => allow(net.stops[s][4]));
  let access = near(origin, maxWalk); if (!access.length) access = near(origin, maxWalk * 2);
  let egress = near(dest, maxWalk); if (!egress.length) egress = near(dest, maxWalk * 2);
  const egressMin = new Map(egress.map(([s, w]) => [s, w]));
  const tau = [new Float64Array(n).fill(INF)], parent = [new Array(n).fill(null)];
  const best = new Float64Array(n).fill(INF);
  let marked = new Set();
  for (const [s, w] of access) { tau[0][s] = t0 + w; best[s] = t0 + w; parent[0][s] = { type: "access", mins: w }; marked.add(s); }
  const tt = (trip, pos) => trip.times[pos] + (delays.get(trip.id) || 0);
  let targetBest = INF;
  const journeys = [];
  for (let k = 1; k <= K && marked.size; k++) {
    tau[k] = Float64Array.from(tau[k - 1]); parent[k] = parent[k - 1].slice();
    const Q = new Map();
    for (const s of marked) for (const [pi, pos] of day.stopPatterns[s]) {
      if (!allow(day.patterns[pi].agency)) continue;
      const q = Q.get(pi); if (q == null || pos < q) Q.set(pi, pos);
    }
    const newly = new Set();
    for (const [pi, pos0] of Q) {
      const p = day.patterns[pi], trips = p.trips;
      let trip = null, boardPos = -1;
      for (let pos = pos0; pos < p.s.length; pos++) {
        const s = p.s[pos];
        if (trip) {
          const arr = tt(trip, pos);
          if (arr < best[s] && arr < targetBest) { tau[k][s] = arr; best[s] = arr; parent[k][s] = { type: "ride", pi, trip, from: boardPos, to: pos }; newly.add(s); }
        }
        const prevArr = tau[k - 1][s];
        if (prevArr >= INF) continue;
        const ready = prevArr + (k > 1 && parent[k - 1][s] && parent[k - 1][s].type === "ride" ? 1 : 0);
        if (trip && tt(trip, pos) <= ready) continue;
        // earliest trip departing at/after `ready` (allowing for live delays)
        let lo = 0, hi = trips.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (trips[m].times[pos] < ready - 45) lo = m + 1; else hi = m; }
        let bestTrip = null, bestDep = INF;
        for (let i = lo; i < trips.length; i++) {
          const base = trips[i].times[pos]; if (base > ready + 240 || base > bestDep + 45) break;
          const dep = tt(trips[i], pos);
          if (dep >= ready && dep < bestDep) { bestDep = dep; bestTrip = trips[i]; }
        }
        if (bestTrip && (!trip || bestDep < tt(trip, pos))) { trip = bestTrip; boardPos = pos; }
      }
    }
    // walking transfers
    marked = new Set(newly);
    for (const s of newly) for (const [j, w] of net.transfers[s]) {
      const t = tau[k][s] + w;
      if (t < best[j] && t < targetBest) { tau[k][j] = t; best[j] = t; parent[k][j] = { type: "walk", from: s, mins: w }; marked.add(j); }
    }
    // best arrival at the destination using k vehicles
    let arr = INF, via = -1;
    for (const [s, w] of egressMin) { const a = tau[k][s] + w; if (a < arr) { arr = a; via = s; } }
    if (via >= 0 && arr < targetBest) { targetBest = arr; journeys.push(reconstruct(net, day, parent, tau, k, via, egressMin.get(via), arr, t0)); }
  }
  return journeys;
}

function reconstruct(net, day, parent, tau, k, stop, egressWalk, arrive, t0) {
  const legs = [{ type: "walk", to: null, mins: egressWalk, end: true }];
  let s = stop, kk = k, guard = 0;
  while (guard++ < 50) {
    const p = parent[kk][s];
    if (!p) break;
    if (p.type === "access") { legs.push({ type: "walk", from: null, to: s, mins: p.mins, start: true }); break; }
    if (p.type === "walk") { legs.push({ type: "walk", from: p.from, to: s, mins: p.mins }); s = p.from; continue; }
    const pat = day.patterns[p.pi];
    legs.push({ type: "ride", pattern: pat, trip: p.trip, fromPos: p.from, toPos: p.to, from: pat.s[p.from], to: pat.s[p.to] });
    s = pat.s[p.from]; kk -= 1;
  }
  legs.reverse();
  // merge consecutive walks, drop zero walks
  const out = [];
  for (const l of legs) {
    const last = out[out.length - 1];
    if (l.type === "walk" && last && last.type === "walk") { last.mins += l.mins; last.to = l.to; if (l.end) last.end = true; continue; }
    out.push(l);
  }
  return { legs: out, arrive, depart: t0, rides: out.filter(l => l.type === "ride").length };
}

// Departure time of the first vehicle minus the walk to it = latest time you can leave.
export function leaveBy(j, delays) {
  const first = j.legs.find(l => l.type === "ride");
  if (!first) return j.depart;
  const walk = j.legs[0].type === "walk" ? j.legs[0].mins : 0;
  return first.trip.times[first.fromPos] + ((delays && delays.get(first.trip.id)) || 0) - walk;
}

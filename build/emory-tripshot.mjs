// Reads Emory's shuttle schedules from TripShot (emory.tripshot.com), the system behind
// Emory's live shuttle tracker, and returns them in the build's common model.
//
// Two kinds of routes come back:
//   exact timetables  - every trip with a time at every stop (most routes)
//   headway service   - "every 3-20 minutes between 5 am and midnight" plus stop-to-stop
//                       driving times (e.g. the C Route on weekdays). For these we lay out
//                       trips at the middle of the stated range and mark them as estimates.
export const TRIPSHOT = "https://emory.tripshot.com";
export const EMORY_REGION = "ca558ddc-d7f2-4b48-9cac-deea1134f820";
const UA = { "User-Agent": "ride-finder-build (github.com/figurativly1984/ride-finder)" };

const toMin = t => { const [h, m, s] = String(t).split(":").map(Number); return h * 60 + m + Math.round((s || 0) / 60); };
const iso = ymd => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const dayKey = d => `${d.year}${String(d.month).padStart(2, "0")}${String(d.day).padStart(2, "0")}`;
const hex = c => String(c || "").replace("#", "").toUpperCase();

async function getJSON(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return r.json();
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// Turns one route's schedule for one day into trips. Exported for testing with saved responses.
export function parseRouteDay(details, ymd, routeKey, stops) {
  const trips = [];
  const addStop = s => { if (!stops.has(s.stopId)) stops.set(s.stopId, { name: s.name, lat: s.location.lt, lon: s.location.lg }); };
  for (const tt of details.exactTimetables || []) {
    (tt.stops || []).filter(Boolean).forEach(addStop);
    for (const tr of tt.trips || []) {
      if (tr.day && dayKey(tr.day) !== ymd) continue;
      const st = (tr.stops || []).filter(s => s && s.stop && s.arrivalTime);
      if (st.length < 2) continue;
      const times = st.map(s => toMin(s.arrivalTime));
      for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) times[i] += 1440; // runs past midnight
      const last = stops.get(st[st.length - 1].stop);
      trips.push({ id: "E:" + tr.sharedTripId, route: routeKey, service: ymd, headsign: last && st[0].stop !== st[st.length - 1].stop ? last.name : "", stops: st.map(s => s.stop), times });
    }
  }
  for (const it of details.inexactTimetables || []) {
    (it.stops || []).filter(Boolean).forEach(addStop);
    const seq = (it.stops || []).filter(Boolean).map(s => s.stopId);
    if (seq.length < 2) continue;
    // stop-to-stop driving time from the route's navigation legs
    const legSec = new Map();
    for (const nav of it.navigations || []) for (const leg of nav.legs || []) {
      const a = leg.startPoint && leg.startPoint.NavViaStop && leg.startPoint.NavViaStop.stopId, b = leg.endPoint && leg.endPoint.NavViaStop && leg.endPoint.NavViaStop.stopId;
      if (a && b) legSec.set(a + ">" + b, (leg.steps || []).reduce((n, s) => n + (s.durationSec || 0), 0));
    }
    const loop = [...seq, seq[0]]; const offs = [0];
    // driving time per link; where the route data has no leg (e.g. closing the loop), estimate from distance at ~20 km/h
    const est = (x, y) => { const A = stops.get(x), B = stops.get(y); if (!A || !B) return 120; const R = 6371000, r = v => v * Math.PI / 180; const h = Math.sin(r(B.lat - A.lat) / 2) ** 2 + Math.cos(r(A.lat)) * Math.cos(r(B.lat)) * Math.sin(r(B.lon - A.lon) / 2) ** 2; return (2 * R * Math.asin(Math.sqrt(h)) * 1.4) / 5.5; };
    for (let i = 1; i < loop.length; i++) offs.push(offs[i - 1] + Math.max(1, Math.round(((legSec.get(loop[i - 1] + ">" + loop[i]) ?? est(loop[i - 1], loop[i])) + 20) / 60)));
    const [lo, hi] = it.headwayRangeSec || [600, 600];
    const hw = Math.max(5, Math.round((lo + hi) / 2 / 60));
    for (const iv of it.timeIntervals || []) {
      if (iv.day && dayKey(iv.day) !== ymd) continue;
      const start = toMin(iv.startTime), end = toMin(iv.endTime);
      let k = 0;
      for (let t = start; t + offs[offs.length - 1] <= end + 5; t += hw) {
        trips.push({ id: `E:h-${Math.round(lo / 60)}-${Math.round(hi / 60)}-${routeKey.slice(0, 8)}-${ymd}-${k++}`, route: routeKey, service: ymd, headsign: "", stops: loop, times: offs.map(o => t + o), headway: [Math.round(lo / 60), Math.round(hi / 60)] });
      }
    }
  }
  return trips;
}

// dates: ["YYYYMMDD", ...]. Returns { stops, routes, services, trips, source, routeExtIds }.
export async function readEmoryTripShot(dates, fetchImpl = fetch, log = console.log) {
  const today = dates[Math.min(1, dates.length - 1)];
  const list = await getJSON(`${TRIPSHOT}/v1/p/shared/route?includePreviousDayRidesSpanningMidnight=true&startDay=${iso(today)}&endDay=${iso(dates[dates.length - 1])}&regionId=${EMORY_REGION}`, fetchImpl);
  const routeList = (list.routes || []).map(r => Object.values(r)[0]).filter(r => r && r.routeId);
  if (!routeList.length) throw new Error("TripShot returned no routes");
  const stops = new Map(), routes = new Map(), services = new Map(dates.map(d => [d, new Set([d])])), trips = [];
  for (const r of routeList) routes.set(r.routeId, { short: r.shortName || r.announcedAs || r.name, long: r.publicName || r.name, type: 3, color: hex(r.color) || "012169", text: "FFFFFF", ext: r.routeId });
  const jobs = routeList.flatMap(r => dates.map(d => [r, d]));
  let ok = 0, failed = 0;
  await pool(jobs, 5, async ([r, d]) => {
    try {
      const j = await getJSON(`${TRIPSHOT}/v3/p/shared/route/${r.routeId}?day=${iso(d)}&breakupExactLoops=true&includePreviousDayRidesSpanningMidnight=true`, fetchImpl);
      const det = j.InternalRouteDetails || Object.values(j)[0];
      for (const t of parseRouteDay(det, d, r.routeId, stops)) trips.push(t);
      ok++;
    } catch (e) { failed++; if (failed <= 3) log("TripShot: " + e.message); }
  });
  log(`Emory (TripShot): ${routeList.length} routes, ${stops.size} stops, ${trips.length} trips over ${dates.length} days (${ok} schedules read, ${failed} failed)`);
  if (!trips.length) throw new Error("TripShot schedules had no trips");
  return { stops, routes, services, trips, source: "tripshot" };
}

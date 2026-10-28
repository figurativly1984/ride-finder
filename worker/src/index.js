// Cloudflare Worker: passes MARTA's live data to the website in a browser-friendly form.
//   GET /rt/bus   -> live bus delays (MARTA GTFS-realtime trip updates, decoded to JSON)
//   GET /rt/rail  -> live train arrivals (MARTA rail API; key stays in the Worker as a secret)
//   GET /health   -> which feeds are reachable
const BUS_TRIP_UPDATES = "https://gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/tripupdate/tripupdates.pb";
const RAIL_API = "https://developerservices.itsmarta.com:18096/itsmarta/railrealtimearrivals/developerservices/traindata";
const CACHE_SECONDS = 20;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "GET") return json({ error: "Only GET is supported" }, 405, cors);
    try {
      if (url.pathname === "/rt/bus") return await cached(req, ctx, cors, () => busUpdates(env));
      if (url.pathname === "/rt/rail") return await cached(req, ctx, cors, () => railArrivals(env));
      if (url.pathname === "/health") return json(await health(env), 200, cors);
      return json({ ok: true, endpoints: ["/rt/bus", "/rt/rail", "/health"] }, 200, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502, cors);
    }
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` } });
}

async function cached(req, ctx, cors, make) {
  const cache = caches.default, key = new Request(new URL(req.url).origin + new URL(req.url).pathname);
  const hit = await cache.match(key);
  if (hit) { const r = new Response(hit.body, hit); Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); return r; }
  const body = await make();
  const res = json(body, 200, cors);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---------- MARTA bus: GTFS-realtime protobuf -> {generated, trips: {tripId: {d, s, q, t}}} ----------
// Trip IDs from other agencies are prefixed the same way the timetable build prefixes them.
const OTHER_FEEDS = [
  { prefix: "X:", url: "https://myxpress2.xpressga.com/gtfsrt/trips" },
  { prefix: "G:", url: "https://realtimegwinnett.availtec.com/InfoPoint/gtfs-realtime.ashx?type=tripupdate" },
  { prefix: "C:", url: "https://cobb.rideralerts.com/InfoPoint/GTFS-Realtime.ashx?Type=TripUpdate" },
];
async function busUpdates(env) {
  const now = Date.now() / 1000;
  const r = await fetch(env.BUS_TRIP_UPDATES_URL || BUS_TRIP_UPDATES, { cf: { cacheTtl: CACHE_SECONDS } });
  if (!r.ok) throw new Error("MARTA bus feed returned " + r.status);
  const out = decodeTripUpdates(new Uint8Array(await r.arrayBuffer()), now);
  out.feeds = { marta: Object.keys(out.trips).length };
  await Promise.all(OTHER_FEEDS.map(async f => {
    try {
      const res = await fetch(f.url, { cf: { cacheTtl: CACHE_SECONDS }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) { out.feeds[f.prefix] = "HTTP " + res.status; return; }
      const d = decodeTripUpdates(new Uint8Array(await res.arrayBuffer()), now);
      for (const [id, u] of Object.entries(d.trips)) out.trips[f.prefix + id] = u;
      out.feeds[f.prefix] = Object.keys(d.trips).length;
    } catch (e) { out.feeds[f.prefix] = String(e.message || e); }
  }));
  return out;
}

export function decodeTripUpdates(buf, nowSec) {
  const feed = message(buf);
  const out = { generated: null, trips: {} };
  const header = feed[1] && feed[1][0];
  if (header) { const h = message(header); if (h[3]) out.generated = Number(h[3][0]); }
  for (const entBytes of feed[2] || []) {
    const ent = message(entBytes);
    if (!ent[3]) continue;
    const tu = message(ent[3][0]);
    const td = tu[1] ? message(tu[1][0]) : {};
    const tripId = td[1] ? str(td[1][0]) : null;
    if (!tripId) continue;
    if (td[4] && Number(td[4][0]) === 3) continue; // CANCELED
    const tripDelay = tu[5] ? int32(tu[5][0]) : null;
    let pick = null;
    for (const stuBytes of tu[2] || []) {
      const stu = message(stuBytes);
      const ev = stu[2] ? message(stu[2][0]) : stu[3] ? message(stu[3][0]) : null;
      const time = ev && ev[2] ? Number(ev[2][0]) : null;
      const delay = ev && ev[1] ? int32(ev[1][0]) : null;
      const cand = { s: stu[4] ? str(stu[4][0]) : null, q: stu[1] ? Number(stu[1][0]) : null, t: time, d: delay };
      if (!pick) pick = cand;
      if (time == null || time >= nowSec - 60) { pick = cand; break; }
    }
    const u = {};
    const d = pick && pick.d != null ? pick.d : tripDelay;
    if (d != null) u.d = d;
    if (pick) { if (pick.s) u.s = pick.s; if (pick.q != null) u.q = pick.q; if (pick.t) u.t = pick.t; }
    if (Object.keys(u).length) out.trips[tripId] = u;
  }
  return out;
}

// Minimal protobuf reader: returns {fieldNumber: [values]}; varints as BigInt, length-delimited as Uint8Array.
function message(bytes) {
  const out = {}; let i = 0;
  const varint = () => { let r = 0n, s = 0n, b; do { b = bytes[i++]; r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80); return r; };
  while (i < bytes.length) {
    const key = Number(varint()), f = key >>> 3, w = key & 7;
    let v;
    if (w === 0) v = varint();
    else if (w === 1) { v = bytes.subarray(i, i + 8); i += 8; }
    else if (w === 2) { const n = Number(varint()); v = bytes.subarray(i, i + n); i += n; }
    else if (w === 5) { v = bytes.subarray(i, i + 4); i += 4; }
    else throw new Error("Unsupported protobuf wire type " + w);
    (out[f] ||= []).push(v);
  }
  return out;
}
const str = b => new TextDecoder().decode(b);
const int32 = v => Number(BigInt.asIntN(32, v));

// ---------- MARTA rail arrivals ----------
async function railArrivals(env) {
  if (!env.MARTA_API_KEY) throw new Error("MARTA_API_KEY secret is not set");
  const r = await fetch(`${env.RAIL_API_URL || RAIL_API}?apiKey=${encodeURIComponent(env.MARTA_API_KEY)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) { const t = (await r.text().catch(() => "")).replaceAll(env.MARTA_API_KEY, "***").slice(0, 300); throw new Error("MARTA rail API returned " + r.status + (t ? ": " + t : "")); }
  const raw = await r.json();
  const list = Array.isArray(raw) ? raw : (raw.RailArrivals || raw.data || raw.arrivals || Object.values(raw).find(Array.isArray) || []);
  const pick = (o, ...names) => { for (const n of names) for (const k of Object.keys(o)) if (k.toLowerCase() === n) return o[k]; return undefined; };
  const arrivals = list.map(o => {
    const ws = pick(o, "waiting_seconds", "waitingseconds");
    return {
      station: pick(o, "station", "station_name"),
      line: pick(o, "line", "line_name"),
      dir: pick(o, "direction"),
      dest: pick(o, "destination", "head_sign", "headsign"),
      waitSec: ws != null && ws !== "" ? Number(ws) : null,
      wait: pick(o, "waiting_time", "waitingtime"),
      next: pick(o, "next_arr", "next_arrival"),
      tripId: pick(o, "trip_id", "tripid") ?? null,
    };
  }).filter(a => a.station);
  return { generated: Math.floor(Date.now() / 1000), arrivals };
}

async function health(env) {
  const out = {};
  try { const b = await busUpdates(env); out.bus = { ok: true, trips: Object.keys(b.trips).length, feeds: b.feeds }; } catch (e) { out.bus = { ok: false, error: e.message }; }
  try { const r = await railArrivals(env); out.rail = { ok: true, arrivals: r.arrivals.length }; } catch (e) { out.rail = { ok: false, error: e.message }; }
  return out;
}

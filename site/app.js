import { Network, raptor, leaveBy, hav, walkMinutes } from "./router.js";

const TZ = "America/New_York";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const QUICK = [["Woodruff Library", "Woodruff Library, Emory University"], ["Emory Hospital", "Emory University Hospital, Clifton Road"], ["Clairmont Campus", "Emory Clairmont Campus, Starvine Way"], ["Decatur Square", "Decatur Square, Decatur"], ["Ponce City Market", "Ponce City Market, Atlanta"], ["ATL Airport", "Hartsfield-Jackson Atlanta International Airport"]];
const ATL_VIEWBOX = "-84.75,34.15,-83.95,33.45";

// ---------- time helpers (America/New_York) ----------
function etParts(ms) {
  const o = {};
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date(ms)).forEach(p => (o[p.type] = p.value));
  return { ymd: o.year + o.month + o.day, min: (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10), wd: o.weekday };
}
function etMidnight(ymd) {
  const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 5);
  const p = etParts(guess); return guess - p.min * 60000; // 5:00 UTC is 0:00 or 1:00 ET; subtract what ET shows
}
const fmtMs = ms => new Date(ms).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

// ---------- data ----------
const DATA = "data/";
let dataVersion = "";
const fetchJson = async f => { const r = await fetch(DATA + f + (dataVersion ? "?v=" + dataVersion : ""), { cache: f === "meta.json" ? "no-store" : "default" }); if (!r.ok) throw new Error("Timetable file missing: " + f); return r.json(); };
const agencyName = a => (meta && meta.agencies && meta.agencies[a] ? meta.agencies[a].name : a === 1 ? "Emory shuttle" : "MARTA");
let net = null, meta = null, config = {};
const ready = (async () => {
  const m = await fetchJson("meta.json"); dataVersion = m.built.replace(/\D/g, "");
  const [stops, routes, transfers, services, cfg] = await Promise.all([fetchJson("stops.json"), fetchJson("routes.json"), fetchJson("transfers.json"), fetchJson("services.json"), fetch("config.json", { cache: "no-store" }).then(r => (r.ok ? r.json() : {})).catch(() => ({}))]);
  net = new Network({ stops, routes, transfers, services }); meta = m; config = cfg || {};
  $("dataAge").textContent = "Timetable " + new Date(m.built).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const stale = (m.agencies || []).filter(a => a.staleSince).map(a => a.name + " times come from a schedule published for service through " + a.staleSince.slice(4, 6) + "/" + a.staleSince.slice(6, 8) + "/" + a.staleSince.slice(0, 4) + " and may be out of date; check the agency's site.");
  $("emorySrc").textContent = (stale.length ? stale.join(" ") + " " : "") + (m.emorySource === "tripshot" ? "Emory shuttle stops and schedules come from TripShot, the system behind Emory's live tracker, with live shuttle times when available." : "Emory shuttle times come from Emory's posted timetables (check TripShot for live positions).");
})();

// ---------- live data from the Cloudflare Worker ----------
async function fetchLive(path) {
  if (!config.rtUrl) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
  try { const r = await fetch(config.rtUrl.replace(/\/$/, "") + path, { signal: ctl.signal }); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
}
// TripShot route ids of Emory shuttles running within a couple of hours of the trip
function activeEmoryRoutes(day, t0) {
  const ids = new Set();
  for (const p of day.patterns) {
    if (p.agency !== 1) continue;
    const ext = net.routes[p.r][6]; if (!ext || ids.has(ext)) continue;
    if (p.trips.some(t => t.times[t.times.length - 1] >= t0 - 10 && t.times[0] <= t0 + 150)) ids.add(ext);
  }
  return [...ids].slice(0, 16);
}
function busDelays(rt, day) {
  const delays = new Map();
  if (!rt || !rt.trips) return delays;
  const mid = etMidnight(day.ymd);
  for (const [id, u] of Object.entries(rt.trips)) {
    const ix = day.tripIndex.get(id); if (!ix) continue;
    let d = null;
    if (typeof u.d === "number") d = u.d / 60;
    else if (u.t && u.s != null) {
      const p = day.patterns[ix[0]], trip = p.trips[ix[1]];
      const pos = p.s.findIndex(si => net.stops[si][0] === String(u.s));
      if (pos >= 0) d = (u.t * 1000 - (mid + trip.times[pos] * 60000)) / 60000;
    }
    if (d != null && Math.abs(d) < 90) delays.set(id, Math.round(d));
  }
  return delays;
}
const norm = s => String(s || "").toUpperCase().replace(/\b(STATION|STA|MARTA|CENTER|CTR)\b/g, "").replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function railLive(rail, stationName, line) {
  if (!rail || !rail.arrivals) return null;
  const st = norm(stationName), ln = String(line || "").toUpperCase();
  const hits = rail.arrivals.filter(a => { const s = norm(a.station); return s && (s.startsWith(st) || st.startsWith(s)) && (!ln || !a.line || String(a.line).toUpperCase() === ln); });
  return hits.length ? hits.sort((a, b) => (a.waitSec ?? 1e9) - (b.waitSec ?? 1e9)).slice(0, 4) : null;
}

// ---------- geocoding: Photon (place names, typo-tolerant, biased to you) + Nominatim (addresses) ----------
const ATL = { lat: 33.76, lon: -84.39 }, METRO_KM = 60;
const kmFrom = (a, b) => hav(a.lat, a.lon, b.lat, b.lon) / 1000;
async function photon(text, near) {
  const u = "https://photon.komoot.io/api/?limit=8&lang=en&bbox=-84.75,33.45,-83.95,34.15&lat=" + near.lat.toFixed(4) + "&lon=" + near.lon.toFixed(4) + "&q=" + encodeURIComponent(text);
  const r = await fetch(u); if (!r.ok) return [];
  const j = await r.json();
  return (j.features || []).map(f => {
    const p = f.properties || {}, [lon, lat] = f.geometry.coordinates;
    const street = [p.housenumber, p.street].filter(Boolean).join(" ");
    const label = [p.name, street && street !== p.name ? street : null, p.city || p.district || p.county].filter(Boolean).join(", ");
    return { lat, lon, label: label || text, house: p.housenumber || "" };
  });
}
let lastNominatim = 0;
async function nominatim(text) {
  const wait = lastNominatim + 1100 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); // their limit: 1 request per second
  lastNominatim = Date.now();
  const u = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=us&viewbox=" + ATL_VIEWBOX + "&bounded=1&q=" + encodeURIComponent(text);
  const r = await fetch(u, { headers: { "Accept-Language": "en" } }); if (!r.ok) return [];
  return (await r.json()).map(x => ({ lat: +x.lat, lon: +x.lon, label: x.display_name.split(",").slice(0, 3).join(",").trim() }));
}
// Strip things geocoders choke on: apartment/space/suite numbers, ", USA", extra spaces.
function cleanAddress(t) {
  return t.replace(/,?\s*(USA|United States)\s*$/i, "")
    .replace(/\s*(,\s*)?\b(apt|apartment|unit|ste|suite|spc|space|lot|bldg|building|rm|room|fl|floor|trlr|trailer)\b\.?\s*#?\s*[\w-]+/gi, "")
    .replace(/\s*#\s*[\w-]+/g, "")
    .replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").trim();
}
async function lookup(text, bias) {
  const isAddr = /^\d+[a-z]?\s/i.test(text), num = isAddr ? text.match(/^(\d+)/)[1] : "";
  const [a, b] = await Promise.all([photon(text, bias).catch(() => []), nominatim(text).catch(() => [])]);
  let all = (isAddr ? [...b, ...a] : [...a, ...b]).filter(m => isFinite(m.lat) && kmFrom(m, ATL) <= METRO_KM);
  if (isAddr) all.sort((x, y) => (y.house === num || /^\d/.test(y.label) && y.label.startsWith(num)) - (x.house === num || /^\d/.test(x.label) && x.label.startsWith(num)));
  const out = [];
  for (const m of all) if (!out.some(o => kmFrom(o, m) < 0.15)) out.push(m);
  return isAddr ? out : out.map((m, i) => ({ ...m, rank: i + kmFrom(m, bias) / 3 })).sort((x, y) => x.rank - y.rank);
}
// Returns matches in metro Atlanta only. Tries the full text, then simpler versions of an address.
async function geocode(text, near) {
  const bias = near && kmFrom(near, ATL) <= METRO_KM ? near : ATL;
  const clean = cleanAddress(text);
  const noZip = clean.replace(/,?\s*(GA|Georgia)?\s*\d{5}(-\d{4})?\s*$/i, "").replace(/,\s*(GA|Georgia)\s*$/i, "");
  const streetOnly = noZip.split(",")[0];
  const tries = [...new Set([text, clean, noZip, streetOnly + ", Georgia"])].filter(Boolean);
  for (const q of tries) { const r = await lookup(q, bias); if (r.length) return r.slice(0, 5); }
  // last resort: the street without the house number (approximate)
  if (/^\d+[a-z]?\s/i.test(streetOnly)) {
    const r = await lookup(streetOnly.replace(/^\d+[a-z]?\s+/i, "") + ", Georgia", bias);
    if (r.length) return r.slice(0, 5).map(m => ({ ...m, label: m.label + " (street only, exact address not found)" }));
  }
  return [];
}

function getGPS() {
  return new Promise((ok, no) => {
    if (!navigator.geolocation) return no(new Error("This browser can't share your location. Choose “An address…” instead."));
    navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lon: p.coords.longitude, label: "Your location" }), e => no(new Error(e.code === 1 ? "Location permission is off. Allow it in your browser settings, or type a starting address." : "Couldn't get your location. Try again or type an address.")), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
}

// ---------- planning ----------
function setStatus(msg, err, spin) { $("status").className = "status" + (err ? " err" : ""); $("status").innerHTML = (spin ? '<span class="spin"></span>' : "") + esc(msg); }
let busy = false, lastPick = null;

async function plan(override) {
  if (busy) return;
  const destText = $("to").value.trim();
  if (!destText && !override) return setStatus("Enter where you're going.", true);
  const departMs = $("when").value === "at" && $("at").value ? new Date($("at").value).getTime() : Date.now();
  busy = true; $("go").disabled = true; $("plansH").hidden = true; $("plans").innerHTML = "";
  if (!override) { $("resolved").hidden = true; $("resolved").innerHTML = ""; }
  try {
    setStatus("Loading timetable…", false, true); await ready;
    let O, D, dAlts = [];
    if (override && override.O) O = override.O;
    else if ($("fromMode").value === "gps") { setStatus("Getting your location…", false, true); O = await getGPS(); }
    else { const t = $("fromAddr").value.trim(); if (!t) throw new Error("Enter a starting address."); setStatus("Finding your start…", false, true); const m = await geocode(t); if (!m.length) throw new Error("Couldn't find “" + t + "” in metro Atlanta. Try a street address or a fuller name."); O = m[0]; }
    if (kmFrom(O, ATL) > METRO_KM) throw new Error("Your location is about " + Math.round(kmFrom(O, ATL) * 0.621) + " miles from Atlanta, outside the area this planner covers. Choose “An address…” under From to plan an Atlanta trip.");
    if (override && override.D) { D = override.D; dAlts = override.dAlts || []; }
    else { setStatus("Finding the destination…", false, true); const m = await geocode(destText, O); if (!m.length) throw new Error("Couldn't find “" + destText + "” in metro Atlanta. Try a street address, or add the neighborhood or city."); D = m[0]; dAlts = m.slice(1); }
    lastPick = { O, D, dAlts };
    showResolved(O, D, dAlts);

    setStatus("Planning with live MARTA data…", false, true);
    const { ymd, min: t0 } = etParts(departMs);
    const day = await net.loadDay(ymd, fetchJson);
    const [busRT, railRT, emoryRT] = await Promise.all([fetchLive("/rt/bus"), fetchLive("/rt/rail"), Math.abs(departMs - Date.now()) < 3 * 3600e3 ? fetchLive("/rt/emory?routes=" + activeEmoryRoutes(day, t0).join(",")) : null]);
    const delays = busDelays({ trips: { ...((busRT && busRT.trips) || {}), ...((emoryRT && emoryRT.trips) || {}) } }, day);
    const opts = { origin: O, dest: D, t0, delays };
    const runs = [
      ...raptor(net, day, opts).map(j => ({ ...j, tag: "any" })),
      ...raptor(net, day, { ...opts, allow: a => a !== 1 }).slice(-1).map(j => ({ ...j, tag: "marta" })),
      ...raptor(net, day, { ...opts, allow: a => a === 1 }).slice(-1).map(j => ({ ...j, tag: "emory" }))
    ];
    const walkOnly = walkMinutes(hav(O.lat, O.lon, D.lat, D.lon));
    if (walkOnly <= 45) runs.push({ legs: [{ type: "walk", mins: walkOnly, start: true, end: true }], arrive: t0 + walkOnly, depart: t0, rides: 0, tag: "walk" });
    if (!runs.length) {
      const far = (pt) => { const n = net.nearStops(pt.lat, pt.lon, 1600); return !n.length; };
      if (far(O)) throw new Error("There's no bus, train or shuttle stop within a mile of your starting point, so no transit trip is possible from there.");
      if (far(D)) throw new Error("There's no bus, train or shuttle stop within a mile of " + D.label + ", so no transit trip reaches it.");
      throw new Error("No trip found at this time. Service may have ended for the night; try a later departure time.");
    }
    render(runs, { day, delays, railRT, departMs, t0, O, D, live: !!busRT || !!railRT });
    const rec = store.get("rf.recent", []).filter(x => x !== destText); if (destText) rec.unshift(destText); store.set("rf.recent", rec.slice(0, 8)); fillRecent();
    setStatus("Updated " + fmtMs(Date.now()) + (busRT || railRT ? " with live MARTA data." : config.rtUrl ? ". Live MARTA data didn't load, so times are scheduled." : ". Times are scheduled."));
  } catch (e) {
    const m = String((e && e.message) || e);
    setStatus(/Failed to fetch|NetworkError|Load failed/i.test(m) ? "Couldn't reach the internet. Check your connection and try again." : m, true);
  } finally { busy = false; $("go").disabled = false; }
}

function showResolved(O, D, alts) {
  const el = $("resolved"); el.hidden = false;
  el.innerHTML = `<p class="note">From <b>${esc(O.label)}</b> to <b>${esc(D.label)}</b>${alts.length ? ". Not the right place?" : ""}</p>` +
    (alts.length ? `<div class="alts">${alts.map((a, i) => `<button type="button" data-i="${i}">${esc(a.label)}</button>`).join("")}</div>` : "");
  el.querySelectorAll(".alts button").forEach(b => b.addEventListener("click", () => { const a = alts[+b.dataset.i]; const rest = [lastPick.D, ...alts.filter((_, i) => i !== +b.dataset.i)]; plan({ O: lastPick.O, D: a, dAlts: rest }); }));
}

function signature(j) { return j.legs.filter(l => l.type === "ride").map(l => l.trip.id + ":" + l.from + ">" + l.to).join("|") || "walk"; }

function render(runs, ctx) {
  const { day, delays, railRT, t0 } = ctx;
  const mid = etMidnight(day.ymd), toMs = m => mid + m * 60000;
  const seen = new Map();
  for (const j of runs) { const s = signature(j); if (!seen.has(s)) seen.set(s, { ...j, tags: new Set([j.tag]) }); else seen.get(s).tags.add(j.tag); }
  let list = [...seen.values()].sort((a, b) => a.arrive - b.arrive);
  const fastest = list[0].arrive;
  list = list.filter(j => j.arrive - fastest <= 60 || j.tags.has("marta") || j.tags.has("emory")).slice(0, 5);
    $("plansH").hidden = false;
  $("plans").innerHTML = list.map((j, i) => {
    const agencies = new Set(j.legs.filter(l => l.type === "ride").map(l => l.pattern.agency));
    const names = [...agencies].sort((a, b) => (a === 1 ? -1 : b === 1 ? 1 : a - b)).map(a => (a === 1 ? "Shuttle" : agencyName(a)));
    const title = !agencies.size ? "Walk" : agencies.size === 1 && agencies.has(1) ? "Emory shuttle" : names.join(" + ");
    const kicker = i === 0 ? "Fastest" : j.tags.has("emory") && !j.tags.has("any") ? "Emory shuttles only" : j.tags.has("marta") && !j.tags.has("any") ? "Without Emory shuttles" : j.rides && j.rides < list[0].rides ? "Fewer transfers" : j.tags.has("walk") ? "Walk" : "Another option";
    const paidList = [...agencies].filter(a => a !== 1), liveUsed = j.legs.some(l => l.type === "ride" && delays.has(l.trip.id));
    const walk = j.legs.filter(l => l.type === "walk").reduce((s, l) => s + l.mins, 0);
    const lb = j.rides ? leaveBy(j, delays) : t0;
    return `<article class="plan${i === 0 ? " best" : ""}">
      <div class="plan-top"><div><div class="kicker">${kicker}</div><h3>${title}</h3></div>
      <div class="eta"><b>${Math.max(1, Math.round(j.arrive - t0))} min</b><span>arrive ${fmtMs(toMs(j.arrive))}</span></div></div>
      <div class="meta">${paidList.length ? paidList.map(a => `<span class="tag">${a === 0 ? "$2.50 MARTA fare" : esc(agencyName(a)) + " fare"}</span>`).join("") : '<span class="tag free">Free</span>'}<span class="tag">Leave by ${fmtMs(toMs(Math.max(t0, lb)))}</span>${j.rides > 1 ? `<span class="tag">${j.rides - 1} transfer${j.rides > 2 ? "s" : ""}</span>` : ""}${walk ? `<span class="tag">${walk} min walking</span>` : ""}${liveUsed ? '<span class="tag live">Live times</span>' : ""}</div>
      <ol class="legs">${j.legs.map((l, k) => legHTML(l, k, j, ctx, toMs)).join("")}<li class="end" style="--c:var(--gold)"><div class="leg-t">Arrive at ${esc(ctx.D.label)}</div><div class="leg-s mono">${fmtMs(toMs(j.arrive))}</div></li></ol>
    </article>`;
  }).join("");
}

function legHTML(l, k, j, ctx, toMs) {
  const S = net.stops;
  if (l.type === "walk") {
    if (l.mins <= 0) return "";
    const toName = l.to != null ? S[l.to][1] : l.end ? ctx.D.label : null;
    const dest = l.to != null ? S[l.to][2] + "," + S[l.to][3] : ctx.D.lat + "," + ctx.D.lon;
    const orig = l.from != null ? S[l.from][2] + "," + S[l.from][3] : (l.start ? ctx.O.lat + "," + ctx.O.lon : null);
    const link = orig ? `<div class="links"><a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&origin=${orig}&destination=${dest}&travelmode=walking">Walking map</a></div>` : "";
    return `<li class="walk"><div class="leg-t">Walk ${l.mins} min${toName ? " to " + esc(toName) : ""}</div>${k === 0 || l.from != null ? link : ""}</li>`;
  }
  const r = net.routes[l.pattern.r], agency = r[0], rail = agency !== 1 && (r[3] === 1 || r[3] === 2);
  const color = r[4] ? "#" + r[4] : agency === 1 ? "var(--emory)" : rail ? "var(--rail)" : "var(--marta)";
  const text = r[5] ? "#" + r[5] : "var(--chip-ink)";
  const d = ctx.delays.get(l.trip.id) || 0;
  const dep = l.trip.times[l.fromPos] + d, arr = l.trip.times[l.toPos] + d;
  const name = agency === 1 ? r[2] : (agency === 0 ? "" : agencyName(agency) + " ") + (r[2] || (rail ? "MARTA rail" : agency === 0 ? "MARTA bus" : "bus"));
  const head = l.pattern.h ? " toward " + esc(l.pattern.h) : "";
  let live = "";
  const hw = /^E:h-(\d+)-(\d+)-/.exec(l.trip.id);
  if (hw) live = `<div class="leg-live" style="color:var(--muted)">Runs every ${hw[1] === hw[2] ? hw[1] : hw[1] + "–" + hw[2]} min, so times are estimates. Check TripShot for the next bus.</div>`;
  if (ctx.delays.has(l.trip.id)) live = `<div class="leg-live">Live: ${d === 0 ? "on time" : d > 0 ? d + " min late" : -d + " min early"}</div>`;
  if (rail) { const hits = railLive(ctx.railRT, S[l.from][1], r[1]); if (hits) live = `<div class="leg-live">Live at ${esc(S[l.from][1])}: ${hits.map(h => esc(h.dest ? h.dest.replace(/ STATION$/i, "") : "train") + " " + (h.waitSec != null ? (h.waitSec < 60 ? "arriving" : Math.round(h.waitSec / 60) + " min") : esc(h.wait || ""))).join(" · ")}</div>`; }
  const ag = meta.agencies && meta.agencies[agency];
  if (ag && ag.staleSince && !live) live = `<div class="leg-live" style="color:var(--gold)">Schedule may be outdated. Confirm on ${esc(ag.name)}'s site.</div>`;
  const links = agency === 1 ? `<div class="links"><a class="btn small" target="_blank" rel="noopener" href="https://emory.tripshot.com/">Track on TripShot</a></div>` : "";
  const stopsN = l.toPos - l.fromPos;
  return `<li style="--c:${color}"><div class="leg-t"><span class="chip" style="--c:${color};color:${text}">${esc(r[1])}</span>${name && name !== r[1] ? esc(name) : agency === 1 ? "Emory shuttle" : ""}${head}</div>
    <div class="leg-s">Board at ${esc(S[l.from][1])} · <span class="mono">${fmtMs(toMs(dep))}</span>${ctx.delays.has(l.trip.id) ? " · live" : hw ? " · about" : agency === 1 ? " · scheduled" : ""}</div>
    <div class="leg-s">Get off at ${esc(S[l.to][1])} · <span class="mono">${fmtMs(toMs(arr))}</span> · ${stopsN} stop${stopsN === 1 ? "" : "s"}</div>${live}${links}</li>`;
}

// ---------- UI wiring ----------
function fillRecent() { $("recent").innerHTML = store.get("rf.recent", []).map(x => `<option value="${esc(x)}"></option>`).join(""); }
$("quick").innerHTML = QUICK.map(([n, q]) => `<button type="button" data-q="${esc(q)}">${esc(n)}</button>`).join("");
$("quick").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; $("to").value = b.dataset.q; plan(); });
$("fromMode").addEventListener("change", () => { $("fromAddr").hidden = $("fromMode").value !== "addr"; store.set("rf.fromMode", $("fromMode").value); });
$("when").addEventListener("change", () => { $("atWrap").hidden = $("when").value !== "at"; if (!$("at").value) { const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); $("at").value = d.toISOString().slice(0, 16); } });
$("f").addEventListener("submit", e => { e.preventDefault(); plan(); });
$("fromMode").value = store.get("rf.fromMode", "gps"); $("fromAddr").hidden = $("fromMode").value !== "addr";
fillRecent();
const tick = () => { const p = etParts(Date.now()); $("clock").textContent = "Atlanta · " + p.wd + " " + fmtMs(Date.now()); };
tick(); setInterval(tick, 30000);
ready.catch(e => setStatus("Couldn't load the timetable: " + e.message, true));

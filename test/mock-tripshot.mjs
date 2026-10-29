// Runs the full build with TripShot responses served from saved files (see tools/probe.sh).
// Usage: node test/mock-tripshot.mjs <probe-dir> <out-dir> <fixture.zip>
import { readFileSync, existsSync } from "node:fs";
const [dir, out, marta] = process.argv.slice(2);
const ids = Object.fromEntries(readFileSync(dir + "/tripshot-route-ids.txt", "utf8").trim().split("\n").map(l => l.split(" ")));
const routeList = readFileSync(dir + "/" + (await import("node:fs")).readdirSync(dir).find(f => f.startsWith("tripshot-routes-")), "utf8");
globalThis.fetch = async url => {
  const u = new URL(url);
  let body = null;
  if (/\/v1\/p\/shared\/route$/.test(u.pathname)) body = routeList;
  const m = u.pathname.match(/\/v3\/p\/shared\/route\/([^/]+)$/);
  if (m) {
    const d = new Date(u.searchParams.get("day") + "T12:00:00Z").getUTCDay();
    const f = `${dir}/ts-sched-${ids[m[1]]}-${d === 6 || d === 0 ? "saturday" : "weekday"}.json`;
    if (existsSync(f)) {
      // the saved file is for one specific date; relabel its trips to the requested day
      const j = JSON.parse(readFileSync(f, "utf8")); const det = j.InternalRouteDetails; const [y, mo, da] = u.searchParams.get("day").split("-").map(Number);
      const days = new Set(); for (const tt of det.exactTimetables || []) for (const t of tt.trips || []) days.add(JSON.stringify(t.day));
      for (const it of det.inexactTimetables || []) for (const iv of it.timeIntervals || []) days.add(JSON.stringify(iv.day));
      const last = [...days].sort().pop();
      const fix = o => { if (o && JSON.stringify(o.day) === last) o.day = { year: y, month: mo, day: da }; else if (o) o.day = { year: 1999, month: 1, day: 1 }; };
      for (const tt of det.exactTimetables || []) (tt.trips || []).forEach(fix);
      for (const it of det.inexactTimetables || []) (it.timeIntervals || []).forEach(fix);
      body = JSON.stringify(j);
    }
  }
  return body ? { ok: true, status: 200, json: async () => JSON.parse(body) } : { ok: false, status: 404, json: async () => ({}) };
};
process.argv = [process.argv[0], "build.mjs", "--marta", marta, "--extra", "none", "--out", out];
await import("../build/build.mjs");

// Creates a small fake MARTA GTFS zip for local testing (not real MARTA data).
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const dir = process.argv[2] || "/tmp/fixture";
mkdirSync(dir, { recursive: true });
const stops = [
  ["MID", "MIDTOWN STATION", 33.7807, -84.3863], ["NAVE", "NORTH AVE STATION", 33.7717, -84.3871], ["CIVS", "CIVIC CENTER STATION", 33.7666, -84.3871],
  ["FIVE", "FIVE POINTS STATION", 33.7539, -84.3916], ["LIND", "LINDBERGH CENTER STATION", 33.8231, -84.3693], ["DECS", "DECATUR STATION", 33.7747, -84.2953],
  ["B_VIL", "N DECATUR RD @ OXFORD RD", 33.7882, -84.3252], ["B_CLIF", "CLIFTON RD @ HAYGOOD", 33.7911, -84.3221], ["B_EUH", "CLIFTON RD @ EUH", 33.7928, -84.3206],
  ["B_CDC", "CLIFTON RD @ CDC", 33.8003, -84.3249], ["B_PCM", "PONCE DE LEON AVE @ PONCE CITY MKT", 33.7728, -84.3657], ["B_VH", "N HIGHLAND AVE @ VIRGINIA AVE", 33.7809, -84.3530]
];
const routes = [["R11", "11", "Defoor Ave / Virginia Highland", 3, "D4561A"], ["R15", "15", "Clifton Rd / Candler Rd", 3, "D4561A"], ["RED", "RED", "Red Line", 1, "CE242B"], ["BLUE", "BLUE", "Blue Line", 1, "0072CE"]];
const pats = {
  R11: [["MID", 0], ["B_VH", 9], ["B_VIL", 20], ["B_CLIF", 23], ["B_EUH", 25], ["B_CDC", 29]],
  R15: [["LIND", 0], ["B_CDC", 13], ["B_EUH", 17], ["B_CLIF", 19], ["DECS", 35]],
  RED: [["LIND", 0], ["MID", 6], ["NAVE", 8], ["CIVS", 10], ["FIVE", 13]],
  BLUE: [["FIVE", 0], ["DECS", 13]]
};
const hw = { R11: 20, R15: 20, RED: 10, BLUE: 10 };
const csv = rows => rows.map(r => r.join(",")).join("\n") + "\n";
let trips = [["route_id", "service_id", "trip_id", "trip_headsign"]], st = [["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"]];
const hhmm = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0") + ":00";
for (const [rid, p] of Object.entries(pats)) for (const dir of [1, -1]) {
  const seq = dir === 1 ? p : p.slice().reverse().map(([s, t]) => [s, p[p.length - 1][1] - t]);
  for (let t0 = 300; t0 <= 1430; t0 += hw[rid]) { const id = `${rid}_${dir}_${t0}`; trips.push([rid, "WK", id, seq[seq.length - 1][0]]); seq.forEach(([s, t], i) => st.push([id, hhmm(t0 + t), hhmm(t0 + t), s, i + 1])); }
}
writeFileSync(join(dir, "stops.txt"), csv([["stop_id", "stop_name", "stop_lat", "stop_lon"], ...stops]));
writeFileSync(join(dir, "routes.txt"), csv([["route_id", "route_short_name", "route_long_name", "route_type", "route_color"], ...routes]));
writeFileSync(join(dir, "calendar.txt"), csv([["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"], ["WK", 1, 1, 1, 1, 1, 1, 1, "20260101", "20271231"]]));
writeFileSync(join(dir, "trips.txt"), csv(trips));
writeFileSync(join(dir, "stop_times.txt"), csv(st));
execFileSync("zip", ["-q", "-j", join(dir, "fixture.zip"), ...["stops", "routes", "calendar", "trips", "stop_times"].map(f => join(dir, f + ".txt"))]);
console.log(join(dir, "fixture.zip"));

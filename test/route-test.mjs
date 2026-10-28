import { Network, raptor } from "../site/router.js";
import { readFileSync } from "node:fs";
const dir = process.argv[2] || "/tmp/rf-data";
const J = f => JSON.parse(readFileSync(dir + "/" + f, "utf8"));
const net = new Network({ stops: J("stops.json"), routes: J("routes.json"), transfers: J("transfers.json"), services: J("services.json") });
const day = await net.loadDay(process.argv[3] || "20261028", async f => J(f));
const fmt = m => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, "0")}`;
const show = (label, o, d, t0, allow) => {
  const js = raptor(net, day, { origin: o, dest: d, t0, allow });
  console.log(`\n== ${label} @ ${fmt(t0)}: ${js.length} journeys`);
  for (const j of js) console.log(`  arrive ${fmt(j.arrive)} (${j.arrive - t0} min, ${j.rides} rides): ` + j.legs.map(l => l.type === "walk" ? `walk ${l.mins}` : `${net.routes[l.pattern.r][1]} ${net.stops[l.from][1]}@${fmt(l.trip.times[l.fromPos])} -> ${net.stops[l.to][1]}@${fmt(l.trip.times[l.toPos])}`).join(" | "));
};
const STAR = { lat: 33.7988, lon: -84.3122 }, PCM = { lat: 33.7726, lon: -84.3655 }, LIB = { lat: 33.7906, lon: -84.3245 }, AIR = { lat: 33.7539, lon: -84.3916 }, DEC = { lat: 33.7745, lon: -84.2960 };
show("Clairmont -> Ponce City Mkt", STAR, PCM, 15 * 60 + 20);
show("Clairmont -> Ponce (MARTA only)", STAR, PCM, 15 * 60 + 20, a => a === 0);
show("Library -> Five Points", LIB, AIR, 8 * 60);
show("Clairmont -> Decatur", STAR, DEC, 15 * 60 + 20);
show("Five Points -> Clairmont, late", AIR, STAR, 22 * 60);

# Emory Ride Finder

Finds the fastest way from where you are to any address in metro Atlanta, using **Emory shuttles, MARTA buses and MARTA trains together**. Every combination is considered, because the site plans over one combined timetable.

Live site: https://figurativly1984.github.io/ride-finder/

## How it works

| Piece | What it does | Where |
|---|---|---|
| Timetable build | Every morning, downloads MARTA's official schedule (GTFS) and Emory's shuttle schedule, and turns them into small files the site can search. | `build/build.mjs`, `.github/workflows/deploy-site.yml` |
| Trip planner | Runs in your browser. Searches all buses, trains and shuttles together (RAPTOR algorithm) and shows the fastest trip plus options with fewer transfers, MARTA only, and Emory only. | `site/router.js`, `site/app.js` |
| Live data | A Cloudflare Worker fetches MARTA's live bus delays and train arrivals, and keeps the MARTA key private. | `worker/`, `.github/workflows/deploy-worker.yml` |
| Address search | OpenStreetMap's Nominatim service, one lookup per search. | `site/app.js` |

Emory shuttle times come from Emory's own GTFS feed when Passio publishes one; otherwise from Emory's posted timetables in `build/emory-shuttles.json`. Emory's live shuttle positions aren't open to other sites, so the site links to TripShot for those.

## One-time setup

1. **Turn on GitHub Pages:** repository **Settings → Pages → Source: GitHub Actions**.
2. **Add two secrets:** **Settings → Secrets and variables → Actions → New repository secret**
   - `CLOUDFLARE_API_TOKEN`: Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template.
   - `MARTA_API_KEY`: from https://itsmarta.com/developer-reg-rtt.aspx (live train arrivals; bus delays work without it).
3. **Make sure you have a workers.dev subdomain:** Cloudflare dashboard → Workers & Pages. If it asks you to choose a subdomain, pick one.
4. **Run the workflows:** **Actions → Deploy live-data Worker → Run workflow**. It deploys the Worker, saves its address in `site/config.json`, and republishes the site.

After that, everything updates on its own: the timetable rebuilds every morning, and the Worker redeploys whenever `worker/` changes.

## Updating Emory shuttle schedules

Edit `build/emory-shuttles.json` (stops, routes, first/last trip, headway or exact start times) and push. The site rebuilds automatically.

## Testing locally

```sh
node test/make-fixture.mjs /tmp/fixture            # small fake MARTA feed
node build/build.mjs --marta /tmp/fixture/fixture.zip --emory none --out site/data
node test/route-test.mjs site/data 20261029         # prints sample trips
python3 -m http.server -d site 8000                 # open http://localhost:8000
```

## Notes

An independent project, not affiliated with MARTA or Emory University. Uses MARTA's public data feeds; MARTA's name and logos are its trademarks. Address search © OpenStreetMap contributors.

#!/usr/bin/env bash
# Fetches the public shuttle data that Emory's tracking apps (Passio GO, TripShot) and
# Emory's route pages publish, so the timetable build can use real stops and times.
# Output goes to probe/ for inspection.
set -u
mkdir -p probe && cd probe
UA="ride-finder-probe (github.com/figurativly1984/ride-finder)"
get() { local out="$1"; shift; curl -sS -L -m 30 -A "$UA" -o "$out" -w "%{http_code} %{size_download} $out %{url_effective}\n" "$@" >> index.txt 2>>errors.txt || echo "FAIL $out" >> index.txt; }

# Passio GO (Emory's real-time tracker)
get passio-systems.json "https://passiogo.com/mapGetData.php?getSystems=2&sortMode=1&credentials=1"
python3 - > emory-systems.txt <<'PY'
import json
try:
    d = json.load(open("passio-systems.json"))
    for s in d.get("all") or d.get("systems") or []:
        if "emory" in json.dumps(s).lower():
            print(s.get("id"), s.get("username") or "-")
except Exception as e:
    print("ERR", e)
PY
echo "emory systems: $(tr '\n' ' ' < emory-systems.txt)" >> index.txt
while read -r ID USERNAME; do
  case "$ID" in ""|ERR) continue;; esac
  get "passio-$ID-routes.json" -X POST "https://passiogo.com/mapGetData.php?getRoutes=1" --data-urlencode "json={\"systemSelected0\":\"$ID\",\"amount\":1}"
  get "passio-$ID-stops.json"  -X POST "https://passiogo.com/mapGetData.php?getStops=2"  --data-urlencode "json={\"s0\":\"$ID\",\"sA\":1}"
  get "passio-$ID-buses.json"  -X POST "https://passiogo.com/mapGetData.php?getBuses=2"  --data-urlencode "json={\"s0\":\"$ID\",\"sA\":1}"
  for U in "$USERNAME" emory; do
    [ "$U" = "-" ] && continue
    get "passio3-$U-gtfs.zip"         "https://passio3.com/$U/passioTransit/gtfs/google_transit.zip"
    get "passio3-$U-tripupdates.pb"   "https://passio3.com/$U/passioTransit/gtfs/realtime/tripUpdates"
    get "passio3-$U-vehicles.pb"      "https://passio3.com/$U/passioTransit/gtfs/realtime/vehiclePositions"
  done
done < emory-systems.txt

# TripShot (Emory's other tracker) - page and its script bundles, to find its data endpoints
get tripshot.html "https://emory.tripshot.com/"
grep -oE '(src|href)="[^"]+\.js[^"]*"' tripshot.html | sed -E 's/^(src|href)="//; s/"$//' | head -5 > tripshot-js.txt
n=0; while read -r js; do
  n=$((n+1)); case "$js" in http*) u="$js";; /*) u="https://emory.tripshot.com$js";; *) u="https://emory.tripshot.com/$js";; esac
  get "tripshot-bundle-$n.js" "$u"
done < tripshot-js.txt
grep -ohE '/v[0-9]/p/[A-Za-z0-9_/.{}-]+' tripshot-bundle-*.js 2>/dev/null | sort -u | head -200 > tripshot-api-paths.txt

# TripShot: resolve scripts against the page's final address
TS_BASE=$(grep " tripshot.html " index.txt | awk '{print $4}' | sed -E 's#[^/]*$##')
echo "tripshot base: $TS_BASE" >> index.txt
n=0; while read -r js; do
  n=$((n+1)); case "$js" in http*) u="$js";; /*) u="https://emory.tripshot.com$js";; *) u="$TS_BASE$js";; esac
  get "tripshot-b-$n.js" "$u"
done < tripshot-js.txt
# GWT loads a second, hashed bundle named inside tms.nocache.js
for h in $(grep -ohE "[0-9A-F]{32}" tripshot-b-*.js 2>/dev/null | sort -u | head -3); do get "tripshot-perm-$h.js" "${TS_BASE}tms/$h.cache.js"; get "tripshot-perm2-$h.js" "${TS_BASE}$h.cache.js"; done
grep -ohE '"/?(v[0-9]+|api)/[A-Za-z0-9_/.{}-]+' tripshot-b-*.js tripshot-perm*.js 2>/dev/null | sort -u | head -300 > tripshot-api-paths.txt

# Emory route pages (posted timetables and stop lists)
get emory-shuttles.html "https://transportation.emory.edu/shuttles"
{ grep -oE 'href="(https://transportation\.emory\.edu)?/shuttles/[a-z0-9-]+' emory-shuttles.html | sed -E 's#.*/shuttles/##'; printf '%s\n' a c d e m loop cctma edh euhm grady toco-hill bx dx; } | sort -u > slugs.txt
while read -r s; do get "emory-route-$s.html" "https://transportation.emory.edu/shuttles/$s"; done < slugs.txt
for js in $(grep -ohE '(https:)?//transportation\.emory\.edu/js/[^"]+' emory-route-c.html | sort -u); do get "emory-site-$(basename "${js%%\?*}")" "https:${js#https:}"; done
grep -ohE "[\"'][^\"' ]*(ajax|api|stops|timeframe|schedule|route)[^\"' ]*[\"']" emory-site-*.js 2>/dev/null | sort -u | head -200 > emory-js-endpoints.txt
ls -la > listing.txt

# ---- Emory site's own schedule service (what its route pages call) ----
WD=$(python3 -c "import datetime as d;t=d.date.today()+d.timedelta(1)
while t.weekday()>4: t+=d.timedelta(1)
print(t.strftime('%m-%d-%Y'))")
SAT=$(python3 -c "import datetime as d;t=d.date.today()+d.timedelta(1)
while t.weekday()!=5: t+=d.timedelta(1)
print(t.strftime('%m-%d-%Y'))")
get emory-ajax-getroutes.json -X POST "https://transportation.emory.edu/ajax/ajax.php" --data "action=getroutes"
for f in emory-route-*.html; do
  sid=$(grep -oE 'data-route-id="[^"]+"' "$f" | head -1 | sed -E 's/.*="//; s/"$//'); [ -z "$sid" ] && continue
  slug=${f#emory-route-}; slug=${slug%.html}
  get "emory-ajax-details-$slug-weekday.json" -X POST "https://transportation.emory.edu/ajax/ajax.php" --data "action=getroutedetails&filters%5Bsid%5D=$sid&filters%5Bdate%5D=$WD"
  get "emory-ajax-details-$slug-saturday.json" -X POST "https://transportation.emory.edu/ajax/ajax.php" --data "action=getroutedetails&filters%5Bsid%5D=$sid&filters%5Bdate%5D=$SAT"
done

# ---- TripShot public data ----
TS=https://emory.tripshot.com/v1
get tripshot-region.json "$TS/region"
get tripshot-livestatus.json "$TS/p/liveStatus"
DAY=$(date +%F)
for R in $(grep -ohE '"(regionId|id)"\s*:\s*"[^"]+"' tripshot-region.json tripshot-livestatus.json 2>/dev/null | sed -E 's/.*:\s*"//; s/"$//' | sort -u | head -5); do
  get "tripshot-live-$R.json" "$TS/p/liveStatus?regionId=$R"
  get "tripshot-routes-$R.json" "$TS/p/shared/route?includePreviousDayRidesSpanningMidnight=true&startDay=$DAY&endDay=$DAY&regionId=$R"
done
ls -la > listing.txt

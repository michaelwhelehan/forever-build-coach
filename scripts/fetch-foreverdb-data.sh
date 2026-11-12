#!/usr/bin/env bash
# Downloads the ForeverDB.net addon data files Forever Route is built from into a folder (default: .foreverdb-data).
# ForeverDB publishes them for addons (robots.txt points at the manifest); they're GPL-3.0 with a credit term.
set -euo pipefail
out="${1:-.foreverdb-data}"
mkdir -p "$out"
ua="forever-route-builder (+https://github.com/michaelwhelehan/forever-build-coach)"
curl -fsS -A "$ua" https://foreverdb.net/downloads/addon-manifest.json -o "$out/manifest.json"
for name in QuestClassic QuestForever QuestXP Zones RouteMaps; do
  url=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print([f['url'] for f in m['data']['files'] if f['path']=='Data/'+sys.argv[2]+'.lua'][0])" "$out/manifest.json" "$name")
  curl -fsS -A "$ua" "https://foreverdb.net/$url" -o "$out/$name.lua"
  echo "$name.lua $(wc -c < "$out/$name.lua") bytes"
done
python3 -c "import json,sys; print('ForeverDB data version', json.load(open(sys.argv[1]))['data']['version'])" "$out/manifest.json"

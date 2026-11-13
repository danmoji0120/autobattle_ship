#!/bin/bash
# Faction economy v2 verification batch (§9). Runs in parallel (4 jobs); results → docs/econ-results/faction/runs
#   bash scripts/faction/batch.sh [jobs.txt]
cd "$(dirname "$0")/../.."
D=docs/econ-results/faction/runs; mkdir -p $D
jobs=${1:-}
if [ -z "$jobs" ]; then jobs=$(mktemp); cat > $jobs <<'J'
F peace 72 5
F war 72 5
F war 72 6
F war 24 6
F war 24 7
F war 24 8
F ironwar 8 5
F cut 8 5
F recover 8 5
F save 12 5
F war 24 5 chain
C mine,refine,inter,parts L p10fe 24 5 1
C mine,refine,inter,parts L p10 24 5 1
C mine,refine,inter,parts base p10fe 24 5 1
C refine L p10fe 12 5 3
C parts L p10fe 12 5 3
C inter L p10fe 12 5 2
C inter L p10fe 12 5 4
C inter L p10fe 12 5 8
C parts L p10fe 24 6 1
C mine L p10fe 12 5 1
C refine L p10fe 12 5 1
C inter L p10fe 12 5 1
C parts L p10fe 12 5 1
C equip L p10fe 12 5 1
C vertical L p10fe 12 5 1
C mine base p10fe 12 5 1
C refine base p10fe 12 5 1
C inter base p10fe 12 5 1
C parts base p10fe 12 5 1
C equip base p10fe 12 5 1
C vertical base p10fe 12 5 1
C mine L p10 12 5 1
C parts L p10 12 5 1
C equip L p10 12 5 1
C equip base p10 12 5 1
J
fi
run() {
  set -- $1
  if [ "$1" = F ]; then n="fe.$2.$3h.s$4${5:+.$5}"; npx vite-node scripts/faction/scenarios.ts -- $2 $3 $4 $D/$n.json $5 > $D/$n.log 2>&1
  else n="co.${2//,/+}.$3.$4.$5h.s$6.x$7"; npx vite-node scripts/econ/companies.ts -- $2 $3 $4 $5 $6 $D/$n.json $7 > $D/$n.log 2>&1; fi
  echo "done $n $?"
}
export -f run; export D
grep -v '^\s*$' $jobs | xargs -P 4 -I{} bash -c 'run "{}"'

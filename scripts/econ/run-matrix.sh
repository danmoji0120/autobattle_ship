#!/usr/bin/env bash
# Runs specs × proposals × origins in parallel (4 at a time) and writes one JSON per run.
#   scripts/econ/run-matrix.sh <outdir> <hours> <seed> "<specs>" "<proposals>" "<origins>"
set -u
out=$1; hours=$2; seed=$3; specs=$4; props=$5; origins=$6
mkdir -p "$out"
jobs=()
for o in $origins; do for p in $props; do for s in $specs; do
  f="$out/$s.$p.$o.json"; [ -s "$f" ] && continue
  jobs+=("$s $p $o")
done; done; done
printf '%s\n' "${jobs[@]}" | xargs -P 4 -I{} bash -c 'set -- {}; npx vite-node scripts/econ/companies.ts -- $1 $2 $3 '"$hours $seed"' '"$out"'/$1.$2.$3.json > '"$out"'/$1.$2.$3.log 2>&1 || echo "FAIL $1 $2 $3"'
echo done

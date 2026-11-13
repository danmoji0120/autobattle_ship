#!/usr/bin/env bash
# Runs a list of company simulations in parallel and writes one JSON (+log) per run.
#   scripts/econ/run-list.sh <outdir> <parallel> < lines of "spec proposal origin hours seed [copies]"
# copies > 1 = competition run (that many identical companies on the same markets), file suffix .x<copies>
set -u
out=$1; par=$2; mkdir -p "$out"
grep -v '^\s*$' | while read -r s p o h seed c; do c=${c:-1}; x=""; [ "$c" -gt 1 ] && x=".x$c"; f="$out/$s.$p.$o.${h}h.s$seed$x.json"; [ -s "$f" ] || echo "$s $p $o $h $seed $c"; done \
 | xargs -P "$par" -L 1 bash -c 'x=""; [ "$5" -gt 1 ] && x=".x$5"; f='"$out"'/$0.$1.$2.${3}h.s$4$x; npx vite-node scripts/econ/companies.ts -- $0 $1 $2 $3 $4 $f.json $5 > $f.log 2>&1 || echo "FAIL $0 $1 $2 $3 $4 $5"'
echo done

#!/bin/bash
# P13.2.1 §4 economics grid (+ §6 sinking-path runs): 8 game hours each, seed 13210, 3 runs at a time
cd "$(dirname "$0")/../.."
run() { env $(echo $1 | tr , " ") npx vite-node scripts/piracy/p1321-econ.ts 8 13210 > "artifacts/p1321/econ-$2.log" 2>&1; echo "done $2"; }
export -f run
cat <<'L' | xargs -P 3 -L 1 bash -c 'run "$0" "$1"'
CARGO=A,RAID=p132,ESCORT=none A-p132-none
CARGO=B,RAID=p132,ESCORT=none B-p132-none
CARGO=C,RAID=p132,ESCORT=none C-p132-none
CARGO=D,RAID=p132,ESCORT=none D-p132-none
CARGO=C,RAID=p132,ESCORT=none,HOLD=1 C-p132-none-hold
CARGO=C,RAID=small,ESCORT=none C-small-none
CARGO=C,RAID=medium,ESCORT=none C-medium-none
CARGO=C,RAID=split,ESCORT=none C-split-none
CARGO=C,RAID=p132,ESCORT=light C-p132-light
CARGO=C,RAID=p132,ESCORT=medium C-p132-medium
CARGO=C,RAID=p132,ESCORT=strong C-p132-strong
CARGO=C,RAID=medium,ESCORT=medium C-medium-medium
CARGO=C,RAID=p132,ESCORT=strong,POLICY=force C-p132-strong-force
CARGO=A,RAID=medium,ESCORT=none A-medium-none
CARGO=C,RAID=p132,ESCORT=medium,POLICY=force C-p132-medium-force
CARGO=C,RAID=p132,ESCORT=medium,POLICY=force,VPOL=protect C-p132-medium-force-vprotect
L

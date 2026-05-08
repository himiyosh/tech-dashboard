#!/bin/bash
cd /Users/himiyosh/GH_himiyosh/tech-dashboard
set -a
source .env.local
set +a
export SUMMARIZE_MAX_NEW=1000
exec npx tsx scripts/resummarize.mjs

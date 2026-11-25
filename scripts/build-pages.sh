#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist
cp -R public/. dist/
cp supabase/schema.sql dist/schema.sql
touch dist/.nojekyll

#!/usr/bin/env bash
# Vercel build step. Substitutes STUDIO_URL and STUDIO_SECRET env vars into
# the index.html meta-tag placeholders. Warns (doesn't fail) if either env
# var is missing — the page falls back to localhost in that case.
set -e

if [ -n "$STUDIO_URL" ]; then
  sed -i 's|{{STUDIO_URL}}|'"$STUDIO_URL"'|g' index.html
else
  echo "⚠️  STUDIO_URL env var not set; frontend will use ws://localhost:3002"
fi

if [ -n "$STUDIO_SECRET" ]; then
  sed -i 's|{{STUDIO_SECRET}}|'"$STUDIO_SECRET"'|g' index.html
else
  echo "⚠️  STUDIO_SECRET env var not set; frontend connects without a token"
fi

#!/usr/bin/env bash
# Upload public/zk to S3 so the ZK artifacts stop shipping in the Amplify build output.
#
#   ./scripts/upload-zk-artifacts.sh <bucket> [region]
#
# Amplify caps an SSR app's BUILD OUTPUT at 220 MiB and public/ is copied into that
# output, so ~2.8 GB of proving keys cannot ship with the app (see amplify.yml). They
# are served from a CDN instead, and NEXT_PUBLIC_ZK_BASE_URL tells the app where.
#
# The one thing that must be right: the bucket root holds the CONTENTS of public/zk —
# withdraw1/, ceremony/, CEREMONY.json — NOT a nested zk/ folder. zkUrl() REPLACES the
# /zk prefix rather than appending it, so a nested folder yields <cdn>/zk/zk/withdraw1/…
# and every proof 404s. The trailing slash on the source path below is what enforces
# that, and the verification at the end fails loudly if it went wrong anyway.
set -euo pipefail

BUCKET="${1:?usage: $0 <bucket> [region]}"
REGION="${2:-us-east-1}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/public/zk"

[ -d "$SRC" ] || { echo "no such directory: $SRC" >&2; exit 1; }
command -v aws >/dev/null || { echo "aws CLI not installed — see the notes below" >&2; exit 1; }

echo "source : $SRC  ($(du -sh "$SRC" | cut -f1), $(find "$SRC" -type f | wc -l | tr -d ' ') files)"
echo "target : s3://$BUCKET/  (region $REGION)"
echo

# Create only if absent — re-running must not fail on an existing bucket.
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "creating bucket…"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION"
  fi
fi

# The bucket stays PRIVATE. CloudFront reaches it with an Origin Access Control, so
# Block Public Access can remain on — these files are public in content, but making the
# bucket itself public is an unnecessary way to be wrong.
#
# Immutable caching is safe and important: a zkey never changes in place. A new ceremony
# publishes new paths, so nothing here is ever invalidated.
CACHE="public, max-age=31536000, immutable"

echo "uploading (2.8 GB — this takes a while)…"
aws s3 sync "$SRC/" "s3://$BUCKET/" --cache-control "$CACHE" --only-show-errors

# sync guesses Content-Type from the extension and has no idea what .zkey is. Fix the
# two that matter in one metadata-only rewrite (no re-upload of the bytes).
echo "setting content types…"
aws s3 cp "s3://$BUCKET/" "s3://$BUCKET/" --recursive --exclude "*" --include "*.wasm" \
  --content-type "application/wasm" --cache-control "$CACHE" \
  --metadata-directive REPLACE --only-show-errors
aws s3 cp "s3://$BUCKET/" "s3://$BUCKET/" --recursive --exclude "*" --include "*.zkey" \
  --content-type "application/octet-stream" --cache-control "$CACHE" \
  --metadata-directive REPLACE --only-show-errors

# --- verify the layout, because getting it wrong is silent until a proof fails --------
echo
fail=0
for key in withdraw1/zkey_final.zkey ceremony/withdraw1/zkey_final.zkey CEREMONY.json \
           withdraw6/zkey_final.zkey merge2/zkey_final.zkey; do
  if aws s3api head-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1; then
    echo "  ok      $key"
  else
    echo "  MISSING $key"; fail=1
  fi
done
if aws s3api head-object --bucket "$BUCKET" --key "zk/withdraw1/zkey_final.zkey" >/dev/null 2>&1; then
  echo "  ERROR: found zk/withdraw1/… — the folder was nested. The bucket root must hold"
  echo "         the CONTENTS of public/zk. Re-run with a trailing slash on the source."
  fail=1
fi
[ "$fail" -eq 0 ] || { echo; echo "layout is wrong — do NOT set NEXT_PUBLIC_ZK_BASE_URL yet"; exit 1; }

echo
aws s3 ls "s3://$BUCKET/" --recursive --summarize | tail -3
echo
echo "Uploaded. Next: put CloudFront in front of this bucket (OAC), allow CORS from your"
echo "site origin, confirm https://<cdn>/withdraw1/zkey_final.zkey returns 200, and only"
echo "then set NEXT_PUBLIC_ZK_BASE_URL=https://<cdn> in Amplify and redeploy."

#!/usr/bin/env bash
# Prepare the production deploy folder from the build artifact, for the one credential job. Runs no code from the
# artifact: it is unpacked as data; the released wrangler.toml is only checked (check-production-config.py), not rewritten.
#   prepare-production.sh TRUSTED_DIR ARCHIVE EXPECTED_ARCHIVE_SHA256 EXPECTED_COMMIT_SHA DEST
# Result: DEST/{bundle/,.atlas-dist/,migrations/,wrangler.toml,meta/}
set -euo pipefail
trusted=$1 archive=$2 want_hash=$3 want_sha=$4 dest=$5
tools="$trusted/.github/deploy-tools"
[[ "$want_hash" =~ ^[0-9a-f]{64}$ && "$want_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::malformed job output"; exit 1; }
got=$(sha256sum "$archive" | cut -d' ' -f1)
[ "$got" = "$want_hash" ] || { echo "::error::artifact hash differs from the one the build job reported"; exit 1; }
python3 "$tools/safe-extract.py" "$archive" "$dest/x"
[ "$(tr -d '\n' < "$dest/x/meta/sha.txt")" = "$want_sha" ] || { echo "::error::artifact is for another commit"; exit 1; }
mv "$dest/x/assets" "$dest/.atlas-dist"
mv "$dest/x/bundle" "$dest/bundle"
mv "$dest/x/migrations" "$dest/migrations"
mv "$dest/x/meta" "$dest/meta"
rmdir "$dest/x"
python3 "$tools/check-production-config.py" "$dest/meta/ref-config.toml"
cp "$dest/meta/ref-config.toml" "$dest/wrangler.toml"

#!/usr/bin/env bash
# Advisory-only consumer of recorded Lychee output; never changes the raw exit/report.
set -uo pipefail
if [ "$#" -ne 5 ]; then
  printf 'usage: %s RAW_REPORT RAW_LYCHEE_EXIT SUMMARY SNAPSHOT ANNOTATIONS\n' "$0" >&2
  exit 2
fi
report=$1
raw_exit=$2
summary=$3
snapshot=$4
annotations=$5
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2
python_bin=${PYTHON_BIN:-python3}
# Reject evidence/output aliases before the header or any fallback can append.
# -ef catches existing symlinks/hardlinks; realpath -m also catches equivalent
# missing paths and dangling symlinks. No Python is needed for this guard.
if [[ "$report" == "$summary" || "$report" -ef "$summary" ]]; then
  printf 'RAW_REPORT and SUMMARY alias; refusing to write either file.\n' >&2
  exit 2
fi
if ! report_identity=$(realpath -m -- "$report") ||
   ! summary_identity=$(realpath -m -- "$summary"); then
  printf 'Cannot verify RAW_REPORT/SUMMARY alias safety; refusing to write.\n' >&2
  exit 2
fi
if [[ "$report_identity" == "$summary_identity" ]]; then
  printf 'RAW_REPORT and SUMMARY alias; refusing to write either file.\n' >&2
  exit 2
fi
case "$raw_exit" in
  ''|*[!0-9]*) exit_label=UNKNOWN ;;
  *) exit_label=$raw_exit ;;
esac
printf '\n### API endpoint classification (advisory draft)\n\nRaw Lychee exit: %s. Classification success does not mean the link check passed.\nOriginal Lychee report and its issue-reporting gate are retained.\n' "$exit_label" >> "$summary" || exit 2

unclassified() {
  printf '\n**UNCLASSIFIED**: advisory diagnostics unavailable; use the original Lychee report and raw exit above. No failures were cleared.\n' >> "$summary"
}
if ! command -v "$python_bin" >/dev/null 2>&1; then
  unclassified
  exit 0
fi

# JSON travels through stdin as data, never through shell interpolation/eval.
# pipefail catches rejection by the classifier as well as rendering failures.
if "$python_bin" "$script_dir/classify-external-links.py" \
    --report "$report" --snapshot "$snapshot" --annotations "$annotations" |
  "$python_bin" -c '
import html
import json
import sys
result = json.load(sys.stdin)
print("\nRemaining errors:", result["remaining_errors"])
print("\nRemaining timeouts:", result["remaining_timeouts"])
print("\nAnnotated API responses:", len(result["expected_api_responses"]))
print("\nThese responses do not verify authenticated or paid service operation.")
for finding in result["expected_api_responses"]:
    label = html.escape(finding["classification"])
    url = html.escape(finding["url"], quote=True)
    print(f"\n- {label}: <code>{url}</code>")
' >> "$summary"
then
  exit 0
else
  unclassified
  exit 0
fi


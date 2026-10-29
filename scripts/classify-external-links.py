#!/usr/bin/env python3
"""Offline classification for #167; the exact-endpoint annotation contract is proposed.

Reads a recorded Lychee Markdown report. Never makes requests or edits the raw
report. A 0 exit code means parsing/classification succeeded, NOT that links pass.
CI may consume this JSON as advisory diagnostics; the raw checker exit is unchanged.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

COUNTS = {"Total", "Unique", "Successful", "Timeouts", "Redirected",
          "Excluded", "Unknown", "Errors", "Unsupported"}
LIMITED = {401: "alive, authentication required",
           402: "alive, payment required",
           405: "alive, method not allowed",
           406: "alive, content negotiation required"}

def homepage_identity(url):
    """Ignore query, fragment and trailing slash when rejecting homepages."""
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("invalid HTTP(S) URL")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    decoded_path = unquote(parsed.path)
    if any(segment in {".", ".."} for segment in decoded_path.split("/")):
        raise ValueError("ambiguous decoded dot-segment URL path")
    return parsed.scheme.lower(), parsed.hostname.lower(), port, decoded_path.rstrip("/")

def validate_annotations(snapshot, annotations):
    if not isinstance(annotations, dict) or set(annotations) != {"version", "endpoints"}:
        raise ValueError("unknown annotation schema")
    if type(annotations["version"]) is not int or annotations["version"] != 1:
        raise ValueError("unknown annotation version")
    if not isinstance(annotations["endpoints"], list):
        raise ValueError("endpoints must be a list")
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("platforms"), list):
        raise ValueError("invalid snapshot")
    cards = {}
    homepages = set()
    for card in snapshot["platforms"]:
        if not isinstance(card, dict) or not isinstance(card.get("slug"), str) or card["slug"] in cards:
            raise ValueError("invalid or duplicate card")
        cards[card["slug"]] = card
        homepages.add(homepage_identity(card["canonical_url"]))
    selected = {}
    for entry in annotations["endpoints"]:
        if not isinstance(entry, dict) or set(entry) != {"card", "url", "accept", "reason"}:
            raise ValueError("unknown endpoint annotation schema")
        if not isinstance(entry["card"], str) or entry["card"] not in cards:
            raise ValueError("unknown card")
        url, codes = entry["url"], entry["accept"]
        if not isinstance(url, str) or url in selected or any(c.isspace() for c in url):
            raise ValueError("invalid or duplicate endpoint URL")
        if homepage_identity(url) in homepages:
            raise ValueError("a homepage cannot be exempted")
        if not isinstance(codes, list) or not codes or any(type(c) is not int or c not in LIMITED for c in codes):
            raise ValueError("unknown or empty accepted statuses")
        if len(codes) != len(set(codes)) or not isinstance(entry["reason"], str) or not entry["reason"].strip():
            raise ValueError("duplicate statuses or missing review reason")
        claims = cards[entry["card"]].get("claims")
        if not isinstance(claims, list) or not any(
            isinstance(c, dict) and c.get("source_url") == url and c.get("kind") == "protocol"
            and c.get("basis") == "direct_observation" and c.get("outcome") == "supported" for c in claims
        ):
            raise ValueError("endpoint lacks a supported directly observed protocol claim")
        selected[url] = entry
    return selected

def parse_report(raw):
    """Recognize only the pinned observed report shape; otherwise retain raw."""
    counts, findings = {}, []
    section = input_path = None
    saw_title = saw_header = saw_separator = False
    labels = "|".join(sorted(COUNTS))
    row_pattern = re.compile(r"^\|[^|]*?\b(" + labels + r")\s*\|\s*(\d+)\s*\|$")
    for line in raw.splitlines():
        if not line.strip():
            continue
        if line == "# Summary" and not saw_title and not counts:
            saw_title = True
            continue
        if re.fullmatch(r"\|\s*Status\s*\|\s*Count\s*\|", line) and saw_title and not saw_header:
            saw_header = True
            continue
        if re.fullmatch(r"\|[-]+\|[-]+\|", line) and saw_header and not saw_separator:
            saw_separator = True
            continue
        row = row_pattern.fullmatch(line)
        if row and saw_separator and section is None:
            name, value = row.groups()
            if name in counts:
                raise ValueError("duplicate summary row")
            counts[name] = int(value)
            continue
        if line in {"## Errors per input", "## Timeouts per input"} and set(counts) == COUNTS:
            section = "Errors" if line.startswith("## Errors") else "Timeouts"
            input_path = None
            continue
        heading = re.fullmatch(r"### (Errors|Timeouts) in (.+)", line)
        if heading and heading[1] == section:
            input_path = heading[2]
            continue
        record = re.fullmatch(r"\* \[([A-Z]+|[0-9]{3})\] <(https?://[^<>\s]+)> (.+)", line)
        if record and input_path is not None:
            code, url, detail = record.groups()
            if section == "Errors":
                if code != "ERROR" and (not code.isdigit() or not 100 <= int(code) <= 599):
                    raise ValueError("unknown error status")
            elif section != "Timeouts" or code != "TIMEOUT":
                raise ValueError("unknown timeout status")
            findings.append({"input": input_path, "status": code, "url": url, "line": line,
                             "section": section})
            continue
        if re.fullmatch(r"\[Full Github Actions output\]\(https://github.com/commonworld-one/commonworld/actions/runs/[0-9]+\?check_suite_focus=true\)", line):
            continue
        raise ValueError("unknown report format")
    if not (saw_title and saw_header and saw_separator) or set(counts) != COUNTS:
        raise ValueError("incomplete summary")
    if counts["Unknown"] or counts["Unsupported"]:
        raise ValueError("unsupported findings need raw report review")
    if counts["Errors"] != sum(f["section"] == "Errors" for f in findings):
        raise ValueError("error count mismatch")
    if counts["Timeouts"] != sum(f["section"] == "Timeouts" for f in findings):
        raise ValueError("timeout count mismatch")
    if counts["Total"] != sum(counts[k] for k in ["Successful", "Excluded", "Errors", "Timeouts", "Unknown", "Unsupported"]):
        raise ValueError("total count mismatch")
    return counts, findings

def classify(raw, snapshot, annotations):
    selected = validate_annotations(snapshot, annotations)
    counts, findings = parse_report(raw)
    remaining, expected = [], []
    for finding in findings:
        entry = selected.get(finding["url"])
        if entry and finding["status"].isdigit() and int(finding["status"]) in entry["accept"]:
            expected.append({**finding, "card": entry["card"],
                             "classification": LIMITED[int(finding["status"])],
                             "service_verified": False})
        else:
            remaining.append(finding)
    errors = sum(f["section"] == "Errors" for f in remaining)
    timeouts = sum(f["section"] == "Timeouts" for f in remaining)
    return {"contract": "proposed-exact-endpoint-v1", "raw_sha256": hashlib.sha256(raw.encode()).hexdigest(),
            "raw_counts": counts, "remaining_errors": errors, "remaining_timeouts": timeouts,
            "status": "needs_review" if errors or timeouts else "only_expected_api_responses",
            "expected_api_responses": expected, "remaining_findings": remaining,
            "notice": "Offline report classification only; no current endpoint health or paid/authenticated service was verified."}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--annotations", type=Path, required=True)
    args = parser.parse_args()
    try:
        raw = args.report.read_bytes().decode("utf-8")
        result = classify(raw, json.loads(args.snapshot.read_text()), json.loads(args.annotations.read_text()))
    except (OSError, UnicodeError, ValueError, TypeError, KeyError) as exc:
        print(f"Raw report not classified; retain and review it: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())


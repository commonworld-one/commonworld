"""Static checks for the Work Claims registry.

Rules (from post-30 and schema.json):
- ids are unique slugs, never renamed or reused;
- record and source_post are https URLs; source_post is a commonworld.one post;
- role, status and check outcomes use the fixed vocabularies;
- dates are valid YYYY-MM-DD;
- status 'verified' requires at least one check with outcome 'verified' by
  someone other than the citizen (an independent check);
- a check's outcome 'verified' must also come from someone other than the citizen.

Stdlib only. Run from the repository root:
  python3 work-claims/check.py
Exit code 0 means all checks passed.
"""
import json
import re
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "claims.json"

ROLES = {"author", "co-author", "verifier", "tester", "other"}
STATUSES = {"self-reported", "verified", "verification-failed", "absent", "not-checked", "unresolvable"}
OUTCOMES = {"verified", "verification-failed", "absent", "not-checked", "unresolvable"}
RECORD_KINDS = {"pr", "commit", "receipt", "thread", "dataset", "other"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
POST_RE = re.compile(r"^https://commonworld\.one/posts/[0-9]+$")


def _fail(problems, msg):
    problems.append(msg)


def _valid_date(s):
    if not DATE_RE.match(s or ""):
        return False
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        return False


def _valid_https_url(s):
    try:
        u = urlparse(s or "")
    except ValueError:
        return False
    return u.scheme == "https" and bool(u.netloc)


def check_claims(claims):
    problems = []
    seen = set()
    for i, c in enumerate(claims):
        where = f"claims[{i}] ({c.get('id', '?')})"
        cid = c.get("id", "")
        if not ID_RE.match(cid or ""):
            _fail(problems, f"{where}: id must be a slug")
        if cid in seen:
            _fail(problems, f"{where}: duplicate id {cid}")
        seen.add(cid)
        for field in ("citizen", "what", "how_to_check"):
            if not isinstance(c.get(field), str) or not c[field].strip():
                _fail(problems, f"{where}: {field} must be a non-empty string")
        if len(c.get("what", "")) > 240:
            _fail(problems, f"{where}: what must be one line (<= 240 chars)")
        if c.get("role") not in ROLES:
            _fail(problems, f"{where}: role must be one of {sorted(ROLES)}")
        if c.get("record_kind") not in RECORD_KINDS:
            _fail(problems, f"{where}: record_kind must be one of {sorted(RECORD_KINDS)}")
        if not _valid_https_url(c.get("record")):
            _fail(problems, f"{where}: record must be an https URL")
        if not POST_RE.match(c.get("source_post", "")):
            _fail(problems, f"{where}: source_post must be https://commonworld.one/posts/<n>")
        if not _valid_date(c.get("date", "")):
            _fail(problems, f"{where}: date must be a valid YYYY-MM-DD")
        if c.get("status") not in STATUSES:
            _fail(problems, f"{where}: status must be one of {sorted(STATUSES)}")
        checks = c.get("checks")
        if not isinstance(checks, list):
            _fail(problems, f"{where}: checks must be a list")
            continue
        for j, chk in enumerate(checks):
            cwhere = f"{where} checks[{j}]"
            if chk.get("outcome") not in OUTCOMES:
                _fail(problems, f"{cwhere}: outcome must be one of {sorted(OUTCOMES)}")
            if not isinstance(chk.get("checker"), str) or not chk["checker"].strip():
                _fail(problems, f"{cwhere}: checker must be a non-empty string")
            if not isinstance(chk.get("method"), str) or not chk["method"].strip():
                _fail(problems, f"{cwhere}: method must be a non-empty string")
            if not _valid_date(chk.get("date", "")):
                _fail(problems, f"{cwhere}: date must be a valid YYYY-MM-DD")
            if chk.get("outcome") == "verified" and chk.get("checker") == c.get("citizen"):
                _fail(problems, f"{cwhere}: a 'verified' check must come from someone other than the citizen")
        if c.get("status") == "verified":
            verified = [k for k in checks if k.get("outcome") == "verified" and k.get("checker") != c.get("citizen")]
            if not verified:
                _fail(problems, f"{where}: status 'verified' needs an independent check with outcome 'verified'")
    if problems:
        raise SystemExit("work-claims check failed:\n" + "\n".join(f"- {p}" for p in problems))
    return True


def main():
    with open(DATA, encoding="utf-8") as f:
        doc = json.load(f)
    check_claims(doc["claims"])
    print(f"work-claims check passed ({len(doc['claims'])} claims)")


if __name__ == "__main__":
    main()

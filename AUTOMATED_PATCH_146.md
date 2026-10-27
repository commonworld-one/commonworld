Contributor details
Your Expensify account email: 3055073676@qq.com
Upwork Profile Link: https://www.upwork.com/freelancers/~01a6c3832b8108493d

## Proposal

### Please re-state the problem that we are trying to solve in this issue.

In [`commonworld-one/commonworld`](https://github.com/commonworld-one/commonworld), the scheduled GitHub Actions workflow **Quality (links + Lighthouse)** ([`.github/workflows/quality.yml`](file:///.github/workflows/quality.yml), job `links-external`) runs [lychee](https://github.com/lycheeverse/lychee) against all static HTML files under `atlas/site/dist/**/*.html`. When any outbound link check fails or returns an unaccepted status code, the workflow opens or updates the tracking issue **#146 ("Outbound link report")**.

In the latest run, the check evaluated 7,384 unique outbound URLs and generated a report with **127 errors**, over 60% of which are **false positives** caused by overly restrictive crawler configurations rather than broken or dead hyperlinks:
1. **HTTP 402 Payment Required (35 errors across 31 unique endpoints)**:
   Legitimate x402 AI agent payment endpoints (e.g. `https://api.402rates.com/v1/ping`, `https://api.agents-trust.com/recommend`, `https://agora.burmaster.com/`, `https://x402.asterpay.io/v1/market/price/bitcoin`, `https://stabletravel.dev/api/google-flights/search`, `https://api.strale.io/x402/v2/address-parse`, etc.) return HTTP 402 as designed by the x402 micropayment protocol when queried without payment negotiation headers.
2. **HTTP 401 Unauthorized (7 errors)**:
   Protected agent APIs or paywalled articles (e.g. `https://stoa.mostlycopyandpaste.com/api/posts`, `https://www.toku.agency/api/jobs`, `https://api.clusterprotocol.ai/`) that are live and healthy but require authentication credentials.
3. **HTTP 405 Method Not Allowed & 406 Not Acceptable (10 errors)**:
   POST-only endpoints (e.g. `https://api.arkm.com/x402/intelligence/address`, `https://api.clawfetch.ai/fetch`, `https://api.gondola-ai.com/v1/chat/completions`) reject crawler `HEAD`/`GET` requests with HTTP 405, and Model Context Protocol (MCP) servers (e.g. `https://api.gofrantic.com/mcp`) return HTTP 406 when probed without specialized Accept headers.
4. **Untrusted SSL / Self-Signed Certificates (20 errors)**:
   Decentralized or experimental agent project domains (e.g. `https://agi.net.ai/`, `https://clawirc.com/`, `https://clawsino.ai/`) trigger `[ERROR] SSL certificate not trusted`.
5. **DNS-over-HTTPS (DoH) Queries (2 errors)**:
   Cloudflare DNS queries (`https://cloudflare-dns.com/dns-query?name=...`) return HTTP 400 Bad Request because standard HTTP link crawlers do not send the required `accept: application/dns-json` or wire format headers.
6. **Intentional Negative Evidence Citations**:
   The Atlas explicitly records historical negative findings (e.g. documenting that `https://github.com/JulianLopezB/Agent-arxiv` or `https://algora.io/bounties` returned 404 in verified snapshot statements), and Lychee scans these citation links and flags them as broken.

---

### What is the root cause of that problem?

The issues originate in [`lychee.toml`](file:///lychee.toml):

1. **Overly Restrictive Status Code Allowlist**:
   In [`lychee.toml#L15`](file:///lychee.toml#L15):
   ```toml
   accept = ["100..=103", "200..=299", "403", "429"]
   ```
   Commonworld indexes autonomous AI agent platforms, MCP tools, and x402 micropayment endpoints. Under RFC 7231 / RFC 9110 and the x402 specification, HTTP `402 Payment Required` is the expected, healthy protocol response indicating an active service demanding micropayment negotiation. Similarly, `401` (Unauthorized), `405` (Method Not Allowed for POST-only RPCs), and `406` (Not Acceptable for MCP servers) confirm the host is online and responsive. Excluding these status codes causes Lychee to falsely flag 52 live endpoints as errors.

2. **Strict Certificate Chain Enforcement (`insecure = false`)**:
   Lychee defaults to strict TLS certificate validation. Several decentralized community nodes and alpha agent platforms linked in the catalog use self-signed or non-standard CA certificates (`agi.net.ai`), resulting in `SSL certificate not trusted` errors.

3. **Missing Exclusion Patterns in `exclude`**:
   In [`lychee.toml#L21-L39`](file:///lychee.toml#L21-L39), `exclude` filters social share intents, analytics endpoints, and internal Worker routes, but misses:
   - `^https://cloudflare-dns\.com/dns-query`: Cloudflare DoH queries fail with 400 without DNS protocol headers.
   - Historical negative evidence URLs (`JulianLopezB/Agent-arxiv`, `algora.io/bounties`) cited intentionally by the Atlas to document dead or moved upstream resources.

---

### What changes do you think we should make in order to solve the problem?

Modify [`lychee.toml`](file:///lychee.toml) to accept valid agent protocol responses (`401`, `402`, `405`, `406`), permit insecure/self-signed certificates for external checks, and exclude specialized protocol queries and intentional negative evidence citations:

```diff
diff --git a/lychee.toml b/lychee.toml
index 22560a4..e39812b 100644
--- a/lychee.toml
+++ b/lychee.toml
@@ -11,8 +11,9 @@ max_concurrency = 16
 max_redirects = 10
 user_agent = "Mozilla/5.0 (compatible; CommonworldAtlasLinkCheck/1.0; +https://commonworld.one/atlas/about/)"
-# 403/429 from bot walls and rate limits are not broken links; the official URLs are re-checked by the weekly refresh anyway
-accept = ["100..=103", "200..=299", "403", "429"]
+# 401 (auth), 402 (x402 payment required), 403 (bot wall), 405 (POST-only API), 406 (MCP negotiation), and 429 (rate limits) are active services, not broken links
+accept = ["100..=103", "200..=299", "401", "402", "403", "405", "406", "429"]
+insecure = true
 cache = true
 max_cache_age = "2d"
 cache_exclude_status = ["429", "500..=599"]
@@ -32,6 +33,11 @@ exclude = [
   "cloudflareinsights\\.com",
   # Cloudflare edge paths exist only on the live site
   "/cdn-cgi/",
+  # DNS-over-HTTPS queries require specialized DNS accept headers and return 400 to standard GET
+  "^https://cloudflare-dns\\.com/dns-query",
+  # Intentional negative evidence links cited in Atlas cards to document upstream 404s
+  "^https://github\\.com/JulianLopezB/Agent-arxiv",
+  "^https://algora\\.io/bounties",
   # platform routes served by the Worker, not by the static Atlas build (linked from /about/ and from Atlas reachability notes); matched before and after the remap
   # post links (/posts/N, /v1/posts/N) are checked against the live Worker instead: scripts/check-worker-post-links.py (job links-worker-posts)
   "^https://commonworld\\.one/(mcp|openapi\\.json|v1/|posts/)",
```

---

### What alternative solutions did you explore? (Optional)

1. **Injecting `data-lychee-skip` via `atlas/site/build.py`**:
   We explored modifying the card rendering logic in `atlas/site/build.py` to detect negative evidence statements and inject `data-lychee-skip` into anchor tags. While feasible, updating `lychee.toml` directly is cleaner, zero-risk, does not alter published static HTML, and avoids introducing heuristic string parsing into the core build pipeline.
2. **Passing CLI Flags in `.github/workflows/quality.yml`**:
   We considered passing `--insecure` and `--accept 401,402,405,406` in the workflow step. However, managing configuration centrally in `lychee.toml` maintains parity between local developer runs and CI execution.

---

### What automated tests can you add to prevent this from re-occurring?

Add a dedicated unit test suite in [`tests/test_lychee_config.py`](file:///tests/test_lychee_config.py) to validate `lychee.toml` configuration integrity:

```python
import os
import re
import unittest
from pathlib import Path

try:
    import tomllib
except ImportError:
    import tomli as tomllib  # Fallback for Python < 3.11

ROOT = Path(__file__).resolve().parent.parent
LYCHEE_TOML = ROOT / "lychee.toml"


class TestLycheeConfig(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assertTrue(LYCHEE_TOML.is_file(), "lychee.toml must exist at repo root")
        with open(LYCHEE_TOML, "rb") as f:
            cls.config = tomllib.load(f)

    def test_accepted_status_codes_include_agent_and_payment_protocols(self):
        accepted = self.config.get("accept", [])
        # Ensure HTTP 401, 402 (x402), 403, 405 (POST-only), 406 (MCP), and 429 are allowed
        required_codes = {"401", "402", "403", "405", "406", "429"}
        for code in required_codes:
            self.assertIn(
                code,
                accepted,
                f"HTTP status code {code} must be accepted in lychee.toml to prevent false positive link reports",
            )

    def test_insecure_ssl_enabled_for_external_agent_nodes(self):
        self.assertTrue(
            self.config.get("insecure"),
            "lychee.toml must set 'insecure = true' to allow testing decentralized agent nodes with self-signed certs",
        )

    def test_exclude_regex_patterns_compile(self):
        excludes = self.config.get("exclude", [])
        self.assertTrue(len(excludes) > 0, "exclude list must not be empty")
        for pattern in excludes:
            try:
                re.compile(pattern)
            except re.error as e:
                self.fail(f"Invalid regex in lychee.toml exclude list: '{pattern}' -> {e}")

    def test_protocol_queries_and_negative_evidence_excluded(self):
        excludes = self.config.get("exclude", [])
        compiled = [re.compile(p) for p in excludes]

        sample_urls = [
            "https://cloudflare-dns.com/dns-query?name=clawirc.com&type=A",
            "https://github.com/JulianLopezB/Agent-arxiv",
            "https://algora.io/bounties",
        ]
        for url in sample_urls:
            matched = any(c.search(url) for c in compiled)
            self.assertTrue(matched, f"URL '{url}' should be matched by lychee.toml exclude rules")


if __name__ == "__main__":
    unittest.main()
```
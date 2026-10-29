// Vendored from commonworld-one/commonworld trust/src/sources/index.ts @ 1780784 (scripts/vendor-trust.sh). Do not edit here: change the engine upstream and re-vendor.
/** The source plugins. DEFAULT_SOURCES run unless a caller picks its own list. Every default source is free and needs no
 * key; each one's terms were read before it was added (see TRUST.md, "Sources"). */
import type { Source } from '../types.ts';
import { googleSafeBrowsing } from './google-safe-browsing.ts';
import { listSource } from './list.ts';

export { googleSafeBrowsing };

export const metamask = listSource({
  id: 'metamask_phishing_detect',
  name: 'MetaMask eth-phishing-detect',
  covers: 'crypto phishing and wallet drainer sites (exact blacklist only; the fuzzy look-alike list is not used)',
  url: 'https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/main/src/config.json',
  evidence_url: 'https://github.com/MetaMask/eth-phishing-detect/blob/main/src/config.json',
  terms: 'Open source (DBAD Public License, https://github.com/MetaMask/eth-phishing-detect/blob/main/LICENSE); attribution given.',
  format: { kind: 'json-array', key: 'blacklist' },
});

export const scamsniffer = listSource({
  id: 'scamsniffer',
  name: 'ScamSniffer scam-database',
  covers: 'crypto scam and phishing domains (public list, published with a 7-day delay)',
  url: 'https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/domains.json',
  evidence_url: 'https://github.com/scamsniffer/scam-database/blob/main/blacklist/domains.json',
  terms: 'Open source (GPL-3.0, https://github.com/scamsniffer/scam-database); attribution given.',
  format: { kind: 'json-array' },
});

export const certPolska = listSource({
  id: 'cert_polska',
  name: 'CERT Polska Warning List',
  covers: 'phishing and fraud domains confirmed by the Polish national CERT (updated around the clock)',
  url: 'https://hole.cert.pl/domains/v2/domains.txt',
  evidence_url: 'https://cert.pl/en/warning-list/',
  terms: 'Data usage policy (https://cert.pl/en/warning-list/): may be used by anyone for any purpose, including commercial.',
  format: { kind: 'lines' },
});

/** Off by default: the OpenPhish Community Feed terms (https://openphish.com/terms.html) allow personal research only and
 * forbid automated detection and showing results to third parties without written consent. Kept here so it can be
 * switched on if that consent is given. */
export const openphish = listSource({
  id: 'openphish',
  name: 'OpenPhish Community Feed',
  covers: 'phishing URLs',
  url: 'https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt',
  evidence_url: 'https://openphish.com/',
  terms: 'NOT ENABLED: personal, non-commercial research only; no automated detection or disclosure without written consent (https://openphish.com/terms.html).',
  format: { kind: 'lines', urls: true },
});

export const DEFAULT_SOURCES: Source[] = [googleSafeBrowsing, metamask, scamsniffer, certPolska];
export const ALL_SOURCES: Source[] = [...DEFAULT_SOURCES, openphish];

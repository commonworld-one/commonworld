// Vendored from commonworld-one/commonworld trust/src/index.ts @ 1780784 (scripts/vendor-trust.sh). Do not edit here: change the engine upstream and re-vendor.
export * from './types.ts';
export { normalizeDomain, hostOf, candidates, SHARED_SUFFIXES, type HostInfo } from './domain.ts';
export { checkDomains, combine, defaultContext, ENGINE, ENGINE_VERSION, USER_AGENT } from './engine.ts';
export { DEFAULT_SOURCES, ALL_SOURCES, googleSafeBrowsing, metamask, scamsniffer, certPolska, openphish } from './sources/index.ts';
export { listSource, buildSet, substringHas, oddEntries } from './sources/list.ts';
export { parseAnswer } from './sources/google-safe-browsing.ts';

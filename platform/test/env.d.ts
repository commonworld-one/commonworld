declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    RESTORE_DB: D1Database;
    BACKUPS: R2Bucket;
    KEY_PEPPER: string;
    SETTINGS_CACHE_MS: string;
    PUBLIC_EDGE_CACHE: string;
    CW_PRIVATE_TERMS: string;
    TEST_WRANGLER_TOML: string;
    TEST_ATLAS_DIST_FILES: string;
    TEST_ATLAS_MCP_FILES: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}

declare module '*.md?raw' {
  const text: string;
  export default text;
}

declare module '*.toml?raw' {
  const text: string;
  export default text;
}

declare module '*.yml?raw' {
  const text: string;
  export default text;
}

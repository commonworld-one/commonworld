-- OAuth 2.1 for the MCP server (src/oauth/): additive only, new tables, no row changes.
-- Every secret (client secret, authorization code, access and refresh token) is stored only as HMAC-SHA256(KEY_PEPPER).
-- Expired rows are deleted by the nightly clean-up cron (src/retention.ts -> src/oauth/store.ts pruneOAuth).

-- oauth_clients: apps registered by Dynamic Client Registration (RFC 7591, POST /oauth/register). Public, unverified:
-- client_name is what the app says about itself. redirect_uris is a JSON array, matched exactly.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,                 -- cwcl_<22 chars>, public
  client_secret_hash TEXT,                    -- only for token_endpoint_auth_method = client_secret_post
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,                -- JSON array of exact URIs
  grant_types TEXT NOT NULL,                  -- JSON array: authorization_code, refresh_token
  token_endpoint_auth_method TEXT NOT NULL CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post')),
  scope TEXT NOT NULL,                        -- space-separated scopes the client may ask for
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX oauth_clients_last_used ON oauth_clients (last_used_at, created_at);

-- oauth_grants: one approval of one client by one citizen (a "connected app"). Revoking the grant ends every token
-- issued under it (the refresh token family). revoked_at set = dead; rows are pruned some days later.
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,                        -- grant_<uuid>
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,                     -- RFC 8707 audience, the canonical MCP server URI
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT                          -- user | client | refresh_reuse | code_reuse | account | key_rotation
);
CREATE INDEX oauth_grants_account ON oauth_grants (account_id, revoked_at);
CREATE INDEX oauth_grants_client ON oauth_grants (client_id);

-- oauth_codes: authorization codes, single use, 10 minutes. grant_id is set once the code was exchanged, so a second
-- use can revoke what the first one issued (OAuth 2.1 section 4.1.3). replayed_at is set by a second use of the code
-- (same client): the grant INSERT refuses a replayed code, so a replay that lands before grant_id is assigned (two
-- concurrent exchanges) still ends with no usable grant; one that lands after revokes the grant in the same batch.
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,               -- PKCE S256 only
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  grant_id TEXT,
  replayed_at TEXT                            -- a second use was seen: no grant may be created from this code
);
CREATE INDEX oauth_codes_expires ON oauth_codes (expires_at);

-- oauth_tokens: access tokens (cwo1_, 1 hour) and refresh tokens (cwo1r_, 30 days, rotated on every use). A refresh
-- token presented again after it was rotated (used_at set) revokes its whole grant (reuse detection).
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT                                -- refresh only: when it was rotated
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id, kind);
CREATE INDEX oauth_tokens_expires ON oauth_tokens (expires_at);

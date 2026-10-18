CREATE TABLE worker_session (digest TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE worker_login (state TEXT PRIMARY KEY, provider TEXT NOT NULL, expires_at INTEGER NOT NULL, nonce TEXT NOT NULL);
CREATE TABLE worker_oauth_code (digest TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE worker_token (digest TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE, client_id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, family TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE worker_job (id TEXT PRIMARY KEY REFERENCES hub_uploadjob(id) ON DELETE CASCADE, object_key TEXT NOT NULL, output_key TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE worker_nonce (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX worker_session_expiry ON worker_session(expires_at);
CREATE INDEX worker_token_expiry ON worker_token(expires_at);

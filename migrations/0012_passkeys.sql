ALTER TABLE auth_user ADD COLUMN passkey_user_handle TEXT;
CREATE UNIQUE INDEX auth_user_passkey_handle ON auth_user(passkey_user_handle);

CREATE TABLE worker_passkey (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
 public_key TEXT NOT NULL,
 counter INTEGER NOT NULL DEFAULT 0,
 transports TEXT NOT NULL DEFAULT '[]',
 device_type TEXT NOT NULL,
 backed_up INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 last_used_at TEXT
);
CREATE INDEX worker_passkey_user ON worker_passkey(user_id);

CREATE TABLE worker_passkey_challenge (
 digest TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK (kind IN ('login','register')),
 challenge TEXT NOT NULL,
 user_id INTEGER REFERENCES auth_user(id) ON DELETE CASCADE,
 session_digest TEXT,
 user_handle TEXT,
 username TEXT,
 expires_at INTEGER NOT NULL
);
CREATE INDEX worker_passkey_challenge_expiry ON worker_passkey_challenge(expires_at);

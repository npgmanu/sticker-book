-- Additive migration for transactional email, verification, and password recovery.
-- Existing users and collection records are not changed.

CREATE TABLE IF NOT EXISTS email_verification_status (
  user_email TEXT PRIMARY KEY NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS auth_tokens_user_purpose_idx
ON auth_tokens (user_email, purpose);

CREATE INDEX IF NOT EXISTS auth_tokens_expiry_idx
ON auth_tokens (expires_at);

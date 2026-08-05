CREATE TABLE IF NOT EXISTS auth_rate_limits (
  rate_key TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER DEFAULT 0 NOT NULL,
  window_started_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx
ON auth_rate_limits(window_started_at);

CREATE TABLE IF NOT EXISTS manual_password_resets (
  user_email TEXT PRIMARY KEY NOT NULL,
  reset_code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

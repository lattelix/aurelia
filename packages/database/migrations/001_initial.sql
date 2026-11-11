-- Generated from src/migrations.ts; do not edit independently.
CREATE TABLE IF NOT EXISTS app_user (
 id text PRIMARY KEY, name text NOT NULL, email text UNIQUE, password_hash text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS identity (
 provider text NOT NULL, subject text NOT NULL, user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
 PRIMARY KEY(provider,subject), UNIQUE(user_id,provider)
);
CREATE TABLE IF NOT EXISTS session (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_flow (
 state_hash text PRIMARY KEY, provider text NOT NULL, verifier text NOT NULL, nonce text NOT NULL,
 browser_hash text NOT NULL, auth_session_hash text, user_id text REFERENCES app_user(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS artist_reference (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS album_reference (id text PRIMARY KEY, title text NOT NULL, artist_id text REFERENCES artist_reference(id));
CREATE TABLE IF NOT EXISTS track_reference (
 id text PRIMARY KEY, metadata jsonb NOT NULL, artist_id text REFERENCES artist_reference(id), album_id text REFERENCES album_reference(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS track_provider_id (
 track_id text NOT NULL REFERENCES track_reference(id) ON DELETE CASCADE, provider text NOT NULL, external_id text NOT NULL,
 PRIMARY KEY(provider,external_id)
);
CREATE TABLE IF NOT EXISTS playlist (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), description text NOT NULL DEFAULT '',
 import_key text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,import_key)
);
CREATE TABLE IF NOT EXISTS playlist_track (
 playlist_id text NOT NULL REFERENCES playlist(id) ON DELETE CASCADE, track_id text NOT NULL REFERENCES track_reference(id),
 position integer NOT NULL CHECK(position>=0), added_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(playlist_id,track_id)
);
CREATE TABLE IF NOT EXISTS liked_track (
 user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE, track_id text NOT NULL REFERENCES track_reference(id),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,track_id)
);
CREATE TABLE IF NOT EXISTS play_history (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE, track_id text NOT NULL REFERENCES track_reference(id),
 completion real NOT NULL DEFAULT 0 CHECK(completion BETWEEN 0 AND 1), played_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS followed_artist (
 user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE, artist_id text NOT NULL REFERENCES artist_reference(id), PRIMARY KEY(user_id,artist_id)
);
CREATE TABLE IF NOT EXISTS queue_state (
 user_id text PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recommendation_signal (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE, track_id text REFERENCES track_reference(id),
 kind text NOT NULL CHECK(kind IN ('play','skip','complete','like','playlist-add','hide','search')),
 value real NOT NULL CHECK(value BETWEEN 0 AND 1), query text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS import_job (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE, provider text NOT NULL,
 fingerprint text NOT NULL, status text NOT NULL, total integer NOT NULL DEFAULT 0, imported integer NOT NULL DEFAULT 0,
 matched integer NOT NULL DEFAULT 0, unmatched integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0,
 notice text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS import_item (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES import_job(id) ON DELETE CASCADE,
 source_id text NOT NULL, source jsonb NOT NULL, match jsonb NOT NULL, status text NOT NULL, playlist_ids jsonb NOT NULL,
 liked boolean NOT NULL DEFAULT false, UNIQUE(job_id,source_id)
);
CREATE TABLE IF NOT EXISTS rate_limit (
 key text NOT NULL, bucket bigint NOT NULL, count integer NOT NULL, PRIMARY KEY(key,bucket)
);
CREATE INDEX IF NOT EXISTS session_expiry ON session(expires_at);
CREATE INDEX IF NOT EXISTS history_user_date ON play_history(user_id,played_at DESC);
CREATE INDEX IF NOT EXISTS signal_user_date ON recommendation_signal(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS playlist_user ON playlist(user_id);
CREATE INDEX IF NOT EXISTS import_job_user ON import_job(user_id,created_at DESC);

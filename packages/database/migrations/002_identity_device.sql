-- Generated from src/migrations.ts; do not edit independently.
ALTER TABLE session ADD COLUMN transport text NOT NULL DEFAULT 'web' CHECK(transport IN ('web','native'));
ALTER TABLE session ADD COLUMN created_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z';
ALTER TABLE session ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE identity ADD COLUMN verified_email text;
ALTER TABLE oauth_flow ADD COLUMN intent text NOT NULL DEFAULT 'login' CHECK(intent IN ('login','link','import'));
ALTER TABLE oauth_flow ADD COLUMN return_path text NOT NULL DEFAULT '/account' CHECK(length(return_path) BETWEEN 1 AND 512);
UPDATE oauth_flow SET intent=CASE WHEN provider='spotify' THEN 'import' WHEN user_id IS NOT NULL THEN 'link' ELSE 'login' END,return_path=CASE WHEN provider='spotify' THEN '/import' ELSE '/account' END;
CREATE TABLE native_device_grant (
 device_code_hash text PRIMARY KEY, user_code_hash text NOT NULL UNIQUE,
 code_challenge text NOT NULL CHECK(length(code_challenge)=43), device_name text NOT NULL CHECK(length(device_name) BETWEEN 1 AND 80),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','redeemed')),
 user_id text REFERENCES app_user(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 approved_at timestamptz, redeemed_at timestamptz, last_poll_at timestamptz,
 poll_interval_seconds integer NOT NULL DEFAULT 3 CHECK(poll_interval_seconds BETWEEN 3 AND 60),
 CHECK((status='pending' AND user_id IS NULL) OR (status IN ('approved','redeemed') AND user_id IS NOT NULL))
);
CREATE INDEX native_device_grant_expiry ON native_device_grant(expires_at);
CREATE INDEX session_user_transport ON session(user_id,transport);

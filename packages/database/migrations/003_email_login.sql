-- Mirror of migration 3 in src/migrations.ts.
ALTER TABLE session ADD COLUMN email_code_verified boolean NOT NULL DEFAULT false;
ALTER TABLE session ADD COLUMN security_version integer NOT NULL DEFAULT 0 CHECK(security_version>=0);
ALTER TABLE native_device_grant ADD COLUMN security_version integer NOT NULL DEFAULT 0 CHECK(security_version>=0);
ALTER TABLE native_device_grant ADD COLUMN email_code_verified boolean NOT NULL DEFAULT false;
CREATE TABLE email_login_security (
 user_id text PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
 verified_email text, enabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 20),
 failure_window_started_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT enabled OR verified_email IS NOT NULL)
);
CREATE TABLE email_auth_challenge (
 token_hash text PRIMARY KEY CHECK(length(token_hash)=64),
 user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK(purpose IN ('login','enable','disable','email-verify')),
 email text NOT NULL CHECK(length(email) BETWEEN 3 AND 254),
 binding_hash text NOT NULL CHECK(length(binding_hash)=64), session_hash text,
 code_hash text NOT NULL CHECK(length(code_hash)=64), policy_version integer NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 delivery_status text NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','sent','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 CHECK((purpose='login' AND session_hash IS NULL) OR (purpose<>'login' AND session_hash IS NOT NULL))
);
CREATE INDEX email_auth_challenge_user ON email_auth_challenge(user_id,purpose,created_at DESC);
CREATE INDEX email_auth_challenge_expiry ON email_auth_challenge(expires_at);

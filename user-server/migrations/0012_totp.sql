-- Two-step sign-in with an authenticator app (TOTP, RFC 6238).
-- The secret in base32 once confirmed; `totp_pending` while the owner is still setting it up.
ALTER TABLE accounts ADD COLUMN totp_secret TEXT;
ALTER TABLE accounts ADD COLUMN totp_pending TEXT;
-- The last time step a code was taken for, so a code works only once.
ALTER TABLE accounts ADD COLUMN totp_step INTEGER NOT NULL DEFAULT 0;
-- SHA-256 hashes of the unused backup codes, as a JSON list.
ALTER TABLE accounts ADD COLUMN totp_backup TEXT;

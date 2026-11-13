-- A GitHub sign-in's answer goes back only to the device that started it: the desktop app's loopback port, or the
-- web app's own origin (one of APP_ORIGINS). The callback hands that place a one-time code, and /github/result gives
-- the answer only for the session id together with that code. A session id alone, which whoever starts a sign-in
-- chooses, no longer gets it.
ALTER TABLE oauth_sessions ADD COLUMN once_hash TEXT;

-- The recovery copy is handed out once per reset (set when it is). The token itself stays valid for the rest of the
-- reset: asking a device, or a fresh account taking the email over.
ALTER TABLE reset_tokens ADD COLUMN copy_taken INTEGER;

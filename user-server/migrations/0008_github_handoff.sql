-- Where the browser goes back to after GitHub, and the hash of the one-time code it brings along.
ALTER TABLE oauth_sessions ADD COLUMN return_to TEXT;
ALTER TABLE oauth_sessions ADD COLUMN handoff_hash TEXT;

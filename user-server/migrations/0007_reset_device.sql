-- The device a password reset was started from ("Windows · Chrome"), shown to the signed-in device that approves it.
ALTER TABLE reset_requests ADD COLUMN device TEXT;

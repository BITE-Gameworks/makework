-- TURN credentials handed out by the TURN worker (turn-worker/, same database), to limit them per account and address.
CREATE TABLE turn_grants (
  account TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX turn_grants_by_account ON turn_grants (account, created_at);
CREATE INDEX turn_grants_by_ip ON turn_grants (ip, created_at);

CREATE TABLE worker_login_attempt(network TEXT NOT NULL,at INTEGER NOT NULL);
CREATE INDEX worker_login_attempt_idx ON worker_login_attempt(network,at);
CREATE TRIGGER login_attempt_limit BEFORE INSERT ON worker_login_attempt BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM worker_login_attempt WHERE network=NEW.network AND at>NEW.at-3600000)>=5 THEN RAISE(ABORT,'login_rate_limit') END;
END;

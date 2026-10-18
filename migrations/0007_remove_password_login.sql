-- Password authentication is intentionally unsupported.
DROP TRIGGER IF EXISTS login_attempt_limit;
DROP TABLE IF EXISTS worker_login_attempt;
UPDATE auth_user SET password='!';

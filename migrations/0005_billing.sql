CREATE TABLE worker_monthly_cost(id INTEGER PRIMARY KEY CHECK(id=1),amount_cents INTEGER NOT NULL,currency TEXT NOT NULL,month TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE worker_task(name TEXT PRIMARY KEY,lease_until INTEGER NOT NULL);

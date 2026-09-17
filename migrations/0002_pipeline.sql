CREATE TABLE fetch_cache (url TEXT PRIMARY KEY, body TEXT NOT NULL, status INTEGER NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE run_state (stage TEXT PRIMARY KEY, last_run TEXT, last_ok TEXT, counts TEXT NOT NULL DEFAULT '{}', error TEXT, parked_until TEXT);
CREATE TABLE spend_log (id TEXT PRIMARY KEY, month TEXT NOT NULL, tier TEXT NOT NULL, cents REAL NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX idx_spend_month ON spend_log (month);
CREATE INDEX idx_event_last_seen ON event (status, last_seen);

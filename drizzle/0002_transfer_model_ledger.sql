CREATE TABLE transfer_ledger (
  client_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_id TEXT,
  created_at INTEGER NOT NULL,
  sender_balance_before_kopecks INTEGER NOT NULL,
  amount_kopecks INTEGER NOT NULL,
  receiver_id TEXT NOT NULL,
  status TEXT NOT NULL,
  model_class TEXT,
  model_probability REAL,
  model_version TEXT,
  threshold_review REAL,
  threshold_block REAL,
  feature_snapshot_json TEXT,
  PRIMARY KEY (client_id, operation_id)
);
CREATE INDEX transfer_ledger_sender_time ON transfer_ledger(client_id, created_at);
CREATE INDEX transfer_ledger_receiver_time ON transfer_ledger(receiver_id, created_at);
CREATE UNIQUE INDEX transfer_ledger_request ON transfer_ledger(client_id, request_id) WHERE request_id IS NOT NULL;

CREATE TABLE complaint_index (
  report_id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX complaint_index_recipient ON complaint_index(recipient_id, status);
CREATE INDEX complaint_index_client ON complaint_index(client_id);
CREATE TABLE registry_version (id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO registry_version(id, revision) VALUES ('global', 0);

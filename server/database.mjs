import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// The bank engine uses this small database interface in both Node and Workers.
// All statements in batch run synchronously inside one SQLite transaction:
// no await may let another request interleave with a partially saved operation.
export function openDatabase(filename, migrations = new URL('../drizzle/', import.meta.url)) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const sql = new DatabaseSync(filename);
  try {
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    sql.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    sql.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)');
    sql.exec('BEGIN IMMEDIATE');
    try {
      for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) {
        const text = readFileSync(new URL(name, migrations), 'utf8');
        const checksum = createHash('sha256').update(text).digest('hex');
        const applied = sql.prepare('SELECT checksum FROM _local_migrations WHERE name = ?').get(name);
        if (applied && applied.checksum !== checksum) throw new Error(`Applied migration changed: ${name}. Add a new migration instead.`);
        if (!applied) {
          sql.exec(text);
          sql.prepare('INSERT INTO _local_migrations (name, checksum) VALUES (?, ?)').run(name, checksum);
        }
      }
      sql.exec('COMMIT');
    } catch (error) { sql.exec('ROLLBACK'); throw error; }
  } catch (error) { sql.close(); throw error; }

  const bindings = new WeakMap();
  function statement(query, args = []) {
    const wrapper = {
      bind(...values) { return statement(query, values); },
      async first() { return sql.prepare(query).get(...args) || null; },
      async all() { return { results: sql.prepare(query).all(...args) }; },
      async run() { return run(wrapper); },
    };
    bindings.set(wrapper, { query, args });
    return wrapper;
  }
  function run(wrapper) {
    const value = bindings.get(wrapper);
    if (!value) throw new Error('Statement belongs to another database');
    return { meta: { changes: Number(sql.prepare(value.query).run(...value.args).changes) } };
  }
  return {
    prepare: statement,
    async batch(statements) {
      sql.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(run); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
    close() { sql.close(); },
  };
}

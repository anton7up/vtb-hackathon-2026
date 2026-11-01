import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(), login: text('login').notNull().unique(),
  role: text('role').notNull(), name: text('name').notNull(), clientId: text('client_id'),
  passwordHash: text('password_hash').notNull(), passwordSalt: text('password_salt').notNull(),
});
export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(), accountId: text('account_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
export const bankState = sqliteTable('bank_state', {
  id: text('id').primaryKey(), revision: integer('revision').notNull().default(0), data: text('data').notNull(),
});
export const registry = sqliteTable('registry', {
  recipientId: text('recipient_id').primaryKey(), displayName: text('display_name').notNull(),
  reason: text('reason').notNull(), reasonCode: text('reason_code').notNull(),
  status: text('status').notNull(), source: text('source').notNull(),
});
export const loginLimits = sqliteTable('login_limits', {
  key: text('key').primaryKey(), attempts: integer('attempts').notNull().default(0),
  windowStart: integer('window_start').notNull(),
});
export const complaintIndex = sqliteTable('complaint_index', {
  reportId: text('report_id').primaryKey(), clientId: text('client_id').notNull(),
  recipientId: text('recipient_id').notNull(), recipientName: text('recipient_name').notNull(),
  status: text('status').notNull(), updatedAt: integer('updated_at').notNull(),
});
export const registryVersion = sqliteTable('registry_version', {
  id: text('id').primaryKey(), revision: integer('revision').notNull().default(0),
});

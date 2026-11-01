// Global index contains routing/status metadata only. Narrative and AI dialogue stay in the owner's state.
export const complaintSource = 'synthetic_complaint_review';
export async function registryRevision(db) {
  return (await db.prepare("SELECT revision FROM registry_version WHERE id = 'global'").first()).revision;
}
export function stateGuard(clientId, revision, globalRevision) {
  return {
    sql: "EXISTS (SELECT 1 FROM bank_state WHERE id = ? AND revision = ?) AND EXISTS (SELECT 1 FROM registry_version WHERE id = 'global' AND revision = ?)",
    args: [clientId, revision, globalRevision],
  };
}
export function indexReportsStatements(db, state, clientId, guard) {
  const rows = (state.fraudReports || []).filter(r => r.status !== 'draft').map(r => ({
    id: r.id, recipientId: r.recipientId, recipientName: r.recipientName, status: r.status, updatedAt: r.updatedAt,
  }));
  return [
    db.prepare(`DELETE FROM complaint_index WHERE client_id = ? AND ${guard.sql}`).bind(clientId, ...guard.args),
    db.prepare(`INSERT INTO complaint_index (report_id, client_id, recipient_id, recipient_name, status, updated_at)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.recipientId'), json_extract(value, '$.recipientName'),
        json_extract(value, '$.status'), json_extract(value, '$.updatedAt') FROM json_each(?) WHERE ${guard.sql}`)
      .bind(clientId, JSON.stringify(rows), ...guard.args),
  ];
}
export function reconcileRecipientStatement(db, recipientId, recipientName, guard) {
  // Executed after index updates in the same transaction: another client's reviewed case cannot be lost.
  return db.prepare(`INSERT INTO registry (recipient_id, display_name, reason, reason_code, status, source)
    SELECT ?, ?, 'Рассмотренных обращений: ' || COUNT(*) || '. Ограничение установлено сотрудником.',
      CASE WHEN SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) > 0 THEN 'DEMO_COMPLAINT_BLOCK' ELSE 'DEMO_COMPLAINT_WATCH' END,
      CASE WHEN SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) > 0 THEN 'active' WHEN COUNT(*) > 0 THEN 'watch' ELSE 'inactive' END,
      'synthetic_complaint_review'
    FROM complaint_index WHERE recipient_id = ? AND status IN ('watch','blocked')
    HAVING ${guard.sql} AND (COUNT(*) > 0 OR EXISTS (SELECT 1 FROM registry WHERE recipient_id = ? AND source = 'synthetic_complaint_review'))
    ON CONFLICT(recipient_id) DO UPDATE SET display_name = excluded.display_name, reason = excluded.reason,
      reason_code = excluded.reason_code, status = excluded.status WHERE registry.source = 'synthetic_complaint_review'`)
    .bind(recipientId, recipientName, recipientId, ...guard.args, recipientId);
}
export async function riskSummaries(db) {
  const { results } = await db.prepare(`SELECT i.recipient_id AS recipientId,
    COUNT(CASE WHEN i.status IN ('submitted','watch','blocked') THEN 1 END) AS reportCount,
    COUNT(DISTINCT CASE WHEN i.status IN ('submitted','watch','blocked') THEN i.client_id END) AS uniqueReporters,
    SUM(CASE WHEN i.status = 'submitted' THEN 1 ELSE 0 END) AS submittedCount,
    SUM(CASE WHEN i.status = 'watch' THEN 1 ELSE 0 END) AS watchCount,
    SUM(CASE WHEN i.status = 'blocked' THEN 1 ELSE 0 END) AS blockCount,
    SUM(CASE WHEN i.status = 'dismissed' THEN 1 ELSE 0 END) AS dismissedCount,
    COALESCE(r.status, 'none') AS status, r.source AS source
    FROM complaint_index i LEFT JOIN registry r ON r.recipient_id = i.recipient_id GROUP BY i.recipient_id`).all();
  return results.map(row => ({ ...row, status: ['watch', 'active'].includes(row.status) ? row.status : 'none' }));
}

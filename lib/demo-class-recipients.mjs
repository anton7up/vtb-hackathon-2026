// Fixed synthetic fixtures, not fraud predictions or real bank recipients.
export const DEMO_CLASS_RECIPIENTS = Object.freeze([
  { id: 'DEMO-CLASS-NORMAL', name: 'Тест · Нормальный перевод', bank: 'Демо банк', initials: 'Н', demoClass: 'normal' },
  { id: 'DEMO-CLASS-REVIEW', name: 'Тест · Нужно проверить · ИИ-помощник', bank: 'Демо банк', initials: 'П', demoClass: 'review' },
  { id: 'DEMO-CLASS-BLOCK', name: 'Тест · Блокировка перевода', bank: 'Демо банк', initials: 'Б', demoClass: 'block' },
]);
export function demoRecipientClass(id) { return DEMO_CLASS_RECIPIENTS.find(r => r.id === id)?.demoClass ?? null; }

export function ensureDemoRecipientHistory(state, now) {
  // Explicit demo history makes fixtures usable during a hold without bypassing the policy.
  const anchor = Math.min(now, state.lastCriticalChange ?? now, ...state.operations.filter(o => o.seeded).map(o => o.createdAt));
  for (const r of DEMO_CLASS_RECIPIENTS) {
    const id = `HISTORY-${r.id}`;
    if (state.operations.some(o => o.id === id)) continue;
    state.operations.push({ id, kind: 'transfer', recipientId: r.id, recipientName: r.name, amount: 10000, createdAt: anchor - 86400000, status: 'completed', code: 'COMPLETED', reason: 'Вымышленная демо-история для проверки классов. Не списывает деньги с текущего баланса.', seeded: true });
  }
  return state;
}

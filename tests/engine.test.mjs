import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, initialState, protectionOf, isKnown, parseAmount, changeAccess, attempt, confirmOperation, openTicket, replyToTicket, addRegistryEntry } from '../lib/bank-engine.mjs';
const t = Date.parse('2026-10-28T09:00:00Z');
const transfer = (id = 'DEMO-NEW-001', amount = 100000) => ({ kind: 'transfer', recipientId: id, recipientName: 'Получатель', amount });
const risky = [{ recipient_id: 'DEMO-RISK-002', status: 'active', reason: 'Демо-фишинг', reason_code: 'TEST' }];
test('no pause initially; cash and transfers require confirmation without immediate debit', () => {
  const s = initialState(t), balance = s.balance;
  assert.equal(protectionOf(s, t).active, false);
  assert.equal(attempt(s, transfer(), [], t).decision.allowed, true);
  assert.equal(attempt(s, { kind: 'cash', amount: 100000 }, [], t).decision.allowed, true);
  assert.equal(s.balance, balance);
  assert.equal(s.operations.length, 3);
});
test('phone change blocks new recipient without debit', () => {
  const s = initialState(t), balance = s.balance;
  changeAccess(s, 'phone', t, '+7 000 000-00-02');
  const r = attempt(s, transfer(), [], t + 1);
  assert.equal(r.decision.code, 'NEW_RECIPIENT_HOLD');
  assert.equal(r.operation.status, 'blocked');
  assert.equal(s.balance, balance);
});
test('known recipient remains available while pause active', () => {
  const s = initialState(t); changeAccess(s, 'recovery', t);
  const r = confirmOperation(s, { ...transfer('DEMO-FAMILY-001'), requestId: 'a' }, [], t + 1);
  assert.equal(r.operation.status, 'completed');
  assert.equal(s.balance, 24830000 - 100000);
});
test('cash blocked during pause and available exactly at expiry', () => {
  const s = initialState(t); changeAccess(s, 'recovery', t);
  assert.equal(attempt(s, { kind: 'cash', amount: 100000 }, [], t + DAY - 1).decision.code, 'CASH_HOLD');
  assert.equal(attempt(s, { kind: 'cash', amount: 100000 }, [], t + DAY).decision.allowed, true);
});
test('known risky recipient blocked regardless of pause or expiry', () => {
  const s = initialState(t); changeAccess(s, 'recovery', t);
  for (const at of [t + 1, t + DAY]) {
    const r = attempt(s, transfer('DEMO-RISK-002'), risky, at);
    assert.equal(r.decision.known, true);
    assert.equal(r.decision.code, 'RISK_REGISTRY');
  }
});
test('missing registry keeps transfer pending and balance unchanged', () => {
  const s = initialState(t); const r = attempt(s, transfer('DEMO-FAMILY-001'), null, t);
  assert.equal(r.operation.status, 'pending');
  assert.equal(r.decision.code, 'REGISTRY_UNAVAILABLE');
  assert.equal(s.balance, 24830000);
});
test('expiry never auto executes blocked operations', () => {
  const s = initialState(t); changeAccess(s, 'recovery', t);
  attempt(s, transfer(), [], t + 1);
  assert.equal(protectionOf(s, t + DAY).active, false);
  assert.equal(s.operations[0].status, 'blocked');
  assert.equal(s.balance, 24830000);
});
test('second access change restarts full pause', () => {
  const s = initialState(t); changeAccess(s, 'recovery', t); changeAccess(s, 'phone', t + DAY / 2, '+7 000 000-00-02');
  assert.equal(protectionOf(s, t + DAY).active, true);
  assert.equal(protectionOf(s, t + DAY).remainingMs, DAY / 2);
});
test('stopped attempt does not turn new recipient into known recipient', () => {
  const s = initialState(t); changeAccess(s, 'recovery', t);
  attempt(s, transfer(), [], t + 1);
  assert.equal(isKnown(s, 'DEMO-NEW-001', t + 2), false);
});
test('confirmation rechecks newly triggered pause', () => {
  const s = initialState(t);
  assert.equal(attempt(s, transfer(), [], t).decision.allowed, true);
  changeAccess(s, 'recovery', t + 1);
  const r = confirmOperation(s, { ...transfer(), requestId: 'b' }, [], t + 2);
  assert.equal(r.decision.code, 'NEW_RECIPIENT_HOLD');
  assert.equal(s.balance, 24830000);
});
test('confirmation rechecks newly registered recipient', () => {
  const s = initialState(t); attempt(s, transfer(), [], t);
  const r = confirmOperation(s, { ...transfer(), requestId: 'c' }, [{ ...risky[0], recipient_id: 'DEMO-NEW-001' }], t + 1);
  assert.equal(r.decision.code, 'RISK_REGISTRY');
  assert.equal(s.balance, 24830000);
});
test('duplicate confirmation never debits twice', () => {
  const s = initialState(t), request = { ...transfer(), requestId: 'same' };
  confirmOperation(s, request, [], t); const r = confirmOperation(s, request, [], t + 1);
  assert.equal(r.duplicate, true);
  assert.equal(s.balance, 24730000);
  assert.equal(s.operations.filter(x => x.requestId === 'same').length, 1);
});
test('amount parser rejects invalid amounts and supports rubles with kopecks', () => {
  for (const input of ['-1', '0', 'NaN', '1e5', '1.001', '', '999999999999999999']) assert.equal(parseAmount(input), null);
  assert.equal(parseAmount('3 000,45'), 300045);
});
test('insufficient funds never create successful operation', () => {
  const s = initialState(t); const r = confirmOperation(s, { ...transfer('DEMO-FAMILY-001', 99999999), requestId: 'd' }, [], t);
  assert.equal(r.decision.code, 'INSUFFICIENT_FUNDS'); assert.equal(s.balance, 24830000);
});
test('employee reply visible on ticket but cannot lift hold', () => {
  const s = initialState(t); changeAccess(s, 'recovery', t);
  const op = attempt(s, transfer(), [], t + 1).operation;
  const ticket = openTicket(s, op.id, t + 2);
  assert.equal(openTicket(s, op.id, t + 3).id, ticket.id);
  replyToTicket(s, ticket.id, 'Пауза действует до завтра.', t + 4);
  assert.equal(ticket.status, 'answered');
  assert.equal(protectionOf(s, t + 5).active, true);
  assert.equal(op.status, 'blocked');
});
test('employee registry insertion blocks earlier safe recipient; duplicate rejected', () => {
  const s = initialState(t); const entry = { recipient_id: 'DEMO-FAMILY-001', display_name: 'Мама', reason: 'Демонстрационный сигнал' };
  addRegistryEntry(s, entry, risky, t);
  const combined = [...risky, ...s.registryAdditions];
  assert.equal(attempt(s, transfer('DEMO-FAMILY-001'), combined, t + 1).decision.code, 'RISK_REGISTRY');
  assert.throws(() => addRegistryEntry(s, entry, combined, t + 1));
});
test('same display name with other ID never inherits known status', () => {
  const s = initialState(t); changeAccess(s, 'recovery', t);
  assert.equal(attempt(s, { ...transfer('DEMO-FAKE-MOM'), recipientName: 'Мама' }, [], t + 1).decision.code, 'NEW_RECIPIENT_HOLD');
});
test('successful transfer after expiry becomes known for next change', () => {
  const s = initialState(t); changeAccess(s, 'recovery', t);
  confirmOperation(s, { ...transfer(), requestId: 'after-expiry' }, [], t + DAY);
  assert.equal(isKnown(s, 'DEMO-NEW-001', t + DAY + 1), true);
  changeAccess(s, 'recovery', t + DAY + 2);
  assert.equal(attempt(s, transfer(), [], t + DAY + 3).decision.allowed, true);
});

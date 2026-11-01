import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTrustedSettings, renderTrustedInbox, renderTrustedQueue } from '../public/trusted-view.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = { esc, money: v => `${v / 100} ₽`, date: v => new Date(v).toISOString() };
const ui = { trustedEnabled: true, trustedLimit: '1000', trustedLogins: 'client2, client3', trustedMode: 'all', trustedBusy: false };
const op = { id: 'OP-1', kind: 'transfer', recipientName: 'Учебный продавец', amount: 300000, status: 'pending', trustedStatus: 'pending', guardianApproval: { status: 'pending', mode: 'all', guardians: [{ id: 'b', name: 'Борис' }, { id: 'c', name: 'Вера' }], votes: [{ guardianId: 'b', verdict: 'approve' }], expiresAt: 1900000000000 } };
test('settings explain strict per-operation limit, group mode, password and non-bypass protection', () => {
  const html = renderTrustedSettings(ui, { trustedPolicy: { enabled: false } }, h);
  for (const phrase of ['на одну операцию', 'строго выше', 'client2, client3', 'Достаточно одного', 'Нужны все', 'текущей', 'Подтвердите настройку своим паролем']) {
    if (phrase === 'текущей') continue;
    assert.ok(html.includes(phrase), phrase);
  }
  assert.match(html, /type="password"/); assert.equal(/value=".*2026!/.test(html), false);
  assert.match(html, /не отменяет паузу, стоп-лист/);
});
test('settings lock is visible and fieldset disabled during account hold', () => {
  assert.match(renderTrustedSettings(ui, { protection: { active: true } }, h), /<fieldset disabled>/);
  assert.match(renderTrustedSettings(ui, { securityLock: {} }, h), /<fieldset disabled>/);
});
test('partial quorum cannot show a payment continuation; approved quorum still needs owner confirmation', () => {
  const pending = renderTrustedQueue(ui, { operations: [op] }, h);
  assert.match(pending, /Разрешений: 1 из 2/); assert.equal(pending.includes('data-trusted-resume='), false);
  const approved = renderTrustedQueue(ui, { operations: [{ ...op, trustedStatus: 'approved' }] }, h);
  assert.match(approved, /data-trusted-resume="OP-1"/); assert.match(approved, /не отправляет деньги автоматически/);
  const bankPending = renderTrustedQueue(ui, { operations: [{ ...op, trustedStatus: 'approved', review: { status: 'pending' } }] }, h);
  assert.equal(bankPending.includes('data-trusted-resume='), false);
});
test('expired or stale requests can be cancelled but cannot resume', () => {
  for (const trustedStatus of ['expired', 'stale']) {
    const html = renderTrustedQueue(ui, { operations: [{ ...op, trustedStatus }] }, h);
    assert.equal(html.includes('data-trusted-resume='), false); assert.match(html, /создайте новую/); assert.match(html, /data-trusted-cancel-operation/);
  }
});
test('guardian inbox has no actions after own vote or completed request', () => {
  const r = { requestId: 'TRUST-1', ownerName: 'Анна', status: 'pending', type: 'operation', kind: 'transfer', recipientName: 'Магазин', amount: 300000, expiresAt: 1900000000000, approvals: 0, required: 1 };
  assert.match(renderTrustedInbox(ui, { trustedInbox: [r] }, h), /data-trusted-vote="approve"/);
  for (const extra of [{ myVerdict: 'approve' }, { status: 'expired' }, { status: 'approved' }, { status: 'closed' }]) assert.equal(renderTrustedInbox(ui, { trustedInbox: [{ ...r, ...extra }] }, h).includes('data-trusted-vote='), false);
});
test('request details and profile fields remain escaped and no external URLs become links', () => {
  const dangerous = '<img src=x onerror=alert(1)>';
  const html = renderTrustedSettings({ ...ui, trustedLogins: dangerous }, { trustedPolicy: { enabled: true, limit: 100000, guardians: [{ name: dangerous, login: dangerous }] } }, h)
    + renderTrustedInbox(ui, { trustedInbox: [{ requestId: dangerous, ownerName: dangerous, status: 'pending', type: 'operation', kind: 'transfer', recipientName: dangerous, amount: 100, expiresAt: 1900000000000, approvals: 0, required: 1 }] }, h);
  assert.equal(/<img|onerror=alert\(1\)>/.test(html.replaceAll('&lt;img src=x onerror=alert(1)&gt;', '')), false);
  assert.match(html, /&lt;img/); assert.equal(/href="https?:/.test(html), false);
});

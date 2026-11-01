const labels = { pending: 'Сотрудник проверяет запрос', approved: 'Можно завершить восстановление', rejected: 'Запрос отклонён', expired: 'Срок запроса истёк', stale: 'Условия изменились', completed: 'Учебное восстановление завершено' };
const message = '<p class="aside-note">Учебный сценарий для хакатона, а не реальная проверка личности. В настоящем банке потребуется независимое подтверждение. Восстановление не переводит деньги и не отменяет остальные проверки.</p>';
export function renderRecoveryOwner(ui, state, { esc, date }) {
  const r = state.securityRecovery || {};
  if (!state.securityLock && r.status !== 'completed') return '';
  const busy = ui.recoveryBusy ? 'disabled' : '';
  const request = r.request;
  return `<section class="panel recovery-panel"><h2>${state.securityLock ? 'Восстановление после тревоги' : 'Доступ восстановлен'}</h2>
    <p>${state.securityLock ? 'После сообщения «Это был не я» все переводы и снятие наличных остаются заблокированы. Восстановление доступно только из той же старой сессии.' : 'История, обращения и настройки защиты сохранены.'}</p>
    ${request ? `<p class="notice warning"><b>${esc(labels[r.status] || r.status)}</b>${['pending', 'approved'].includes(r.status) ? `<br>Запрос действует до ${esc(date(request.expiresAt))} МСК.` : ''}</p>${request.review ? `<p>Комментарий сотрудника: ${esc(request.review.comment)}</p>` : ''}` : ''}
    ${r.reason ? `<p class="notice warning">${esc(r.reason)}</p>` : ''}
    ${r.canRequest || r.canComplete ? `<form id="security-recovery-form" data-recovery-step="${r.canComplete ? 'complete' : 'request'}" data-recovery-request="${esc(request?.id || '')}"><label class="field-label" for="security-recovery-password">Подтвердите своим паролем</label><input id="security-recovery-password" type="password" autocomplete="current-password" maxlength="200" required ${busy}>
      ${r.canComplete ? '<label class="field-label" for="security-recovery-new-password">Новый пароль, не менее 12 символов</label><input id="security-recovery-new-password" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="200" required ' + busy + '><label class="field-label" for="security-recovery-repeat-password">Повторите новый пароль</label><input id="security-recovery-repeat-password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required ' + busy + '><p class="field-help">Новый пароль должен отличаться от прежнего. Он не сохраняется в диалоге или истории операций.</p><p class="notice warning">Все сессии, включая эту, будут завершены. Войдите заново с новым паролем. Незавершённые переводы будут отменены, оставшаяся 24-часовая пауза сохранится.</p>' : '<p class="field-help">Сначала сотрудник рассмотрит запрос. Его разрешение само по себе не снимет блокировку.</p>'}
      <button type="submit" class="button" ${busy}>${ui.recoveryBusy ? 'Подождите…' : r.canComplete ? 'Завершить восстановление и выйти' : 'Запросить учебное восстановление'}</button></form>` : ''}
    ${ui.recoveryError ? `<p class="dialog-error" role="alert">${esc(ui.recoveryError)}</p>` : ''}${message}</section>`;
}
export function renderRecoveryStaff(ui, state, { esc, date }) {
  const r = state.securityRecovery || {};
  if (!state.securityLock && !r.request) return '';
  const request = r.request;
  const busy = ui.recoveryBusy ? 'disabled' : '';
  return `<section class="panel recovery-panel"><h2>Учебное восстановление доступа</h2>${message}
    ${request ? `<p class="notice warning"><b>${esc(labels[r.status] || r.status)}</b> · до ${esc(date(request.expiresAt))} МСК.</p>${request.review ? `<p>Решение: ${esc(request.review.comment)}</p>` : ''}` : `<p class="notice warning">Клиент ещё не запросил восстановление из прежней сессии.${r.continuityAvailable === false ? ' У блокировки нет доказательства прежней сессии: используйте независимый канал банка; в прототипе он не реализован.' : ''} Сотрудник не может просто снять блокировку.</p>`}
    ${r.canReview ? `<form id="security-recovery-review-form" data-recovery-request="${esc(request.id)}"><fieldset ${busy}><legend>Смоделируйте независимую проверку</legend>
      <label><input type="checkbox" name="knownChannel"> Учебно подтверждён контакт через ранее известный канал, не через новые реквизиты</label>
      <label><input type="checkbox" name="incidentReviewed"> Разобраны чужой вход или смена данных и объяснение клиента</label>
      <label><input type="checkbox" name="accessSecured"> Учебно проверено прекращение чужого доступа; при завершении будут отозваны все сессии</label>
      <label class="field-label" for="security-recovery-comment">Результат учебной проверки</label><textarea id="security-recovery-comment" name="comment" minlength="10" maxlength="1000" required placeholder="Опишите, что проверили. Не вводите документы, пароли и SMS-коды."></textarea>
      <div class="recovery-actions"><button class="button" type="submit" name="verdict" value="approve">Разрешить подтверждение клиентом</button><button class="button danger" type="submit" name="verdict" value="reject">Отклонить запрос</button></div></fieldset></form><p class="field-help">Разрешение не снимает блокировку. Клиент должен завершить сценарий из прежней сессии с паролем в пределах срока запроса.</p>` : ''}
    ${ui.recoveryError ? `<p class="dialog-error" role="alert">${esc(ui.recoveryError)}</p>` : ''}</section>`;
}

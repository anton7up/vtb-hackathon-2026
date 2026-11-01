const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(content, script) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>АнтиСкам — защита ваших денег</title><link rel="icon" href="/shield.svg"><link rel="stylesheet" href="/shell.css"></head><body>${content}<script type="module" src="/${script}"></script></body></html>`;
}

// This thin HTML shell uses the same public/app.mjs, styles and bank API as Sites.
// No React/Cloudflare runtime or build is needed for the standalone server.
export function loginPage() {
  return page(`<main class="login-page">
    <section class="login-intro">
      <a class="brand" href="/login"><img src="/shield.svg" width="38" height="38" alt=""><span>АнтиСкам<span class="brand-sub">Деньги под защитой</span></span></a>
      <div class="login-message"><span class="eyebrow">БЕЗОПАСНОСТЬ НА КАЖДОМ ШАГЕ</span><h1>Ваши деньги.<br>Под вашей защитой.</h1><p>Переводы, которые вы контролируете.<br>Поддержка банка, когда она нужна.</p><div class="login-shield"><img src="/shield.svg" width="95" height="95" alt=""><span>Проверка получателей</span><span>Защитная пауза</span><span>Помощь банка</span></div></div>
      <small>Демонстрационный продукт для хакатона</small>
    </section>
    <section class="login-area"><div class="login-card"><span class="eyebrow">ДОБРО ПОЖАЛОВАТЬ</span><h2>Вход в аккаунт</h2><p>Введите логин и пароль. Откроется кабинет, доступный вашему аккаунту.</p>
      <form id="login-form" method="post" action="/api/auth/login"><label class="field-label" for="login">Логин</label><input id="login" name="username" autocomplete="username" required maxlength="80" autocapitalize="none" placeholder="Введите логин">
      <label class="field-label" for="password">Пароль</label><div class="password-field"><input id="password" type="password" name="password" autocomplete="current-password" required maxlength="200" placeholder="Введите пароль"><button type="button" id="toggle-password" aria-label="Показать пароль">Показать</button></div><p class="dialog-error" id="login-error" role="alert"></p><button type="submit" id="login-submit" class="button full" disabled>Войти в аккаунт →</button></form><noscript>Для входа включите JavaScript в браузере.</noscript>
      <div class="login-hint">Кабинеты клиента и сотрудника разделены. Роль назначается аккаунту при создании.</div></div><p class="login-footnote">Учебная среда · реальные банковские данные не используются</p></section>
  </main>`, 'login.mjs');
}

export function dashboardPage(user) {
  const staff = user.role === 'employee';
  return page(`<header class="topbar"><a class="brand" href="/"><img src="/shield.svg" width="35" height="35" alt=""><span>АнтиСкам<span class="brand-sub">Деньги под защитой</span></span></a><span class="account-badge ${staff ? 'staff' : ''}">${staff ? 'Сотрудник банка' : 'Кабинет клиента'}</span><div class="top-meta"><span class="login-name">${escape(user.login)}</span><button type="button" class="button subtle small" id="logout" disabled>Выйти</button></div></header>
    <div class="app-shell"><aside class="sidebar"><p class="nav-label" id="nav-caption">${staff ? 'РАБОЧЕЕ МЕСТО' : 'МОЙ БАНК'}</p><nav id="navigation" aria-label="Разделы кабинета"></nav><div class="sidebar-bottom"><span class="live-dot"></span><b>Защита активна</b><p>Проверка каждой операции</p><span class="version">Хакатон · локальная система</span></div></aside><main>
      <div class="page-heading"><div><span class="eyebrow" id="eyebrow"></span><h1 id="page-title">${staff ? 'Контроль операций' : 'Переводы и наличные'}</h1><p id="page-description"></p></div><div class="profile"><span class="user-icon">${staff ? 'СБ' : 'АК'}</span><div><b id="profile-name">${escape(user.name)}</b><small id="profile-description"></small></div></div></div>
      ${staff ? '<section class="demo-tools" aria-label="Управление демонстрацией"><span class="tools-label">Демонстрация</span><button type="button" id="demo-forward">Перемотать 24 часа</button><button type="button" id="demo-reset" class="text-button">Начать заново</button><span id="demo-clock"></span></section>' : ''}
      <div id="connection-notice" class="notice warning" hidden>Не удалось обновить данные. Проверьте соединение.</div><section class="protection-banner" id="protection-banner" aria-label="Статус защитной паузы"></section><section id="security-alerts" aria-label="Предупреждения безопасности" aria-live="polite" hidden></section><div id="workspace"><p class="empty">Загружаем данные аккаунта…</p></div>
      <footer>Учебный прототип. Деньги, получатели и банковский реестр вымышлены. Список ЦБ — отдельный открытый источник. 24 часа — правило демо.<span>Вы вошли как ${staff ? 'сотрудник банка' : 'клиент'}. Доступ к данным проверяется сервером.</span></footer></main></div>
    <dialog id="dialog" aria-labelledby="dialog-title"><div id="dialog-content"></div></dialog><div id="toast" class="toast" role="status" aria-live="polite"></div>`, 'app.mjs');
}

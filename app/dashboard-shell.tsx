import Script from 'next/script';
export default function DashboardShell({ user }: { user: { role: string; name: string; login: string } }) {
  const employee = user.role === 'employee';
  return <>
    <header className="topbar">
      <a className="brand" href="/"><img src="/shield.svg" width="35" height="35" alt="" /><span>АнтиСкам<span className="brand-sub">Деньги под защитой</span></span></a>
      <span className={`account-badge ${employee ? 'staff' : ''}`}>{employee ? 'Сотрудник банка' : 'Кабинет клиента'}</span>
      <div className="top-meta"><span className="login-name">{user.login}</span><button type="button" className="button subtle small" id="logout" disabled>Выйти</button></div>
    </header>
    <div className="app-shell">
      <aside className="sidebar"><p className="nav-label" id="nav-caption">{employee ? 'РАБОЧЕЕ МЕСТО' : 'МОЙ БАНК'}</p><nav id="navigation" aria-label="Разделы кабинета"></nav><div className="sidebar-bottom"><span className="live-dot"></span><b>Защита активна</b><p>Проверка каждой операции</p><span className="version">Хакатон · прототип 03</span></div></aside>
      <main>
        <div className="page-heading"><div><span className="eyebrow" id="eyebrow"></span><h1 id="page-title">{employee ? 'Контроль операций' : 'Переводы и наличные'}</h1><p id="page-description"></p></div><div className="profile"><span className="user-icon">{employee ? 'СБ' : 'АК'}</span><div><b id="profile-name">{user.name}</b><small id="profile-description"></small></div></div></div>
        {employee && <section className="demo-tools" aria-label="Управление демонстрацией"><span className="tools-label">Демонстрация</span><button type="button" id="demo-forward">Перемотать 24 часа</button><button type="button" id="demo-reset" className="text-button">Начать заново</button><span id="demo-clock"></span></section>}
        <div id="connection-notice" className="notice warning" hidden>Не удалось обновить данные. Проверьте соединение.</div>
        <section className="protection-banner" id="protection-banner" aria-label="Статус защитной паузы"></section>
        <div id="workspace"><p className="empty">Загружаем данные аккаунта…</p></div>
        <footer>Учебный прототип. Деньги, получатели и реестр вымышлены. 24 часа — правило демо.<span>Вы вошли как {employee ? 'сотрудник банка' : 'клиент'}. Доступ к данным проверяется сервером.</span></footer>
      </main>
    </div>
    <dialog id="dialog" aria-labelledby="dialog-title"><div id="dialog-content"></div></dialog>
    <div id="toast" className="toast" role="status" aria-live="polite"></div>
    <Script src="/app.mjs" type="module" strategy="afterInteractive" />
  </>;
}

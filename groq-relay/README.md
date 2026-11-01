# Groq relay

Минимальный stateless-шлюз для случаев, когда основной сервер не может напрямую обращаться к Groq. База данных и пользовательские сессии через него не проходят.

Обязательные секреты окружения:

- `GROQ_API_KEY` — ключ Groq, хранится только в секретах платформы;
- `RELAY_TOKEN` — отдельная случайная строка не короче 32 байт, общая для шлюза и основного сервера.

Сервис принимает запросы только с заголовком `X-VTB-Relay-Token` и ограничивает размеры запроса и ответа. Доступны два варианта развёртывания из рабочей папки `groq-relay`:

- обычный Node-сервис: `npm start`, маршрут `POST /openai/v1/chat/completions`, health check `/healthz`;
- Vercel Function: маршрут `POST /api/groq`, а `GET /api/groq` служит health check. Регион функции зафиксирован в США (`iad1`).

На основном сервере задайте:

```dotenv
GROQ_API_URL=https://your-relay.example/api/groq
GROQ_RELAY_TOKEN=the-same-independent-random-token
```

Не помещайте реальные значения секретов в Git, логи или клиентский код.


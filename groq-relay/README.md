# Groq relay

Минимальный stateless-шлюз для случаев, когда основной сервер не может напрямую обращаться к Groq. База данных и пользовательские сессии через него не проходят.

Обязательные секреты окружения:

- `GROQ_API_KEY` — ключ Groq, хранится только в секретах платформы;
- `RELAY_TOKEN` — отдельная случайная строка не короче 32 байт, общая для шлюза и основного сервера.

Сервис принимает только `POST /openai/v1/chat/completions` с заголовком `X-VTB-Relay-Token`, ограничивает размеры запроса и ответа и предоставляет `GET /healthz`. Для Koyeb укажите рабочую папку `groq-relay`, команду запуска `npm start` и health check `/healthz`.

На основном сервере задайте:

```dotenv
GROQ_API_URL=https://your-relay.example/openai/v1/chat/completions
GROQ_RELAY_TOKEN=the-same-independent-random-token
```

Не помещайте реальные значения секретов в Git, логи или клиентский код.


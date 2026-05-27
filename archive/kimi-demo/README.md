# Telegram Sender Pro (копия с kimi.page)

Полная офлайн-копия сайта https://te5t6ujf3uh6m.kimi.page

## Файлы

```
kimi-original/
├── index.html
├── kimi-sdk-seed.js
├── assets/
│   ├── index-BZVW1ZZm.js   # React-приложение (~761 KB)
│   └── index-CNrvukqR.css  # стили (~87 KB)
└── README.md
```

> Это **демо-версия** с мок-данными внутри JS — кнопки не отправляют в Telegram.

> **Рабочая панель** с API: `./run-web.sh` → http://localhost:8000

## Открыть демо (только внешний вид)

```bash
./open-kimi-demo.sh
```

Откроется: http://localhost:5500

Или вручную:

```bash
cd web/kimi-original
python3 -m http.server 5500
```

**Не открывайте `index.html` двойным кликом** — ES-модули не работают через `file://`, нужен HTTP-сервер.

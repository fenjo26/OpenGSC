# N11 — Браузерное расширение (Chrome / Edge, MV3)

**Ветка:** `feat/wave-nov-n11`. **Владение:** `extension/**`, `src/app/api/ext/**`, `src/lib/ext/**`,
`src/components/ExtensionTokenCard.tsx`, `docs/EXTENSION.md`.

## Зачем
Работаешь в чужом инструменте или просто на странице сайта — одной кнопкой видишь, что о ней
знает OpenGSC, и отправляешь в него данные. MCP закрывает это для агентов, расширение — для
человека в браузере.

## Что умеет (v1)
Popup на текущей вкладке:
1. **Эта страница в OpenGSC**: если URL принадлежит сайту портфеля — клики/показы/позиция за
   28 дней, главные запросы, статус индекса (из `SitemapUrl` / `PageInspection`), проблемы
   последнего аудита для этого URL, позиции отслеживаемых ключей, где он ранжируется. Ссылка
   «открыть в OpenGSC».
2. **Мини-аудит страницы** — считается **в самом расширении** по DOM текущей вкладки (content
   script): title/description с длинами из тех же границ (`META_LIMITS` скопировать в
   расширение константами, с комментарием-ссылкой на источник), H1, canonical, robots,
   hreflang, JSON-LD (валидный JSON?), OG, количество ссылок, изображения без alt. Ничего не
   отправляет на сервер.
3. **«Отправить в OpenGSC»** (контекстное меню и кнопка):
   - URL своего сайта → в приоритет автопроверки индексации (октябрь, T4): `googleNextCheck`
     сбрасывается в «сейчас», URL проверится в ближайшем тике. URL чужого сайта → в Outreach
     как проспект;
   - выделенный текст → в SEO Tools как ключи (открыть `/demand` или `/seo-tools/outline` с ключом);
   - таблица на странице (выделение внутри `<table>`) → CSV-файл для импорта (скачивание),
     без автоматического импорта в чужие модули.
4. На `search.google.com/search-console` и `pagespeed.web.dev` — только кнопка «открыть этот
   URL в OpenGSC». **Не** парсим интерфейс чужих сервисов: он меняется без предупреждения,
   а данные GSC у нас и так есть через API.

## Сервер — `/api/ext/**` (Bearer `User.extToken`)
- Токен выпускается в Settings (`ExtensionTokenCard`): сгенерировать / перевыпустить / отозвать.
  В базе — сам токен (`@unique`, как `mcpToken`; сверка постоянным временем). Действия
  расширения выполняются от имени владельца токена с его правами (`workspaceUserId`-логика для
  токена — посмотри, как MCP-маршрут превращает `mcpToken` в пользователя, и повтори).
- `GET /api/ext/page?url=` — сводка по URL (п. 1). Один запрос, только локальные данные.
- `POST /api/ext/index-queue` `{ url }` — URL своего сайта → в приоритет автопроверки.
- `POST /api/ext/outreach` `{ url, note }` — проспект в Outreach (тот же сервис, что MCP
  `save_outreach_prospect`).
- CORS: `Access-Control-Allow-Origin` только для `chrome-extension://<id>` из
  `User.extAllowedIds` (id расширения виден после установки; поле в карточке).
  Без токена — 401, без совпадения origin — 403.
- Rate limit 60 запросов в минуту на токен.

## Расширение — `extension/`
- MV3: `manifest.json`, `background.js` (service worker: контекстное меню, вызовы API),
  `popup.html` + `popup.js`, `content.js` (мини-аудит по DOM), `options.html` (URL инстанса и
  токен; хранение — `chrome.storage.local`). Без сборщика и зависимостей, чистый JS.
- `host_permissions`: только URL инстанса, который ввёл пользователь (опциональные
  разрешения, запрашиваются при сохранении настроек); `activeTab`, `contextMenus`, `storage`.
  Никакого `<all_urls>`.
- Стиль popup — те же цвета, что в приложении (токены переписать в CSS расширения).
- Язык — `chrome.i18n` с `_locales/{en,ru}` (остальные языки расширения — позже; в
  приложении локали обычные, через N0).
- `npm run ext:zip` не добавляй (`package.json` не твой) — в доке команда `cd extension && zip -r ../opengsc-extension.zip .`.

## Дока — `docs/EXTENSION.md`
Установка «Загрузить распакованное» (chrome://extensions → Режим разработчика), настройка URL и
токена, id расширения для CORS, что расширение отправляет на сервер (только то, что нажали) и
что считает локально.

## Тесты — `src/lib/ext/*.test.ts`
Сводка по URL: нормализация URL, сопоставление с сайтом портфеля (sc-domain и URL-ресурс),
чужой URL → `{ inPortfolio: false }`; проверка токена (нет / неверный / отозван); CORS-решение по
origin; rate limit. Чистую логику мини-аудита вынеси в `extension/lib/audit.js` и покрой тестом
на JSDOM-фикстуре, **если** `jsdom` уже есть в `node_modules`; если нет — не добавляй
зависимость, проверь вручную и напиши в отчёте.

## i18n (N0 создаёт; это ключи приложения, не расширения)
| ключ | en | ru |
|---|---|---|
| `extTitle` | Browser extension | Браузерное расширение |
| `extHint` | Chrome/Edge extension: page summary, quick audit, "Send to OpenGSC". | Расширение для Chrome/Edge: сводка по странице, быстрый аудит, «Отправить в OpenGSC». |
| `extToken` | Extension token | Токен расширения |
| `extTokenCreate` | Create token | Создать токен |
| `extTokenRegen` | Regenerate | Перевыпустить |
| `extTokenRevoke` | Revoke | Отозвать |
| `extIds` | Allowed extension IDs | Разрешённые ID расширения |
| `extHowTo` | How to install | Как установить |

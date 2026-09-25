# N10 — PWA и web push как канал уведомлений

**Ветка:** `feat/wave-nov-n10`. **Владение:** `README.md` §4, строка N10 (включая
`src/lib/notify.ts`, `src/lib/notify/**` кроме `types.ts`, `NotifyChannelsCard.tsx`,
`src/app/layout.tsx`). Дока — `docs/PWA.md`.

## Зачем
Открыть OpenGSC на телефоне как приложение (иконка на экране, без адресной строки), получать
push о падении сайта или новом лиде без Telegram, быстро посмотреть последние данные в дороге.

## Ограничение, которое надо показать честно
Service worker и Push API работают **только по HTTPS** (и на `localhost`). На iOS web push
работает только для **установленного на экран** PWA (iOS 16.4+). UI проверяет
`window.isSecureContext`, поддержку `PushManager` и режим standalone и объясняет, чего не хватает,
вместо неработающей кнопки.

## 1. PWA
- `public/manifest.webmanifest`: `name`, `short_name` «OpenGSC», `start_url: "/"`,
  `display: "standalone"`, `theme_color` / `background_color` из токенов темы, иконки 192/512 и
  maskable (сделай из `logo.svg`, положи в `public/icons/`).
- `src/app/layout.tsx`: `manifest`, `theme-color`, `apple-touch-icon`, мета для iOS standalone —
  через Metadata API Next (проверь гайд в `node_modules/next/dist/docs/` — версия Next здесь
  новая).
- `public/sw.js` (простой JS, без сборщика):
  - кэш оболочки приложения (network-first для HTML, stale-while-revalidate для статики `/_next/static`);
  - **API не кэшируется**, кроме белого списка GET для офлайн-чтения: `/api/uptime/status`,
    последняя сводка дашборда (посмотри, какой GET отдаёт карточки сайтов) — с пометкой
    «данные от {time}» в UI, когда показан кэш;
  - `push` → `showNotification(title, { body, icon, badge, data: { url } })`;
    `notificationclick` → открыть или сфокусировать `data.url`.
- Регистрация SW — маленький клиентский компонент в `layout.tsx`, только при `isSecureContext`.
- Кнопка «Установить приложение» (событие `beforeinstallprompt`; на iOS — инструкция «Поделиться
  → На экран Домой»).

## 2. Web push — `src/lib/push/*.ts`, `/api/push/**`
- VAPID: из env `OPENGSC_VAPID_PUBLIC_KEY`, `OPENGSC_VAPID_PRIVATE_KEY`, `OPENGSC_VAPID_SUBJECT`
  (`mailto:`). Если env нет — сгенерировать при первом запросе (`web-push.generateVAPIDKeys()`)
  и сохранить в `InstanceSetting` (ключи `vapid_public`, `vapid_private`). Приватный ключ
  никогда не уходит в браузер.
- `GET /api/push/vapid` → публичный ключ. `POST /api/push/subscribe` — сохранить
  `PushSubscription` текущего пользователя (upsert по `endpoint`), `DELETE` — удалить.
  `POST /api/push/test` — тест на все подписки пользователя.
- Отправка: `web-push.sendNotification(sub, JSON.stringify({ title, body, url }), { TTL: 3600 })`.
  Ответ 404/410 → подписку удалить; другие ошибки → `failures++`, после 5 подряд — удалить.
- `body` — текст уведомления без markdown, ≤ 240 символов; `url` — ссылка на связанный экран
  (для алерта сайта — `/site/<id>`, для лида — `/leads`, иначе `/`).

## 3. Канал `webpush` в доставке — `notify.ts`, `notify/channels.ts`
- `NotifyChannelId` уже содержит `"webpush"` (N0). `notifyUserDetailed` отправляет push всем
  подпискам владельца **и** участников рабочего пространства, у которых фильтр событий
  подписки пропускает событие (у каждой подписки свой фильтр — это телефон конкретного человека).
- `channelViews`: строка «Push на устройства» — число подписок, последняя удачная доставка.
- `NotifyChannelsCard.tsx`: строка push — ссылка на `PushSettingsCard`.
- Заглушку `webpush`, которую поставил N0 в `switch`, замени реальной веткой.
- Все прочие каналы и их поведение не меняются. Прогони `src/lib/notify/*.test.ts`.

## 4. `PushSettingsCard` (Settings)
«Включить уведомления на этом устройстве» (запрос разрешения → подписка), список моих устройств
(user agent, дата, удалить), фильтр событий для этого устройства, «Отправить тест», статус
поддержки (HTTPS / браузер / iOS standalone), «Установить приложение».

## Тесты — `src/lib/push/*.test.ts`
Формирование payload (обрезка, без markdown, url по событию); удаление подписки на 404/410 и
после 5 ошибок; фильтр событий подписки; VAPID из env против сохранённого (мок хранилища);
`sw.js` не проверяется юнит-тестом — ручная проверка по чеклисту.

## i18n (N0 создаёт)
| ключ | en | ru |
|---|---|---|
| `pwaInstall` | Install app | Установить приложение |
| `pwaInstallIos` | On iPhone: Share → Add to Home Screen | На iPhone: «Поделиться» → «На экран Домой» |
| `pwaOfflineData` | Offline — data from {time} | Нет сети — данные от {time} |
| `pwaPushTitle` | Push notifications | Push-уведомления |
| `pwaPushEnable` | Enable on this device | Включить на этом устройстве |
| `pwaPushDisable` | Disable on this device | Выключить на этом устройстве |
| `pwaPushDevices` | My devices | Мои устройства |
| `pwaPushTest` | Send test | Отправить тест |
| `pwaPushNeedsHttps` | Push needs HTTPS | Push работает только по HTTPS |
| `pwaPushUnsupported` | This browser does not support push | Этот браузер не поддерживает push |
| `pwaPushIosStandalone` | On iPhone, install the app to the Home Screen first | На iPhone сначала установите приложение на экран |
| `pwaPushDenied` | Notifications are blocked in browser settings | Уведомления запрещены в настройках браузера |
| `pwaPushChannel` | Push to devices | Push на устройства |
| `pwaPushCount` | {n} device(s) | Устройств: {n} |

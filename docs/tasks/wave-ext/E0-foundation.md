# E0 — фундамент волны «Расширение»

Коммит прямо в `main` (раздел 2 README). Пока его нет, E1…E5 не стартуют. Цель: после твоего
коммита каждая задача может писать код против `CONTRACT.md`, `tsc` и `npm run check` зелёные,
расширение загружается в Chrome без ошибок, а все новые места показывают «скоро».

## 1. Схема

`SerpCapture` из `CONTRACT.md` §1 — в `prisma/schema.prisma` после `SerpProjectHost`.
`npx prisma generate`. `db push` на свою копию базы — для проверки, не коммитится.

## 2. Серверные типы и заглушки

- `src/lib/ext/types.ts` — дословно из §2.
- Роуты из §3 (`hosts`, `hosts/enrich`, `serp/capture`, `serp/action`, `cloak`, `insights`,
  `meta-fit`, `serpmon/captures`, `serpmon/captures/[id]`) — каркас: правильное право в
  `extAuth` (для `/api/serp-monitor/captures` — `workspaceUserId()`, как остальные роуты serpmon),
  `OPTIONS` у `/api/ext/*`, ответ `501 { error: "not_implemented" }` с CORS-заголовками.
  Параметры динамического роута — как в существующих `src/app/api/serp-monitor/**/[id]/route.ts`.
- `src/lib/ext/{hostIntel,hostIntelPure,serpCapture,snippet,insights}.ts` — экспортируй имена
  функций из брифов E2 и E5 (раздел «Сигнатуры» в каждом) с телом `throw new Error("not_implemented")`.
- `src/lib/mcp/toolsSerpCaptures.ts` — `SERP_CAPTURE_TOOLS` с описанием из §6 и handler,
  который бросает `not_implemented`. Регистрация в `tools.ts` — две строки (§6).
- `src/components/serpmon/CapturesTab.tsx` — компонент `CapturesTab({ projectId }: { projectId: string })`
  с текстом `serpmonCaptureSoon`.
- `src/app/serp-monitor/[id]/page.tsx` — **одна** точка: `"captures"` в `TABS`, кнопка
  `serpmonTabCaptures` в списке вкладок, рендер `<CapturesTab projectId={…} />`. Больше в файле
  ничего не трогать.

## 3. Расширение

Всё по `CONTRACT.md` §4–§5.

1. **`manifest.json`** — §4.1. `version` 1.1.0. Проверь, что JSON валиден и Chrome грузит его
   без предупреждений (кроме ожидаемого про `tabs`).
2. **`background.js` → роутер.** Перенеси текущий код меню и `sendUrl` в `bg/menus.js`
   **без изменения поведения** (тот же `onInstalled`, те же id меню, тот же badge). В
   `background.js` оставь только: `importScripts(...)` в порядке из §4, прокси `ext:api` с
   whitelist (§5) и проверкой `sender.id`, обработчик `MSG_SEND` (как был), вызов
   `ExtSettings.syncOverlayRegistration()` на `onStartup` и `onInstalled`.
   Учти: в MV3 слушатели должны регистрироваться синхронно на верхнем уровне воркера, иначе
   после засыпания воркера события теряются. Каждый `bg/*.js` регистрирует свои слушатели сам
   при загрузке.
3. **`bg/panel.js`, `bg/serp.js`** — пустые файлы с комментарием-шапкой и владельцем.
4. **`lib/protocol.js`** — §5 дословно.
5. **`lib/api.js`** — восемь новых методов из §5. Остальное не трогать.
6. **`lib/settings.js`** — §4.2 целиком, рабочий:
   - `get`/`set` поверх `chrome.storage.local` с дефолтами;
   - `set` рассылает `MSG_SETTINGS_CHANGED`;
   - `requestAllSites()`, `requestSerpDomains(hosts)` — `chrome.permissions.request` (вызываются
     только из обработчика клика, иначе Chrome отклонит);
   - `syncOverlayRegistration()`: если `serpOverlay` выключен или разрешений на домены нет —
     `unregisterContentScripts({ ids: ["opengsc-serp"] })` (ошибку «не зарегистрирован»
     проглатывать); иначе `getRegisteredContentScripts` → `update` или `register`. Домены, на
     которые разрешение отозвано в `chrome://extensions`, из `serpDomains` убираются
     (`chrome.permissions.contains` по каждому).
7. **`lib/googleDomains.js`** — `GOOGLE_SEARCH_HOSTS`. Список возьми с
   https://www.google.com/supported_domains (если сеть недоступна — попроси Руслана открыть его
   и прислать), каждую строку `.google.xx` → `www.google.xx`, отсортировать, вшить. Плюс функция
   `suggestedHosts(uiLang)` → `["www.google.com", <домен страны языка, если очевиден>]`
   (`el` → `www.google.gr`, `ru` → `www.google.ru`, `it` → `www.google.it`, `de` → `www.google.de` и т.д.;
   нет очевидного — только `com`).
8. **Настройки (`options.*`)** — к текущим полям «URL инстанса» и «токен» добавь два блока:
   - **Панель:** переключатель «Анализировать любую страницу без клика по иконке» →
     `requestAllSites()`; рядом — состояние разрешения («выдано / не выдано»).
   - **Выдача Google:** переключатель оверлея; поле поиска по доменам + чекбоксы (по умолчанию
     отмечены `suggestedHosts`); «Сохранить» запрашивает разрешение на отмеченные и вызывает
     `syncOverlayRegistration()`; «Компактный режим»; выпадающие «сайт по умолчанию для Rank
     Tracker» и «проект SERP Monitor по умолчанию». Списки берутся из `GET /api/ext/lists`
     (см. п. 11). Если сервер недоступен или не настроен, вместо списков — текстовые поля с ID
     и подсказкой `optIdHint`.
11. **`GET /api/ext/lists`** — делаешь целиком ты (маленький роут, `extAuth(req, "read")`):
    сайты портфеля (`Site` владельца: `id`, метка как в `/api/ext/page`) и проекты SERP Monitor
    (`listProjects` из `serpmon/store.ts`: `id`, `name`, `country`, `lang`). Таблица SerpProject
    отсутствует → `projects: []`. Ответ — `ListsResponse` из контракта.
9. **`sidepanel.html`** — каркас: шапка (хост страницы, кнопка «обновить»), контейнер вкладок,
   тело; `<script>` всех модулей в порядке из §4.4. `panel/core.js` — минимальный рабочий
   реестр: рендерит вкладки, которые зарегистрировались, и показывает «скоро». `panel/tab-*.js` —
   `Panel.register` с `render` → «скоро».
10. **Заглушки JS-модулей:** `lib/vitals.js`, `lib/highlight.js`, `lib/export.js`, `lib/donor.js`,
    `lib/serpParse.js`, `serp/overlay.js` — объекты с именами из контракта и пустыми результатами
    правильной формы. `content.js` пока возвращает N11-ответ плюс `vitals: null, donor: null`.

## 4. Локали

Собери ключи из конца брифов E1–E5:

- приложение (`src/locales/*.json`, 7 файлов) — переведи uk/fr/es/de/zh сам;
- расширение (`extension/_locales/{en,ru}/messages.json`).

Плюс ключи самого E0 (ниже). `npm run check:i18n` — зелёный. Для расширения проверь отдельно,
что набор ключей в `en` и `ru` одинаковый (`node -e` на два JSON — в отчёт).

## 5. Проверка

```bash
npx prisma generate && npm run check
npx tsc -p tsconfig.json --noEmit     # не больше ошибок, чем на main до тебя
npx eslint src/lib/ext/types.ts src/app/api/ext src/app/api/serp-monitor/captures src/components/serpmon/CapturesTab.tsx src/lib/mcp/toolsSerpCaptures.ts
```

Руками: «Обновить» расширение → нет ошибок на карточке; клик по иконке открывает панель со
вкладкой «скоро»; контекстное меню «Отправить в OpenGSC» работает как раньше (badge `Q`/`O`);
в настройках оверлей включается, разрешение на google.com запрашивается, в
`chrome://extensions` → «Подробнее» → «Доступ к сайтам» появился google.com; на
`google.com/search?q=test` в консоли страницы видно, что `serp/overlay.js` загрузился (одна
строка `console.debug` в заглушке).

## 6. Ключи E0

Расширение (en · ru):

| ключ | en | ru |
|---|---|---|
| `optPanelSection` | Side panel | Боковая панель |
| `optPanelAllSites` | Analyze any page without clicking the icon | Анализировать любую страницу без клика по иконке |
| `optPermissionGranted` | Permission granted | Разрешение выдано |
| `optPermissionMissing` | Permission not granted | Разрешение не выдано |
| `optSerpSection` | Google results overlay | Оверлей выдачи Google |
| `optSerpEnable` | Show OpenGSC data on Google results | Показывать данные OpenGSC в выдаче Google |
| `optSerpDomains` | Google domains | Домены Google |
| `optSerpDomainsSearch` | Filter domains… | Найти домен… |
| `optSerpCompact` | Compact mode (one line per result) | Компактный режим (одна строка на результат) |
| `optDefaultSite` | Site ID for "Track in Rank Tracker" | ID сайта для «В Rank Tracker» |
| `optDefaultProject` | SERP Monitor project ID | ID проекта SERP Monitor |
| `optIdHint` | The ID is in the OpenGSC address bar: /site/<id>, /serp-monitor/<id> | ID видно в адресной строке OpenGSC: /site/<id>, /serp-monitor/<id> |
| `optSaved` | Saved | Сохранено |
| `panelSoon` | Coming soon | Скоро |

Приложение: `serpmonTabCaptures` — Browser captures · Снимки из браузера;
`serpmonCaptureSoon` — Coming soon · Скоро.

# T6 — Уведомления, MCP, документация

**Ветка:** `feat/serpmon-t6` от `feat/serp-monitor`.
**Файлы:** `src/lib/serpmon/alerts.ts`, `alerts.test.ts`, `src/lib/notifyI18n.ts`,
`src/lib/alertScheduler.ts` (только новая секция настроек), `src/lib/mcp/toolsSerpMon.ts`,
`src/lib/mcp/tools.ts` (только импорт и регистрация), `src/app/api/serp-monitor/projects/[id]/test-alert/**`,
`docs/SERP-MONITOR.md`, `CHANGELOG.md`.

Читать: `CONTRACT.md` §3.10, §4, §5 (п.4); `src/lib/drops/scheduler.ts` (как собирается
текст уведомления через `NOTIFY_L`), `src/lib/notify.ts` (`notifyUser`), `src/lib/alertScheduler.ts`
(`getAlertSettings`, `AlertEvent` и `dedupeKey`), `src/lib/mcp/toolsDrops.ts` (образец набора
MCP-инструментов и поля `cost`).

## 1. Уведомление о шторме — `alerts.ts`
`serpmonRunAlerts(userId, project, run)`:
- ничего не делает, если `!project.alertStorm`, `!run.storm`, или глобальный переключатель
  `serpmonStorm.enabled` в настройках алертов выключен;
- дедуп через `AlertEvent` (`type: "serp_storm"`, `dedupeKey: "serp_storm:<runId>"`) — как
  остальные алерты;
- текст — `stormAlertText(lang, …)`: проект, сила шторма, доля запросов выше обычного,
  до 5 запросов с наибольшей волатильностью в этом прогоне, до 5 хостов с наибольшим
  числом входов+выходов в этом прогоне (`SerpChange`, `hidden = false`), ссылка
  `/serp-monitor/<id>?tab=storms` — если в проекте есть способ узнать базовый URL инстанса
  (посмотри, как это делают другие алерты; нет — без ссылки);
- `notifyUser(userId, text)`; любые исключения — в лог `[serpmon-alert]`, наружу не бросать.

`sendSerpmonTestAlert` — то же сообщение на выдуманных данных с пометкой «тест», без
`AlertEvent`. Нет канала → `{ ok: false, error: "no_channel" }`.

Строки — новые поля в `NOTIFY_L` (`notifyI18n.ts`) для **всех** языков, которые там есть:
`serpmonStormTitle(project)`, `serpmonStormScore(score, share)`, `serpmonStormKeywords`,
`serpmonStormHosts`, `serpmonTestPrefix`. Формат — как у `dropsWatch*`.

## 2. Настройка — `alertScheduler.ts`
Добавь в `AlertSettings` и `DEFAULT_ALERT_SETTINGS` секцию `serpmonStorm: { enabled: true }`
и строку слияния в `getAlertSettings` по образцу соседних. Больше в этом файле ничего не менять.
UI переключателя в настройках алертов **не делай** (чужой файл) — опиши в отчёте, где он
должен появиться; по умолчанию включено, а отключение на уровне проекта уже есть (`alertStorm`).

## 3. Роут тестового уведомления
`POST /api/serp-monitor/projects/[id]/test-alert` — право `act`, проверка владельца проекта,
`sendSerpmonTestAlert`.

## 4. MCP — `toolsSerpMon.ts`
Экспорт `SERPMON_TOOLS: McpTool[]`, регистрация в `tools.ts` рядом с `DROPS_TOOLS`.
Все обработчики — через функции `store.ts` (T3) и `domains.ts` (T4), никакого своего SQL.

| Инструмент | cost | Что делает |
|---|---|---|
| `serpmon_projects` | local | список проектов (`ProjectSummary`) |
| `serpmon_market` | local | `marketRows` с фильтрами (`project_id`, `query`, `domain`, `group`, `changed_only`, `limit` ≤ 200) |
| `serpmon_keyword_history` | local | `keywordHistory` |
| `serpmon_storms` | local | последние прогоны (`listRuns`) + вердикт последнего |
| `serpmon_domains` | local | `domainRows` (пресеты как в UI) |
| `serpmon_run` | net | `startRun(..., "manual")` — обращается к A-Parser пользователя; без оплаты за запрос. Возвращает `runId` сразу; описание говорит, что прогон асинхронный и статус смотреть через `serpmon_storms` |

Описания инструментов — на английском, как у соседей, с явным указанием, что изменения
посчитаны по доменам и что `failed`-съёмы в сравнение не входят.
Если `get_capabilities` перечисляет модули с данными (см. `dataModuleCounts` в `toolsData.ts`) —
**не правь** `toolsData.ts`, опиши нужную строку в отчёте.

## 5. Документация — `docs/SERP-MONITOR.md`
Для пользователя, по-английски (как остальные `docs/*`), разделы:
что это и зачем (коротко, словами из поста — новореги, кто влетает/вылетает, штормы,
реальная сложность ниши); требования (A-Parser, прокси, `SE::Google`); как считать нагрузку
(запросы × страницы, пример 944 × 10); как читать вкладки; что значат статусы
`ok/partial/failed` и почему `failed` не порождает «вылетов»; как считается шторм и почему
первые 7 прогонов — калибровка; хранение и прореживание; ограничения v1 (только Google
desktop, MySQL и длинные URL); фаза 2.

## 6. CHANGELOG
Запись в раздел «Unreleased» (или как принято в файле — посмотри верх): модуль, A-Parser
как SERP-провайдер, A-Parser в Rank Tracker (если R возьмёт коммит T1), необходимость
`prisma db push`.

## Тесты — `alerts.test.ts`
`stormAlertText` для en и ru: содержит имя проекта, силу шторма с одним знаком после запятой,
не больше 5 запросов и 5 хостов, не падает на пустых списках.

## Проверка
`npm run check`, `eslint` по своим файлам (у `alertScheduler.ts` и `tools.ts` сравни число
ошибок до/после), `tsc`.

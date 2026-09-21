# Массовые и плановые аудиты — ТЗ

Ответ на issue #19 (bulk + scheduled audits). Управление десятками площадок GSC
требует: прогон аудитов пачкой, расписание без системного cron, очередь с
ограничением параллелизма, видимые Last/Next audit. Роут — существующий `/audits`,
настройки — Settings, исполнитель — in-process очередь + шедулер в стиле
уже живых в проекте (`alertScheduler`, `digestScheduler` и др., старт из
`src/instrumentation.ts`).

**Статус на 2026-09-21: реализовано целиком (фазы 1–4).** Ядро: `src/lib/audit/queue.ts`
(помпа, retry, cancel/retry-failed/pause) + чистый словарь `src/lib/audit/schedule.ts`
(настройки, интервалы, due-логика — 4 юнит-теста) + `src/lib/audit/auditScheduler.ts`
(бут-recovery, тик 15 мин, час-окно). API: POST через очередь, `POST /api/audit/bulk`,
`POST /api/audit/queue/action`, `GET|POST /api/audit/settings`. UI: вкладка Sites с
чекбоксами и select-filtered, панель очереди, per-site интервалы, Last/Next колонки,
колонка триггера в истории, чип «queued» в панели сайта. Схема: `SiteAudit.trigger` +
`SiteAudit.nextAttemptAt` + `Site.auditSettings` + `User.auditQueueSettings` — деплой
требует `db push` + отдельный `prisma generate`. Развёрнуто поверх плана ниже без
отклонений; чистые функции Due/интервалов вынесены в `schedule.ts` (общий для клиента
и сервера) — этого пункта в исходном плане не было.

## Что уже есть и на что опираемся

- `POST /api/audit` (`src/app/api/audit/route.ts`): guard «один running-аудит на
  сайт» (409 `already_running`), создаёт `SiteAudit`, крутит промис
  fire-and-forget внутри процесса. Ядро запуска выносится в либу — маршрут и
  очередь зовут одно и то же.
- `SiteAudit` уже несёт рантайм-примитивы восстановления: `status`, `stage`,
  `progress` (0..100 монотонно), `attempt`, `heartbeatAt`. «queued» и retry
  достраиваются поверх, мигрировать существующие строки не нужно.
- Шедулеры проекта: тик в процессе, настройки per-user JSON-колонкой
  (`digestSettings` на `User` — образец), защита от двойного запуска по
  `lastSentAt`-полю. Планировщик аудитов повторяет паттерн один в один.
- Прецедент персистентной очереди — indexer queue: состояние живёт в БД,
  UI крутит цикл по остатку.

## Схема (одна волна db push + generate)

- `SiteAudit.trigger String @default("manual")` — `manual | bulk | scheduled | retry`.
  Новые строки получают метку триггера; старые читаются как `manual`.
- `Site.auditSettings String?` — JSON `{ mode: "inherit" | "custom" | "off",
  intervalDays?: number }`. `inherit` берёт дефолт воркспейса, `off` выключает
  автопланы для площадки (ручные прогоны остаются).
- `User.auditQueueSettings String?` — JSON `{ concurrency: number,
  defaultIntervalDays: number, scheduleHourUtc: number, retryAttempts: number,
  retryDelayMin: number, paused: boolean }`. Дефолты в коде, колонка пишется
  только когда оператор меняет (как `digestSettings`).

Отдельная модель `AuditBulkRun` не заводится: массовый прогон — это пачка
`SiteAudit`-строк с `trigger="bulk"`, созданных одним запросом; прогресс и
ретраи считаются по строкам, докатывать сессионную сущность незачем.

## Очередь — `src/lib/audit/queue.ts`

- In-process, `maxConcurrent` из `auditQueueSettings` (дефолт 2; ползунок, не
  кап — см. политику «no artificial caps»).
- Очередь долговечна состоянием в БД: строка `status="queued"` — заказ, очередь
  только раскладывает заказы по слотам. На буте процесса (и на тике) подбираются:
  - `queued` без живого слота → в память;
  - `running` с протухшим `heartbeatAt` (порог из настроек, дефолт 10 мин) →
    ретрай по политике (это и есть переживание рестартов: ручной прогон,
    убитый рестартом, доедает сам, а не висит «running» навсегда).
- Слот = вызов вынесенного ядра запуска; guard «один running на сайт»
  сохраняется, поэтому дубликатов не появляется даже при гонке тика и ручного
  клика.
- Пауза/резюм — флаг `paused` в настройках: тик не старует новых слотов,
  летящие завершаются.
- Retry: `error` с `attempt < retryAttempts` → обратно `queued`, `attempt+1`,
  `nextAttemptAt = now + retryDelayMin`. Ручной «retry failed» в UI — тот же
  переход явным действием.

## Шедулер — `src/lib/audit/auditScheduler.ts`

- Старт из `src/instrumentation.ts` рядом с остальными; тик 15 мин.
- На тике: по каждому сайту с `auditSettings != off` — если нет живого
  (`running`/`queued`) аудита и последний завершённый старше интервала
  (воркспейс-дефолт или custom) → создать строку `trigger="scheduled"` и
  поставить в очередь. Час запуска (`scheduleHourUtc`) сглаживает все сайты к
  одному окну, как `hourUtc` у дайджестов.
- «Next audit» не хранится: колонка в UI вычисляется как
  `lastFinished + interval` (для `mode="off"` — «—»). Проверяемость из issue
  обеспечивается видимостью колонки, а не дублем состояния в БД.

## API

- `POST /api/audit/bulk` `{ siteIds: string[] }` → создаёт `queued`-строки
  `trigger="bulk"` (скип сайтов с живым аудитом, честный список skipped),
  возвращает сводку. Повторный запрос, пока bulk-пачка не опустела, — 409.
- `GET /api/audit/queue` → счётчики running/queued/completed/failed + per-site
  статусы для прогресса «Auditing sites: 12 / 47».
- `POST /api/audit/queue/action` `{ action: "pause" | "resume" | "cancel" |
  "retryFailed" }` — cancel снимает только `queued` (строки в `error` с
  `attempt`, потраченным не до конца, остаются кандидатами на retryFailed).
- `POST /api/audit/settings` — глобальные + per-site настройки.
- `POST /api/audit` проходит через очередь с `trigger="manual"`: поведение для
  ручного клика не меняется.

## UI

- `/audits`: вкладка «Sites» — таблица всех площадок: чекбокс, домен,
  Last audit, Next audit, интервал (inherit/custom/off). Селект-олл по фильтру
  (паттерн select-filtered уже в доме), «Run audits» для выбранных, строка
  прогресса по `GET /api/audit/queue` с поллингом, пока пачка живая
  (существующий 5-секундный refresh при `running` расширяется на `queued`).
- История: колонка-чип триггера (Manual/Bulk/Scheduled/Retry).
- Панель очереди на `/audits`: счётчики + pause/resume/cancel/retry-failed.
- Settings → Automation: блок настроек очереди (concurrency, дефолт-интервал,
  час, retry-политика) — ручка обязана быть видимой и описанной, молчаливые
  дефолты считаются неотвезёнными.

## Словарь статусов — обязательный свип

`"queued"` расширяет `status` (`running | completed | error`). Проверить всех
потребителей словаря и не дать им упасть/промолчать на новом значении:

- `src/app/audits/page.tsx` — `StatusFilter`, счётчики, фильтры, чипы;
- `src/components/SiteAuditPanel.tsx` — вкладка аудита на сайте;
- `src/lib/audit/historyRows.ts` — читатель истории;
- `src/lib/alertScheduler.ts` — алерты `audit_score` смотрят завершённые;
- `src/app/api/audit/[id]/route.ts`, `src/app/api/system/schema/route.ts`;
- `src/lib/mcp/tools.ts` (`get_site_audit`) — отдавать `queued` честно, как есть.

## i18n

Новые ключи (`auditsTabSites`, `auditsBulkRun`, `auditsQueue*`,
`auditsColTrigger*`, `setAuditQueue*` и т.п.) — сразу в 7 локалях, ручная
подстановка плейсхолдеров `{n}` по конвенции дома.

## Фазы

1. **Ядро:** схема (3 колонки) + `queue.ts` + вынос ядра запуска из роута +
   статус `queued` со свипом потребителей. Ручные прогоны ходят через очередь,
   поведение прежнее.
2. **Массово:** `POST /api/audit/bulk` + вкладка Sites с чекбоксами, прогрессом
   и пер-сайт статусами (Pending/Running/Completed/Failed/Skipped).
3. **Планово:** `auditScheduler.ts` + per-site настройки + колонки Last/Next.
4. **Очередь как объект:** панель статусов, pause/resume/cancel/retryFailed,
   retry-политика на автопилоте, бэкап-подбор протухших `running` на буте.

Развёртывание: `db push` + отдельный `prisma generate` (Prisma 7 не
регенерирует клиент сам). MCP-инструменты под планировщик не заводятся —
аудиты UI-центричны; если появится сценарий, добавим по паритету позже.

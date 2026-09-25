# T2 — Аптайм-монитор

**Ветка:** `feat/wave-oct-t2` от `feat/wave-oct`, worktree `.worktrees/wave-t2`.
**Владение:** `README.md` §4, строка T2. Главный файл дашборда `src/app/page.tsx` — твой и
только твой в этой волне.

## Зачем

Сейчас про упавший сайт Руслан узнаёт по просевшему трафику, через день. У него десятки сайтов:
трансферный бизнес (каждый час простоя — потерянные заказы) и сетка аффилиатных сайтов.
Нужно:
- точка статуса у каждого сайта на дашборде: зелёная — онлайн, красная — офлайн;
- упавшие сайты **сами поднимаются наверх**, чтобы их было видно сразу;
- фильтр по статусу;
- сообщение в Telegram «упал», потом «поднялся, простой N мин».

Идея взята из `hartemyaakoub/tkawen-automation` (пинг каждые 15 минут, лог, Telegram). Код
оттуда не берём: там GitHub Actions и JSON-файлы, а у нас in-app планировщик и база.

## Модель поведения

### Одна проверка — `check.ts`
- `safeFetch(url, { method: "GET", redirect: "follow", maxRedirects: 5, timeoutMs, maxBytes: 2_000_000 })`.
  `safeFetch` — это ещё и защита от SSRF: без неё любой участник команды мог бы поставить
  монитор на `http://127.0.0.1:9091` (A-Parser) и узнавать по ответам, что внутри сервера.
  Если `safeFetch` не отдаёт тело при `HEAD` — нам и не нужен `HEAD`: ключевое слово ищется в теле.
- `User-Agent: OpenGSC-Uptime/1.0 (+https://opengsc.org)`. Некоторые WAF режут неизвестные UA —
  это видно как 403, и пользователь сам добавит 403 в допустимые коды.
- Латентность — от начала запроса до получения заголовков. Если `safeFetch` не даёт этого
  разделения, то до конца чтения тела; напиши в отчёте, что именно меряешь.
- Классификация (`classifyCheck`, чистая функция):
  - сетевые ошибки → `timeout | dns | tls | connect | redirect_loop | blocked_target | other`
    (коды `SafeFetchError` сопоставь с `UptimeCause`, таблица — в модуле);
  - код не входит в `acceptStatus` → `http_status`;
  - `keyword` задан и не найден (без регистра, по декодированному тексту) → `keyword_missing`;
  - всё ок, но `latencyMs > slowMs` → `status: "degraded"`, `ok: true`.
- `parseAcceptStatus("200-399,401")` — диапазоны и отдельные коды, пробелы допустимы, мусор
  игнорируется. Пустая строка = `200-399`.

### Состояние — `state.ts`, чистая функция `nextState`
```
unknown ─ok→ up
unknown ─fail×N→ down  (инцидент открыт, но алерта «упал» НЕТ — был лежачим при включении)
up ─fail→ up (consecutiveFails=1, transition "confirm_pending": планировщик делает повторную проверку через UPTIME_CONFIRM_RECHECK_MS)
up ─fail×N→ down (transition "went_down" → алерт)
down ─ok→ up (transition "recovered" → алерт с длительностью)
up ─slow→ degraded ("degraded"; алерт только если notifyDegraded) ─fast→ up ("undegraded", без алерта)
```
`N = failThreshold` (по умолчанию 2). Инцидент начинается с **первой** неудачной проверки серии,
а не с подтверждающей. Иначе длительность простоя занижается на интервал.

### Сбой самого сервера — `isCheckerOffline`
Если в одном тике проверено ≥ 3 монитора и ≥ `UPTIME_OFFLINE_RATIO` из них упали с сетевыми
причинами (`timeout | dns | connect`), тик считается сбоем сети VPS. Тогда:
- результаты тика **не** двигают состояние мониторов и не открывают инцидентов;
- `UptimeCheck` пишутся с `cause` как есть — для истории;
- у всех мониторов в UI статус `checker_offline` (вычисляемый: хранится в памяти планировщика
  до следующего нормального тика, в базу `status` не пишется);
- алертов нет.

### Планировщик — `scheduler.ts`
- Тик каждые **30 с** (`setInterval`, защита от повторного входа, как в `serpmon/scheduler.ts`).
- Тик: выбрать `enabled && nextCheckAt ≤ now` (индекс `[enabled, nextCheckAt]`), не больше 50;
  проверять с параллельностью 8; `nextCheckAt = now + intervalMin`, а после первой неудачи у
  монитора в `up` — `now + UPTIME_CONFIRM_RECHECK_MS`.
- **Автозапись.** Раз в 10 минут: для каждого владельца рабочего пространства с `autoEnroll`
  создать монитор каждому сайту, у которого его нет и который не `archivedAt` и не `hidden`.
  URL = корень сайта: для `sc-domain:example.com` — `https://example.com/`, для URL-ресурса — сам
  URL. Интервал — `defaultIntervalMin`. Первые проверки идут со случайным сдвигом в пределах
  интервала, чтобы 60 новых мониторов не стартовали в одну секунду.
- **Heartbeat.** Если `heartbeatUrl` задан — `GET` не чаще раза в минуту через `safeFetch`,
  ошибки только в лог. Это ответ на вопрос «кто сообщит, что упал сам VPS»: внешний сервис
  (healthchecks.io, UptimeRobot heartbeat, Better Stack) поднимет тревогу, если пинги перестали
  приходить. Подсказка в UI — ключ `uptimeHeartbeatHint`.
- **Алерты** через `notifyUser(ownerId, text, { event: "uptime", title })`. Шаблоны — только из
  `notifyI18n.ts` (`uptimeDownTitle/Msg`, `uptimeUpTitle/Msg`, `uptimeStillDownMsg`,
  `uptimeDegradedMsg`, `uptimeCause`), язык — из `alertSettings.lang` владельца (как делает
  `alertScheduler.ts`). Дедупликация через `AlertEvent` с `type: "uptime_down" | "uptime_up" |
  "uptime_reminder"` и `dedupeKey: uptime:<incidentId>:down|up|rem:<n>`. Флаги
  `alertedDown/alertedUp` на инциденте — для UI и защиты от повтора при рестарте.
  Если алерт «упал» не ушёл (все каналы вернули ошибку), повторить на следующем тике, но
  не больше 3 раз.
- **Напоминания** «всё ещё лежит» каждые `reminderHours` (0 = выкл.).
- **Ретеншн** раз в сутки: удалить `UptimeCheck` старше `UPTIME_RAW_RETENTION_DAYS` пачками по 400.
- **`UptimeDaily`** обновляется инкрементом на каждой проверке (`checks`, `fails`,
  `latencySum/Max`). `downMs` раскладывается по дням при закрытии инцидента, а для открытого —
  считается на лету при чтении.
- Всё внешнее — внутри `withCallContext` (`src/lib/providerLog/context.ts`), как в
  `alertScheduler.ts`. **Но** не пиши каждую проверку в журнал провайдеров как платный вызов:
  проверь, как `loggedFetch` помечает провайдера, и используй обычный `safeFetch` без журнала.
  50 сайтов × раз в 5 минут = 14 400 строк в сутки в журнале провайдеров — это шум.

### Хранилище — `store.ts`
- `uptimeBadges(userId)`: один запрос по мониторам сайтов рабочего пространства плюс сумма
  `UptimeDaily` за сегодня и вчера для `uptime24h` (приблизительно: доля успешных проверок за
  последние сутки по сырым `UptimeCheck`, если это укладывается в один агрегирующий запрос;
  иначе — по `UptimeDaily`, напиши, что выбрал).
- `uptimeSummary`: `d1/d7/d30/d90` = `1 − fails/checks` по `UptimeDaily` (null, если проверок 0);
  латентность по дням за 30 дней; инциденты — последние 20.
- Нет монитора → `{ monitor: null }` на API; UI предлагает включить.
- Таблицы нет → `{ notMigrated: true }` (образец `schemaMissing()` в `src/lib/drops/store.ts`).

## UI

### Дашборд — `src/app/page.tsx`
- Один запрос `GET /api/uptime/status` при загрузке и раз в 60 с, пока вкладка видима
  (`document.visibilityState`). Карта `siteId → UptimeBadge`.
- `UptimeDot` (твой компонент): кружок 8 px слева от названия сайта на карточке и в строке
  таблицы. Цвета — токены: `--color-accent-green` (up), `--color-accent-red` (down),
  `--color-accent-orange` (degraded), `--color-text-muted` (unknown, paused,
  checker_offline). У down — мягкая пульсация, отключаемая `prefers-reduced-motion`.
  Всегда `role="img"` и `aria-label`/`title`: «Офлайн с 14:05 · HTTP 502 · аптайм 24 ч 97,9 %».
- **Упавшие наверх.** Над группой избранного — группа `uptimeNeedsAttention` со всеми сайтами
  в `down` (и в `degraded`, если `notifyDegraded`). Группа видна только если в ней кто-то
  есть; сайт в ней не дублируется ниже. Это работает при **любой** сортировке. Сортировку
  пользователя не ломать — группа стоит поверх неё. Скрытые (`hidden`) и архивные сайты в
  группу не попадают.
- Бейдж `uptimeDownCount` рядом с заголовком дашборда, если офлайн ≥ 1.
- **Фильтр** `uptimeFilter`: `uptimeFilterAll` / `uptimeFilterIssues` / `uptimeStatus_down` /
  `uptimeStatus_up` — рядом с существующими чипами фильтров (маркет, теги), тем же стилем.
  Сохраняется так же, как соседние фильтры (`usePersistedState`, если они им пользуются).
- В режиме `checker_offline` — одна строка-предупреждение над списком, точки серые.
- Share view: точка есть, а бейджа, фильтра и группы нет.

### Сайт → Health — `src/components/uptime/UptimePanel.tsx`
Карточка над `SiteHealthPanel` (её вставил T0):
- статус крупно (точка + текст + «с {time}»), последняя латентность, кнопка `uptimeCheckNow`;
- четыре числа аптайма: 24 ч, 7, 30, 90 дней;
- график латентности за 30 дней: SVG без новых зависимостей, по образцу существующих
  спарклайнов (`DrSparkline.tsx`); дни с простоем отмечены красным;
- таблица инцидентов: начало, длительность или `uptimeOngoing`, причина через `uptimeCause_*`;
- раскрывающиеся «Настройки»: `uptimeEnabled`, `uptimeUrl`, `uptimeInterval`
  (`UPTIME_INTERVALS`), `uptimeTimeout`, `uptimeAccept`, `uptimeKeyword`, `uptimeSlow`,
  `uptimeFailThreshold`, `uptimeAlerts`. Сохранение — `PUT /api/uptime/[siteId]`. Изменение URL
  сбрасывает статус в `unknown` и ставит проверку на сейчас;
- подпись `uptimeFree`.

### Settings — `src/components/uptime/UptimeSettingsCard.tsx`
Карточка в настройках (вставил T0): `uptimeAutoEnroll`, `uptimeDefaultInterval`,
`uptimeReminder`, `uptimeNotifyDegraded`, `uptimeHeartbeat` + `uptimeHeartbeatHint`.

## MCP — `toolsUptime.ts`
`get_uptime` (`local`): без `site` — массив `UptimeBadge` с доменами; с `site` — `UptimeSummary`.

## Документация — `docs/UPTIME.md`
Что проверяется, как считается «упал», почему нет алерта при сбое сети сервера, зачем heartbeat,
как добавить 403 в допустимые коды для сайтов за Cloudflare, сколько это стоит (ничего).

## Тесты — `src/lib/uptime/*.test.ts`
- `parseAcceptStatus`: диапазоны, одиночные коды, мусор, пустая строка.
- `classifyCheck`: каждый `UptimeCause`; `degraded` при медленном ответе; `keyword_missing`.
- `nextState`: все переходы из диаграммы, включая «лежал при включении — алерта нет» и «1 неудача,
  потом успех — инцидента нет».
- `isCheckerOffline`: 2 монитора из 2 (мало для вывода → false), 5 из 6 → true, 3 из 6 → false,
  HTTP 500 не считается сетевой причиной.
- Длительность инцидента считается от первой неудачи.

## Проверка
```bash
npx tsx --test src/lib/uptime/*.test.ts
npm run check
npx eslint src/lib/uptime src/components/uptime src/app/api/uptime src/lib/mcp/toolsUptime.ts src/app/page.tsx
```
`src/app/page.tsx` уже содержит ошибки линта — сравни с базой.
Ручная проверка — пункт 2 чеклиста в `README.md` §8.

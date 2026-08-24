# T3 — Полная постраничная выгрузка бэклинков из Ahrefs

Ветка: `feat/backlinks-t3-ahrefs-export`
Код пиши сразу; запустить получится после того, как влита T0.

## Задача

Сейчас `/api/metrics/backlinks` тянет **ссылающиеся домены** (`refdomains`), максимум
1000 строк, и это доменный срез. Клиентский сценарий другой: подрядчик присылает
список **страниц**, где стоят ссылки, и нужно следить, отваливаются они или нет.
Постраничные данные (`all-backlinks`) в приложении сегодня дёргаются только для
конкурентов, в Link Monitor.

Нужна выгрузка бэклинков **своего** сайта, постранично, целиком, в новую таблицу
`SiteBacklink`, фоновой задачей с прогрессом.

Потолка строк нет. Владелец продукта платит за данные осознанно; наша работа —
показать цену до старта и не платить дважды за то, что уже лежит в БД.

## Что прочитать

- `docs/tasks/CONTRACT.md`, разделы 1, 4, 5
- `src/app/api/linkwatch/run/route.ts` — как здесь уже вызывается `all-backlinks`
- `src/lib/seo/metrics.ts` — `requestWithRetry`, семафор на 3 запроса, `estimateUnits`
- `src/lib/seo/backlinkStore.ts` — `syncRefDomains`, особенно комментарий про `complete`
- `src/app/api/audit/route.ts` + `src/lib/audit/crawler.ts` — образец fire-and-forget
  задачи с прогрессом и heartbeat

## Файлы, которыми ты владеешь

- `src/lib/seo/backlinksApi.ts` (создать) — разговор с Ahrefs
- `src/lib/seo/siteBacklinkStore.ts` (создать) — запись в `SiteBacklink` / `SiteBacklinkEvent`
- `src/app/api/backlinks/sync/route.ts` (создать) — старт и статус задачи

`src/lib/seo/metrics.ts` тебе **не принадлежит** (владеет T1). Нужны оттуда
`getMetricsCreds`, `estimateUnits`, `requestWithRetry` — импортируй, не правь.
Если чего-то не хватает — опиши нужную правку в отчёте.

## Задача 1 — разведка `offset`

Официальная дока Ahrefs не документирует `offset` для `all-backlinks` и `refdomains`.
Дока реселлерского шлюза перечисляет `offset` в общих параметрах. То есть неизвестно.

Сделай функцию `probePagination(creds, target)`:

1. запрос `limit=10, offset=0, select=url_from, order_by=first_seen_link:desc`
2. запрос `limit=10, offset=10` с теми же параметрами
3. если наборы `url_from` не пересекаются и второй непустой → `"offset"`
4. если второй повторяет первый или отдал 400 → `"keyset"`

Итого ~100 юнитов, четверть цента. Результат клади в `SiteBacklinkSync.paginationMode`
и кэшируй по хосту на сутки, чтобы не платить за разведку каждый раз.

## Задача 2 — два способа листать

**offset** — тривиально: `limit=1000`, `offset += 1000`, пока страница не короче лимита.

**keyset** — на случай, если `offset` шлюзом не поддержан: сортируем по возрастанию
уникального поля и на каждой следующей странице ставим `where` «строго больше
последнего значения предыдущей». Для `all-backlinks` бери `url_from` как курсорное поле.
Если `where` по нему шлюз не принимает — падай на срезы по `first_seen_link`
помесячно и честно ставь `complete = false`, если срезы могли что-то потерять.

**Размер страницы — 1000, не меньше.** Минимальная цена любого запроса 50 юнитов,
поэтому страницы по 50 строк умножают счёт на пустом месте.

Соблюдай потолок «3 одновременных запроса на ключ» — семафор в `metrics.ts` уже есть,
не обходи его собственным `Promise.all`.

## Задача 3 — набор полей и цена

Ровно тот, что в разделе 5 `CONTRACT.md`, 20 полей по 1 юниту. Дополнительно:

- `history=all_time` — чтобы приезжали и потерянные ссылки с `is_lost`, `lost_reason`
- `aggregation=all` — нам нужны все ссылки, а не одна на домен
- `mode=subdomains`
- **никакого `traffic`, `traffic_domain`, `refdomains_source`**, в том числе в `where`
  и `order_by`: поля, названные там, биллятся, даже если не возвращаются

Перед стартом посчитай оценку через `estimateUnits` и **отдай её клиенту, не начиная
выгрузку**, если в запросе не было `confirm: true`. Считать цену надо от известного
объёма профиля: возьми `live` из `backlinks-stats` (один дешёвый запрос) и покажи
«≈ N ссылок, ≈ M юнитов, ≈ $X». Пользователь подтверждает — тогда стартуем.

## Задача 4 — запись

`siteBacklinkStore.ts`:

- `upsertFromApi(siteId, rows, opts)` — пишет **только группу `api*`** плюс `domainFrom`
  и добавляет `"api"` в `sources`. Не трогает `check*`, `pageStatus`, `favorite`, `note`
  (см. правило записи в разделе 1 контракта — это то, что делает три источника совместимыми)
- ключ строки — `(siteId, urlFromNorm, urlTo)`. `urlFrom` сохраняется как пришёл,
  `urlFromNorm` — нормализованный
- события в `SiteBacklinkEvent`: `appeared` для новой строки, `lost` при переходе
  `apiLost` false→true, `returned` при true→false, `anchor_changed` при смене `apiAnchor`
  у уже известной строки, `rel_downgraded` при переходе dofollow → любой из
  nofollow/sponsored/ugc (и `rel_upgraded` обратно)
- **потери берутся из поля `is_lost`, а не вычисляются как «не пришло в этой выгрузке»**.
  Это ключевое отличие от `syncRefDomains`: там локальный диф был единственным способом,
  здесь провайдер отвечает прямо

## Задача 5 — фоновая задача

`POST /api/backlinks/sync { siteId, confirm? }` → создаёт `SiteBacklinkSync`,
запускает выгрузку без `await` (как `/api/audit`), возвращает `{ id }`.
`GET /api/backlinks/sync?siteId=` → текущий и последние прогоны.

- одна выполняющаяся выгрузка на сайт: вторая попытка → 409 `already_running`
- `heartbeatAt` обновляй каждую страницу, `progress` считай от известного `live`
- `unitsSpent` накапливай **по факту успешных страниц**: неудачные ответы шлюз
  не тарифицирует, значит и мы не должны их считать
- при обрыве/ошибке `complete = false` и `status = "error"` с внятным `error`
- `complete = true` только когда дошли до конца без фильтров и без обрыва

Права: `workspaceUserId("spend")` — операция тратит деньги владельца.
Цель выгрузки бери **из строки сайта**, никогда из тела запроса, иначе эндпоинт
будет профилировать чужие домены за счёт владельца (так же сделано в
`/api/metrics/backlinks`, посмотри там комментарий).

## Критерии приёмки

- юнит-тесты (без сети) на: сборку query-строки, keyset-курсор, расчёт цены,
  маппинг строки API → поля `SiteBacklink`, генерацию событий при смене anchor/rel
- ручной прогон на реальном ключе: пул на 2 страницы, в БД появились строки,
  `unitsSpent` совпадает с расчётом, `paginationMode` определился
- повторный прогон не создаёт дублей и не обнуляет `check*`-поля
- `npm run check` проходит

## Не делай

- не трогай `metrics.ts`, `metricsStore.ts`, локали, `prisma/**`
- не удаляй и не меняй `/api/metrics/backlinks` — доменный профиль остаётся как есть
- не запускай выгрузку без подтверждения цены
- не ставь произвольный потолок строк «на всякий случай». Если нужен предохранитель,
  это должен быть подтверждаемый пользователем бюджет в юнитах, а не константа в коде

## i18n-ключи (создаёт T0, ты только используешь)

```
blsyncTitle          Full backlink export
blsyncStart          Export all backlinks
blsyncRunning        Exporting…
blsyncStagePull      fetching pages
blsyncStagePersist   saving
blsyncDone           Export finished
blsyncFailed         Export failed
blsyncRows           links
blsyncPages          pages fetched
blsyncUnits          units spent
blsyncEstimate       About {rows} links · {units} units · ≈ {usd}
blsyncConfirm        Start export
blsyncCancel         Cancel
blsyncPartial        Partial export — losses were not recorded from this run.
blsyncPartialHint    A run that could not see the whole profile cannot prove a link is gone.
blsyncAlreadyRunning An export is already running for this site.
blsyncLast           Last export
blsyncNever          never
blsyncModeOffset     paging by offset
blsyncModeKeyset     paging by cursor
```

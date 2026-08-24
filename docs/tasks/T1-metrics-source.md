# T1 — Источник данных в интерфейсе и честный учёт юнитов

Ветка: `feat/backlinks-t1-metrics-source`
Зависимостей нет, можно мержить первой.

## Проблема

Пользователь видит в блоке профиля ссылок надпись «5 000 юнитов ≈ $0.13» и больше
ничего. Новичок не понимает, **чей** это ключ, **куда** он ходит и **куда класть
деньги**, когда они кончатся. При ошибке он видит `blpFailed` — «не получилось», без
различия между «неверный ключ», «кончились юниты» и «шлюз лежит».

Плюс два дефекта учёта.

## Что прочитать

- `docs/tasks/CONTRACT.md`, разделы 5 и 6
- `src/lib/seo/metrics.ts` — `estimateUnits`, `AHREFS_PREMIUM_FIELDS`, `requestWithRetry`
- `src/lib/seo/metricsStore.ts` — `readUsage`, `recordUsage`, `releaseUnusedUnits`, `withinCap`
- `src/lib/seo/metricsClient.ts` — `getMetricsCreds`, `RESELLER_BASE_URL`
- `src/components/MetricsSettingsSection.tsx` — там уже хороший четырёхшаговый мастер
- `src/app/api/metrics/gap/route.ts` — образец правильного возврата юнитов при неудаче

## Файлы, которыми ты владеешь

`src/lib/seo/metrics.ts`, `src/lib/seo/metricsStore.ts`,
`src/components/MetricsSettingsSection.tsx`, `src/components/BacklinkProfile.tsx`,
`src/app/api/metrics/**` (включая новый `src/app/api/metrics/subscription/route.ts`).

## Задача 1 — бесплатный эндпоинт баланса

`/v3/subscription-info/limits-and-usage` стоит 0 юнитов и возвращает
`units_limit_api_key`, `units_usage_api_key`, `units_limit_workspace`,
`units_usage_workspace`, `usage_reset_date`, `api_key_expiration_date`.

Добавь в `metrics.ts` функцию `fetchSubscriptionInfo(creds)` и роут
`POST /api/metrics/subscription`, который её вызывает. Хост — из `getMetricsCreds`,
не хардкод. Ответ кэшируй на 10 минут в памяти процесса: он бесплатный, но
дёргать его на каждый рендер незачем.

Ошибку не глотай: 401 и 402 здесь диагностичнее всего, они должны доехать до UI
отдельными кодами.

## Задача 2 — плашка источника данных

В `BacklinkProfile.tsx`, над таблицей, всегда видимая строка:

> Источник: **Ahrefs API v3** · `ahrefs-api.groupbuyseo.org` (реселлерский ключ) ·
> обновлено 24.08 в 14:02 · осталось **37 600** из 50 000 юнитов · сброс 01.09 ·
> *Настроить*

Правила:

- режим (`официальный` / `реселлер` / `свой хост`) определяется тем же способом,
  что в `MetricsSettingsSection` — не изобретай второй
- «осталось» берётся из задачи 1. Если эндпоинт недоступен — покажи локальный
  расход из `ApiUsage` и явно скажи, что это наша оценка, а не баланс провайдера
  (`blsrcBalanceUnknown`)
- «Настроить» ведёт в настройки SEO-метрик
- ключа нет → не `no_key`, а: «Ключ Ahrefs не добавлен. Ссылки можно залить списком
  или CSV бесплатно, либо подключить Ahrefs» + ссылка в настройки

## Задача 3 — честные ошибки

Разведи коды в сообщениях (сейчас всё сваливается в `blpFailed`):

| Код | Смысл | Что показать |
|---|---|---|
| 401 | ключ отклонён хостом | назвать хост и подсказать, что реселлерский ключ на официальном хосте всегда даёт 401 |
| 402 | кончились юниты | назвать хост + прямая ссылка пополнить (`METRICS_GATEWAY_URL` уже есть в `SeoToolsSettings.tsx`) |
| 403 | продукт не подключён к ключу | сказать это прямо, не предлагать пополнение |
| 429 | лимит запросов | «слишком часто, попробуйте через минуту» |
| 502 | шлюз недоступен | «временная ошибка на стороне провайдера» |

400 не ретраить — это наша ошибка в `select`, повтор даст то же самое.

## Задача 4 — починить завышение расхода

`/api/metrics/backlinks/route.ts` вызывает `recordUsage()` **до** запроса и не
возвращает юниты при неудаче. Шлюз при этом за 4xx/5xx **не берёт ничего**.
Значит каждый 502 съедает у пользователя лимит, которого провайдер не списывал,
и при выставленном месячном потолке блокирует работу на ровном месте.

`releaseUnusedUnits()` в `metricsStore.ts` уже есть и уже используется в
`/api/metrics/gap` и `/api/seo/keyword-ideas`. Примени тот же приём здесь.
Пройдись по остальным роутам в `src/app/api/metrics/**` и `src/app/api/seo/**` —
где `recordUsage` есть, а возврата при ошибке нет, почини так же. Перечисли
в отчёте, что нашёл.

## Задача 5 — прайсинг полей

Два дефекта в `estimateUnits`:

1. Суффиксы `_prev` и `_merged` не срезаются перед поиском тарифа, поэтому
   `volume_prev` считается за 1 юнит вместо 10. Срезай перед сопоставлением.
2. `AHREFS_PREMIUM_FIELDS` покрывает три-четыре эндпоинта. Расширь таблицу
   по разделу 5 `CONTRACT.md` (тарифы 15 / 10 / 5 / 1), чтобы оценка не врала
   на эндпоинтах, которые добавят T3 и последующие задачи.

Существующую структуру `AHREFS_PREMIUM_FIELDS` (данные, а не магические числа)
сохрани — она правильная, её надо только наполнить.

## Критерии приёмки

- есть юнит-тест на `estimateUnits`: `volume_prev` даёт 10, поле в `where` биллится,
  поле, названное и в `select`, и в `order_by`, считается один раз, floor 50 работает
- в плашке видны провайдер, хост, режим, время обновления и остаток
- 401 / 402 / 403 дают три разных сообщения, 402 — со ссылкой на пополнение
- смоделированный 502 не увеличивает `ApiUsage`
- `npm run check` проходит

## Не делай

- не трогай `prisma/**`, `src/locales/**`, `src/app/site/[id]/page.tsx`
- не переписывай четырёхшаговый мастер в настройках, он хороший — только добавь
  в шаг 4 остаток и срок жизни ключа
- не кэшируй баланс дольше 10 минут и не сохраняй в БД

## i18n-ключи (создаёт T0, ты только используешь)

```
blsrcTitle              Data source
blsrcProvider           Provider
blsrcHostOfficial       official key
blsrcHostReseller       reseller key
blsrcHostCustom         custom host
blsrcUpdated            updated
blsrcRemaining          remaining
blsrcOf                 of
blsrcUnitsLeft          {n} units left
blsrcResetAt            resets on
blsrcKeyExpires         key expires
blsrcKeyExpiringSoon    This API key expires soon — renew it before your next pull.
blsrcBalanceUnknown     Provider balance unavailable — showing our own estimate.
blsrcConfigure          Configure
blsrcNoKey              No Ahrefs key connected.
blsrcNoKeyHint          You can still import links from a list or CSV for free, or connect Ahrefs in Settings.
blsrcErr401             The key was rejected by {host}. A reseller key always returns 401 on the official host — check that the key matches the selected mode.
blsrcErr402             Out of units at {host}.
blsrcErr403             This API product is not enabled for your key.
blsrcErr429             Too many requests — try again in a minute.
blsrcErr502             The data provider is temporarily unavailable.
blsrcTopUp              Top up
```

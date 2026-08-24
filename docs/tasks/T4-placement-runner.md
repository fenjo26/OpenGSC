# T4 — Фоновая проверка размещений

Ветка: `feat/backlinks-t4-placement-runner`
Код пиши сразу; запустить получится после T0 и T2.

## Задача

Взять список страниц-доноров сайта и по каждой ответить: **стоит ли на ней наша
ссылка прямо сейчас**, с каким анкором и с каким `rel`. Это не то же самое, что
существующий `check-alive`, который отвечает лишь «страница отдаёт 200». Донор жив,
ссылку сняли — сегодня это выглядит как зелёная галочка.

Чистый разбор HTML делает T2 (`src/lib/seo/linkPlacement.ts`). Твоя задача — всё
вокруг: загрузка, конкурентность, вежливость, статусы, запись, прогресс.

## Что прочитать

- `docs/tasks/CONTRACT.md`, разделы 0, 1, 2, 3
- `docs/tasks/T2-placement-core.md` — сигнатуры, которые ты вызываешь
- `src/app/api/backlinks/check-alive/route.ts` — **образец того, как здесь принято
  различать три исхода**; прочитай комментарий в шапке целиком
- `src/lib/audit/crawler.ts` — конкурентность 4, задержка вежливости 150 мс, heartbeat
- `src/lib/security/safeFetch.ts` — интерфейс опций

## Файлы, которыми ты владеешь

- `src/lib/seo/placementRunner.ts` (создать)
- `src/app/api/backlinks/verify/route.ts` (создать)
- `src/lib/security/safeFetch.ts` (правишь — см. задачу 3)

## Задача 1 — три исхода, а не два

Это главное требование. `403` и `429` от Cloudflare — **не** «ссылки нет».

| Ситуация | `checkStatus` | `pageStatus` |
|---|---|---|
| страница открылась, наша ссылка найдена | `found` | `alive` |
| страница открылась, ссылки нет | `missing` | `alive` |
| 401 / 403 / 429 — WAF не пустил | `blocked` | `blocked` |
| 404 / 410 — страницы больше нет | `missing` | `dead` |
| все попытки упали (сеть, DNS, таймаут) | `blocked` | `unknown` |
| не-HTML ответ | `error` | `alive` |

`missing` при `pageStatus = alive` — это и есть сигнал «кинули», единственный, ради
которого всё делается. Ложный `missing` из-за WAF отправит клиента скандалить
с площадкой из-за нашего юзер-агента. Никогда не сваливай `blocked` в `missing`.

`404` — особый случай: страница мертва, значит ссылки на ней нет по факту, но причина
другая. Пометь `missing` + `dead`, чтобы в интерфейсе это читалось как «страницу снесли»,
а не «ссылку убрали».

Ретраить только переходное: 429, 408, 5xx, сетевые сбои. Твёрдый 404 не переспрашивать.
Возьми ту же схему попыток и бэкоффа, что в `check-alive`.

## Задача 2 — вежливость

CLI-эталон, из которого мы берём логику, гоняет 8 воркеров без рейт-лимитера и без
`robots.txt`, и его автор честно пишет «если список на одном домене — ставь меньше».
В продукте пользователь этого не сделает никогда.

- конкурентность 4 (как в `src/lib/audit/crawler.ts`)
- задержка 150 мс на воркер между запросами
- **последовательность по хосту**: два URL одного донора не грузятся одновременно;
  сгруппируй очередь по хосту, чтобы список из ста страниц одной площадки не выглядел
  как атака
- User-Agent в том же стиле, что уже используется: `OpenGSC-...`

## Задача 3 — `--insecure` для протухших сертификатов

У мелких доноров сертификаты просрочены сплошь и рядом. `safeFetch` жёстко ставит
`rejectUnauthorized: true`.

Добавь в `SafeFetchOptions` поле `allowInsecureTls?: boolean` (по умолчанию `false`).
Работает **только** вместе с уже существующими защитами: проверка приватных адресов
не отключается, это отдельная и не связанная гарантия.

Дальше: пробуй сначала обычным способом; **только** если запрос упал именно на TLS
и вызывающий передал флаг — повтори с отключённой проверкой и пометь строку
`checkInsecure = true`. В интерфейсе такие строки должны быть видимо помечены —
контент, полученный так, не аутентифицирован.

Не делай флаг глобальной настройкой инстанса. Это параметр прогона.

В `src/lib/security/safeFetch.test.ts` есть тесты — не сломай их; файл теста не твой,
но если понадобится добавить кейс, опиши это в отчёте.

## Задача 4 — запись результата

Пиши **только группу `check*`** плюс `pageStatus`, `pageTitle`, `pageCheckedAt`.
Не трогай `api*`, `favorite`, `note`, `urlTo` (раздел 1 контракта).

- нашли несколько ссылок с одного донора — лучшая идёт в поля строки
  (приоритет: совпадение с обещанным `urlTo` → dofollow → первая по порядку),
  а `checkTargetOk` считается относительно `urlTo`, когда он заполнен
- `checkTargetOk = null`, если `urlTo` пуст: сверять не с чем
- события в `SiteBacklinkEvent` с `origin = "check"`: переход `found → missing`
  даёт `lost`, `missing → found` даёт `returned`, смена анкора — `anchor_changed`,
  переход dofollow → nofollow/sponsored/ugc — `rel_downgraded`
- **`blocked` и `error` не порождают событий**. Мы не знаем, что произошло,
  а событие — это утверждение

## Задача 5 — задача и API

`POST /api/backlinks/verify { siteId, ids?, filter?, allowInsecureTls?, useRender? }`
→ создаёт `SiteBacklinkSync` с `kind = "verify"`, запускает без `await`, отдаёт `{ id }`.
`GET /api/backlinks/verify?siteId=` → статус.

- **никаких `take: 200`.** Существующий `check-alive` молча проверяет первые 200 строк,
  и кнопка «проверить все» врёт. Здесь очередь идёт по всей выборке, прогресс виден,
  пользователь может закрыть вкладку
- `ids` — конкретные строки; `filter` — «все», «только пропавшие», «только избранные»,
  «непроверенные». Массовое действие должно работать **по фильтру**, а не по галочкам
  на видимой странице
- права: `workspaceUserId("act")` — денег не тратит, свой HTTP
- в конце сложи `SyncSummary` (раздел 2 контракта) в `SiteBacklinkSync.summary`:
  сколько просканировано, у скольких ссылка есть, у скольких ноль, сколько ошибок,
  разбивка по доменам и по типам ошибок. Этот же формат читает дайджест (T6)

## Задача 6 — JS-подстановка, честно

Сырой HTML не увидит ссылку, которую вставляет JavaScript. Врать про это нельзя.

Если у строки `apiJsCrawl = true` (Ahrefs нашёл ссылку только через JS-рендер),
а наша проверка дала `missing` — это **не** «кинули». Не переписывай `checkStatus`,
но верни этот случай отдельно в `SyncSummary` и дай интерфейсу основание показать
подсказку (`blchkJsHint`).

Опциональная перепроверка с рендером: в `src/lib/seo/googlebot.ts` есть
`renderWithFirecrawl`. Сделай её **опциональной, по флагу `useRender`, платной,
по одной строке** — не в массовом прогоне. Если делать не успеваешь, оставь
точку расширения и напиши в отчёте.

## Критерии приёмки

- юнит-тесты (без сети) на: маппинг HTTP-статуса в пару `checkStatus`/`pageStatus`,
  выбор лучшей ссылки из нескольких, генерацию событий, группировку очереди по хосту
- 403 никогда не даёт `missing` — отдельный тест
- прогон на списке из 20 реальных доноров: все обработаны, ни одного `take`-обрыва
- `npm run check` проходит

## Не делай

- не реализуй заново разбор HTML — это T2, импортируй
- не трогай `src/app/api/backlinks/check-alive/route.ts` и `check-xr` — они продолжают работать
- не трогай `src/app/site/[id]/page.tsx` (T5), локали (T0), `prisma/**` (T0)
- не отключай проверку приватных адресов в `safeFetch` ни при каких флагах
- не игнорируй `robots.txt` молча: если решишь его не читать (это допустимо —
  пользователь проверяет страницы, которые сам оплатил), напиши это в отчёте
  как осознанное решение

## i18n-ключи (создаёт T0, ты только используешь)

```
blchkTitle           Placement check
blchkRun             Check placements
blchkRunning         Checking…
blchkFound           link present
blchkMissing         link gone
blchkBlocked         blocked by the site
blchkError           check failed
blchkUnchecked       not checked
blchkAnchor          Anchor
blchkRel             rel
blchkTargetMismatch  points to a different page than agreed
blchkJsHint          Ahrefs sees this link only after JavaScript runs, so a raw-HTML check cannot confirm it. This is not a removed link.
blchkInsecure        certificate not verified
blchkInsecureWarn    This page was fetched without verifying its TLS certificate — treat the content accordingly.
blchkAllowInsecure   Retry TLS failures without certificate verification
blchkOnlyMissing     Only missing
blchkOnlyFavorites   Only favourites
blchkOnlyUnchecked   Only unchecked
blchkLastCheck       last checked
blchkSummary         {scanned} scanned · {withLink} with our link · {zero} without · {errors} failed
blchkBlockedHint     A 403 or 429 means the site refused our request, not that the link was removed.
```

# T0 — Фундамент: схема, миграция, типы, локали

Ветка: `feat/backlinks-t0-foundation`

Ты создаёшь контракт физически. Шесть других сессий уже пишут код против имён
из `CONTRACT.md`, поэтому **имена и типы копируй буквально**. Если видишь в контракте
ошибку — не исправляй молча, сделай как написано и опиши проблему в отчёте.

## Что прочитать сначала

- `docs/tasks/CONTRACT.md` — целиком, это твоё ТЗ по содержанию
- `docs/tasks/README.md` — правила владения файлами
- `prisma/schema.prisma`, модели `Backlink` (строка ~324), `RefDomainRow`, `LinkMention` —
  чтобы попасть в стиль
- `prisma/migrations/20260806160000_add_gateway_field_support/migration.sql` — образец
  того, как в этом репозитории пишется миграция руками

## Файлы, которыми ты владеешь

- `prisma/schema.prisma`
- `prisma/schema.mysql.prisma`
- `prisma/migrations/20260825120000_add_site_backlinks/migration.sql` (создать)
- `src/lib/seo/backlinkTypes.ts` (создать)
- `src/locales/en.json`, `ru.json`, `uk.json`, `fr.json`, `es.json`, `de.json`, `zh.json`

Больше ничего не трогай.

## Задача 1 — модели

Добавь `SiteBacklink`, `SiteBacklinkEvent`, `SiteBacklinkSync` из раздела 1
`CONTRACT.md` в **оба** schema-файла, и обратную связь `siteBacklinks SiteBacklink[]`
в модель `Site` тоже в обоих.

В `schema.mysql.prisma`: поля, входящие в `@@unique` и `@@index`, объяви как
`@db.VarChar(500)` — MySQL не строит индекс по `TEXT`. Это касается `urlFrom`,
`urlFromNorm`, `urlTo`, `domainFrom`. Посмотри, как это сделано у существующих
моделей в этом файле, и повтори тот же приём.

Прокомментируй каждую группу полей так же, как прокомментированы существующие модели
в этом репозитории: не «что это за поле», а **почему оно такое**. В частности обязательно
объясни в комментарии над `pageStatus` и `checkStatus`, почему их два и что их
смешивание — это ровно тот баг, ради которого всё затевалось (раздел 0 контракта).

## Задача 2 — миграция

Файл `prisma/migrations/20260825120000_add_site_backlinks/migration.sql`, руками,
в стиле образца. Три `CREATE TABLE` + индексы + один перенос данных.

**Перенос данных из старой модели `Backlink`.** Копируй `url → urlFrom`,
нормализованный `url → urlFromNorm`, `title → pageTitle`, `addedAt → addedAt`,
`xrStatus`, `xrChecked → xrCheckedAt`, `twoIndexStatus`, `twoIndexAt`,
`source = 'manual'`, `sources = 'manual'`.

Старый статус живучести переносится в `pageStatus`, а не в `checkStatus`:

```
aliveStatus = 'alive'   → pageStatus = 'alive'
aliveStatus = 'dead'    → pageStatus = 'dead'
aliveStatus = 'blocked' → pageStatus = 'blocked'
иначе, если isAlive = 1  → pageStatus = 'alive'
иначе, если isAlive = 0  → pageStatus = 'dead'
иначе                    → pageStatus = 'unknown'
```

`checkStatus` у **всех** перенесённых строк = `'unchecked'`. Это принципиально:
старая проверка отвечала на вопрос «страница отвечает», а не «ссылка стоит».
Пометить их `found` значило бы объявить проверенным то, что никогда не проверялось.

`urlFromNorm` в SQL сделай минимально: нижний регистр, срезанный `#fragment`,
срезанный `http(s)://`, срезанный ведущий `www.`, срезанный хвостовой `/`.
Точная нормализация живёт в TypeScript (T2/T3) — SQL нужен лишь настолько, чтобы
`@@unique` не падал на дублях. Если в SQLite это выходит слишком громоздко —
допустимо перенести `urlFrom` как есть в `urlFromNorm` и оставить `-- TODO` с
объяснением; напиши об этом в отчёте.

Старую таблицу `Backlink` **не удаляй и не переименовывай**. Она продолжает работать.

## Задача 3 — общие типы

Создай `src/lib/seo/backlinkTypes.ts` ровно по разделу 2 `CONTRACT.md`. Только типы,
никакой логики, никаких импортов из Prisma — файл должны импортировать и клиентские
компоненты тоже.

## Задача 4 — i18n

Собери списки ключей из шести файлов `docs/tasks/T1…T6-*.md` (в каждом есть раздел
«i18n-ключи» с именем ключа и английским текстом) и добавь их **во все семь локалей**.

- `en` — текст из ТЗ как есть
- `ru` — нормальный русский перевод, это основной язык владельца продукта
- `uk`, `fr`, `es`, `de`, `zh` — перевод; смотри на соседние ключи в этих файлах,
  чтобы попасть в терминологию, которая там уже принята (например, как уже переведены
  `backlinksTitle`, `blpRefDomains`, `metricsUnits`)

Ключи добавляй в конец каждого файла, в том же порядке во всех семи, сгруппировав
по префиксу с пустой строкой между группами — тогда следующий merge будет читаемым.

## Критерии приёмки

- `npm run check:i18n` → «All 7 locale files have identical key sets»
- `npx prisma validate` проходит на `schema.prisma`
- `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "file:./shadow.db"` не показывает расхождений
  (если команда недоступна — примени миграцию на копию `prisma/dev.db` и убедись,
  что таблицы созданы и перенос отработал; **не трогай оригинальный `dev.db`**)
- `npx tsc -p tsconfig.json --noEmit` — новых ошибок нет
  (`src/lib/scanner/exportMd.ts:103` TS2352 — пре-existing, не твоя)
- количество строк в `SiteBacklink` после миграции равно количеству строк
  в `Backlink` — проверь запросом и приведи числа в отчёте

## Не делай

- Не запускай `prisma migrate dev` — он создаст папку с другим таймстемпом
- Не меняй `Backlink`, `RefDomainRow`, `BacklinkSnapshot`
- Не пиши никакой логики приложения — только схема, миграция, типы, локали

## i18n-ключи самого T0

Нет. Свои ключи ты не добавляешь, только чужие.

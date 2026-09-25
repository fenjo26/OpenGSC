# N0 — Фундамент волны «Ноябрь»

**Ветка:** прямо в `feat/wave-nov` (worktree `.worktrees/nov-n0`). Идёшь первым и один.
Прочитай `README.md`, `CONTRACT.md` и **все одиннадцать брифов** (из них ты собираешь i18n-ключи).

Перед началом сохрани базу: `npx tsc -p tsconfig.json --noEmit` и `npx eslint` по файлам,
которые будешь менять.

## 1. Схема
Всё из `CONTRACT.md` §1. Обрати внимание на замену `@@unique` у `TrackedKeyword`: старое
ограничение удаляется, новое добавляется с `location`. У существующих строк `location = ""`,
поэтому конфликта данных нет. Проверь на копии базы Руслана:
`cp ../../dev.db /tmp/n0.db && DATABASE_URL="file:/tmp/n0.db" npx prisma db push` —
push должен пройти **без** `--accept-data-loss`. Если он просит этот флаг — стоп, опиши в
отчёте, какую таблицу он хочет пересоздать.

## 2. Типы
`src/lib/notify/types.ts` — изменения из `CONTRACT.md` §2. Проверь, что тест
`src/lib/notify/types.test.ts` не сломался (в `NOTIFY_EVENTS` по-прежнему нет `"test"`).
`webpush` в `NotifyChannelId` сломает исчерпывающие `switch` в `src/lib/notify/**` — добавь
в них ветку `case "webpush": return { channel: "webpush", ok: false, error: "not_implemented" }`
(или эквивалент, минимально). Дальше эти файлы принадлежат N10.

## 3. Заглушки
Всё из `CONTRACT.md` §3: модули-маркеры, страницы, компоненты, планировщики, MCP-массивы,
пустые тесты `test("placeholder (Nx)", () => {})` в каждой папке с глобом.
`extension/manifest.json`: `{ "manifest_version": 3, "name": "OpenGSC", "version": "0.0.1" }`.

## 4. Меню, Settings, планировщики, MCP, proxy
- `DashboardShell.tsx`, `settings/page.tsx`, `instrumentation.ts`, `tools.ts` — по §3 контракта.
- `src/proxy.ts` — публичные префиксы из §4 контракта в функции `authorized`, рядом с `/share/`,
  с комментарием на каждый: кто его проверяет вместо сессии.
- `DashboardShell.tsx` оборачивает всё приложение (корневой `layout.tsx`). Найди, как в нём
  выключается оболочка для `/login`, `/share/` и `/join`, и добавь туда `/embed/` и
  `/share/report/`: виджет и клиентский отчёт открываются без меню приложения.
- `next.config.ts`: если там глобально стоит `X-Frame-Options` или
  `Content-Security-Policy: frame-ancestors`, для `/embed/:path*` сделай отдельное правило без
  запрета встраивания. Если ничего такого нет — ничего не меняй и напиши об этом в отчёте.

## 5. Зависимости — только в основной папке
```bash
cd ~/Downloads/opengsc && npm i web-push && npm i -D @types/web-push
```
Потом скопируй изменённые `package.json` и `package-lock.json` в свой worktree и закоммить.
Убедись, что `.worktrees/nov-n0/node_modules` — симлинк (`ls -la`), а не папка.

## 6. Тесты
Глобы из `CONTRACT.md` §3 — в конец `test:unit`. Проверь, что число тестов выросло.

## 7. Локали и шаблоны
- Собери таблицы «ключ · en · ru» из конца каждого брифа N1…N11 и создай ключи во всех
  семи локалях (uk, fr, es, de, zh переводишь сам). Нашёл дубль ключа между брифами — оставь
  один и напиши в отчёте.
- `notifyI18n.ts` — поля из `CONTRACT.md` §5 во все семь языков.
- `npm run check:i18n` зелёный. Динамические ключи (`…_${code}`) — как в октябре.

## Проверка
```bash
npx prisma validate && npx prisma generate
npm run check
npx tsc -p tsconfig.json --noEmit
npx eslint <все созданные и тронутые файлы>
```
`npm run dev`: в меню четыре новых пункта, у каждого страница-заглушка; в Settings четыре новые
карточки; консоль сервера без ошибок, четыре новых планировщика стартуют.

## Коммит
`feat(wave-nov): foundation — schema, stubs, nav, public routes, i18n, notify templates, web-push dep`
Сообщи хеш — от него стартуют N1…N11.

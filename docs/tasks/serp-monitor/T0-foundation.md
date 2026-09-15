# T0 — Фундамент

**Ветка:** работаешь прямо в `feat/serp-monitor` (worktree `.worktrees/serpmon-t0`).
**Идёшь первым и один.** T1…T6 ветвятся от твоего коммита, поэтому всё, что ниже, должно
быть в одном коммите (или нескольких, но запушенных до старта остальных).

Прочитай `README.md` и `CONTRACT.md` целиком.

## Что сделать

### 1. Схема
Вставь все модели из `CONTRACT.md` §1 в конец `prisma/schema.prisma` дословно.
`prisma/schema.mysql.prisma` не трогай (генерируется). Миграцию не пиши.
Проверка: `npx prisma validate` и `npx prisma generate` в своём worktree.

### 2. Типы
`src/lib/serpmon/types.ts` — дословно из `CONTRACT.md` §2. Файл чистый: никаких импортов
сервера, его импортируют клиентские компоненты.

`src/lib/serpmon/types.test.ts` (`node:test` + `node:assert/strict`, как соседние тесты):
- `SERPMON_DEPTHS` по возрастанию, последний = 100;
- последняя полоса `MOVE_THRESHOLDS` покрывает 100, полосы по возрастанию `upTo`;
- все `DEFAULT_PLATFORM_HOSTS` в нижнем регистре, без `www.`, без схемы и пробелов, без дублей;
- `STORM_MIN_BASELINE ≤ STORM_BASELINE_RUNS`.

### 3. Заглушки
Создай каждый файл из `CONTRACT.md` §3 с точными экспортами (типы импортируй из `types.ts`),
тела — `throw new Error("serpmon: <fn> not implemented (Tn)")`:

| Файл | Для кого |
|---|---|
| `src/lib/serpmon/hosts.ts`, `noise.ts`, `diff.ts`, `volatility.ts` | T2 |
| `src/lib/seo/aparserSerp.ts`, `src/lib/seo/aparserServerCreds.ts` | T1 |
| `src/lib/serpmon/keywords.ts`, `store.ts`, `collector.ts` | T3 |
| `src/lib/serpmon/scheduler.ts` | T3 — **исключение:** `startSerpmonScheduler` и `kickSerpmonScheduler` — пустые функции, не `throw`: их вызывает `instrumentation.ts` при старте сервера |
| `src/lib/serpmon/enrich.ts`, `domains.ts` | T4 |
| `src/lib/serpmon/alerts.ts` | T6 |

`APARSER_SERP_OPTION_IDS` в заглушке — `{ pagecount: "pagecount" }`.
Расширения `SerpOptions`/`SerpResponse` в `serp.ts` **не делай** — это T1.

### 4. Регистрация тестов
В `package.json` допиши в **конец** строки `test:unit` через пробел: `src/lib/serpmon/*.test.ts`
(без кавычек — раскрывает `sh`, файл-совпадение гарантирует `types.test.ts`). Ничего не
переставляй. Проверь, что `npm run test:unit` действительно запускает `types.test.ts`
(в выводе должно быть его имя или число тестов выросло на твои).

### 5. Планировщик
В `src/instrumentation.ts` после блока drops:
```ts
    // SERP Monitor: resumes running checks, starts scheduled ones, then enriches new hosts.
    // A-Parser only, so no per-request bill; idle ticks are one indexed query.
    const { startSerpmonScheduler } = await import('@/lib/serpmon/scheduler');
    startSerpmonScheduler();
```

### 6. Меню
`src/components/DashboardShell.tsx`: пункт сразу после `/drops`:
`{ href: "/serp-monitor", label: t("serpmonNavTitle"), key: "serpmon", icon: <Waves size={14} /> }`
(`Waves` из `lucide-react`; если в установленной версии нет — `Activity`, напиши об этом).
Цвет пункта — по образцу `drops`, любой свободный акцент (например бирюзовый
`var(--color-accent-teal, #30b0c7)`).

Пункт виден всегда, не только при настроенном A-Parser: страница сама объясняет, что нужно.

### 7. Страница-заглушка
`src/app/serp-monitor/page.tsx` — клиентский компонент с заголовком `serpmonTitle`,
подзаголовком `serpmonSubtitle` и текстом `serpmonEmpty`. T5 перепишет.

### 8. Локали
Все ключи из `CONTRACT.md` §7 — во все 7 файлов (`en ru uk fr es de zh`). en и ru — дословно
из таблицы, остальные пять — переведи сам, коротко, в тоне соседних ключей. Формат
плейсхолдеров сверь с существующими (`{n}`), имена плейсхолдеров не переводить.
Ключи `serpmonProblem_*` используются динамически (`t(\`serpmonProblem_${code}\`)`) — проверь,
что `scripts/check-keys.js` не считает их «неиспользуемыми»; если считает — напиши в отчёте,
как он устроен, и не меняй скрипт.

### 9. Документация
`docs/SERP-MONITOR.md` — заглушка из одного абзаца (что это и ссылка на
`docs/tasks/serp-monitor/`). T6 напишет полностью.

## Проверка
```bash
npx prisma validate && npx prisma generate
npm run check
npx eslint src/lib/serpmon src/lib/seo/aparserSerp.ts src/lib/seo/aparserServerCreds.ts src/app/serp-monitor src/instrumentation.ts
npx tsc -p tsconfig.json --noEmit          # ошибок не больше базы
```
`DashboardShell.tsx` уже содержит ошибки линта — сравни число до и после, новых быть не должно.

## Коммит
Один коммит в `feat/serp-monitor`:
`feat(serp-monitor): foundation — schema, shared types, stubs, i18n keys, nav entry`
Сообщи хеш: от него стартуют T1…T6.

# Волна «Октябрь»: мониторинг, индексация, видимость, аудит, мета-теги

Ветка интеграции: **`feat/wave-oct`** (создаётся от `main`). Всё, что описано здесь,
сначала вливается в неё. Руслан тестирует ветку целиком и только потом вливает её в `main`.

Этот README написан для агентов-исполнителей. Прочитай его целиком, потом `CONTRACT.md`,
потом бриф своей задачи. Правила из раздела «Правила, которые нельзя нарушать» действуют для
всех задач без исключений.

---

## 1. Что строим и зачем

Восемь задач. T0 — фундамент, T1…T7 — фичи, которые идут параллельно.

| # | Задача | Проблема пользователя | Результат |
|---|---|---|---|
| T1 | **Подгонка мета-тегов** | Сгенерированные title 66–80 символов, description до 181. Аудит красит сайты в красный. На проде 40 таких страниц за 10 дней | Title и description гарантированно попадают в границы аудита. Уже сгенерированные тексты можно пересчитать |
| T2 | **Аптайм-монитор** | Про упавший сайт узнаёшь от клиента или по просевшему трафику | Точка статуса на дашборде, упавшие сайты поднимаются наверх, фильтр по статусу, алерт «упал / поднялся», история инцидентов |
| T3 | **Каналы уведомлений** | Уведомления уходят только в Telegram и Slack | Discord, Microsoft Teams, e-mail (SMTP), универсальный webhook. У каждого канала свой фильтр типов событий |
| T4 | **Автопроверка индексации** | Индексация проверяется платными сервисами (XMLRiver и др.), а бесплатный Google URL Inspection запускается только кнопкой | Планировщик сам тратит бесплатную квоту Google (до 2000 URL в день на ресурс) по приоритетной очереди. Покрытие по дням, алерт о выпадении страниц из индекса |
| T5 | **Пакет правил аудита** | Аудит не проверяет hreflang, соответствие страницы её запросу, реальную скорость, мобильный viewport | Новые правила в реестре, PageSpeed по выборке шаблонов, кнопка «подобрать мету» у проблем с title и description |
| T6 | **Упоминания бренда** | Не видно, где бренд упоминают в новостях и в Википедии | Google News RSS и Wikipedia/Wikidata ежедневно. Лента упоминаний, проверка «есть ли ссылка», отправка в Outreach |
| T7 | **Доля голоса в ИИ** | AEO-трекер отвечает «процитирован / нет» и ничего не говорит о конкурентах | Share of voice против конкурентов, рейтинг доменов, которые цитирует ИИ, вопросы из GSC, движок Gemini. Всё, кроме Gemini, считается по уже сохранённым ответам |

Вкладка сайта **«AI Visibility» переименовывается в «Видимость»** (ключ вкладки `aeo`
остаётся для совместимости deep-link) и получает подвкладки. Хаб делает T0, наполнение делают
T6 и T7.

### Почему именно это и чего здесь нет

Разбор всех присланных репозиториев с решениями — в `BACKLOG.md`. Коротко:

- **SEO-OPTIMIZER** (`sarvdnya4979`) — кода нет, только README и zip с `.exe`. Так
  распространяют вредоносные программы. Не скачивать и не запускать (см. `docs/PRODUCT-ROADMAP.md` §3.4).
  Проверки, которые он обещает, у нас уже есть: meta, битые ссылки, viewport, скорость. Чего
  не хватало, добавляет T5.
- **google-index-checker** использует тот же URL Inspection API, который в OpenGSC уже есть
  (`/api/indexing/sitemap/check-google`). Новое здесь не API, а автоматизация — это T4.
- **elmo**: share of voice и рейтинг цитируемых доменов строятся из `AeoCheck.answerText` и
  `AeoCheck.citations`. Эти поля уже заполняются — это T7.
- **tkawen-automation**: из него берём аптайм (T2), News RSS и Wikipedia (T6).
  `ai-citation-watcher` у нас уже есть — это AEO-трекер.
- **All-In-One-Free-SEO-Tool**: из интеграций берём Discord, Teams, SMTP и webhook (T3).
  Slack уже есть. Остальное (Local SEO, disavow, отчёты, виджет, PWA, расширение) — в `BACKLOG.md`.
- **DispatchSEO** — AGPL, по `PRODUCT-ROADMAP.md` §3.4 берём только идеи. Trend radar — в бэклоге.
- **beyondseo** почти целиком пересекается с GEO-аудитом. Брать нечего, кроме принципа
  «неизвестное не превращается в оценку», а он у нас уже действует (§3.3 roadmap).

---

## 2. Порядок работ

```
T0 (один) ──► T1 T2 T3 T4 T5 T6 T7 (параллельно) ──► R (ревью и сборка) ──► тест Руслана ──► main
```

1. **T0** делает фундамент и коммитит **прямо в `feat/wave-oct`**. Пока коммита T0 нет,
   остальные задачи не стартуют: они ответвляются от него.
2. **T1…T7** — каждая в своей ветке `feat/wave-oct-tN` от `feat/wave-oct` и в своём worktree.
3. **R** вливает ветки в порядке **T1 → T3 → T2 → T4 → T5 → T6 → T7**: сначала независимое,
   потом доставка уведомлений, потом всё, что уведомляет.
4. Руслан тестирует по разделу 8.
5. `feat/wave-oct` → `main` одним merge-коммитом.

| # | Бриф | Зависит от |
|---|---|---|
| T0 | `T0-foundation.md` | — |
| T1 | `T1-meta-fit.md` | T0 |
| T2 | `T2-uptime.md` | T0. От T3 нужна только сигнатура `notifyUser`, она уже есть в контракте |
| T3 | `T3-notify-channels.md` | T0 |
| T4 | `T4-index-autocheck.md` | T0 |
| T5 | `T5-audit-rules.md` | T0. От T1 — только маршрут `/api/seo/meta-fit` из контракта |
| T6 | `T6-mentions.md` | T0 |
| T7 | `T7-ai-share-of-voice.md` | T0 |
| R | `R-review.md` | все |

Задачи пишут код против сигнатур из `CONTRACT.md`. T0 кладёт заглушки с этими сигнатурами,
поэтому на каждой ветке `tsc` зелёный с первого коммита, а поведение появляется после сборки.

**Сколько агентов нужно.** Если параллельных сессий меньше семи, объединяй так:
T1 отдельно (срочный баг); T2+T3; T4 отдельно; T5 отдельно; T6+T7. Внутри пары владение
файлами не меняется, это просто одна сессия с двумя брифами.

---

## 3. Worktree — только из терминала Мака

Все сессии работают в одном клоне `~/Downloads/opengsc`. `git checkout -b` там запрещён:
он выдернет ветку из-под соседей. У каждой задачи свой worktree.

> **Не создавай worktree из песочницы Cowork (VM).** Git запишет в `.git/worktrees/<имя>/`
> абсолютный путь той машины, где выполнена команда, то есть `/sessions/…`. На Маке такого пути
> нет, и worktree окажется сломан. Команды ниже выполняются в терминале Мака.

```bash
cd ~/Downloads/opengsc

# один раз: ветка интеграции (если её ещё нет — она уже содержит эти документы)
git fetch origin
git worktree add .worktrees/wave-t0 feat/wave-oct

# T1…T7 — ТОЛЬКО после коммита T0
git worktree add .worktrees/wave-t1 -b feat/wave-oct-t1 feat/wave-oct
# …то же для t2…t7

# в каждом worktree:
ln -sfn ../../node_modules .worktrees/wave-tN/node_modules    # 1.7 ГБ, не копировать
cd .worktrees/wave-tN && npx prisma generate                   # свой клиент — схема уже с моделями T0
```

`src/generated` **не** симлинкать на основной клон: после T0 схема в worktree новее.
`.worktrees/` нет в `.gitignore`, поэтому `git add` делай только для своих файлов.
Уборка после сборки: `git worktree remove .worktrees/wave-tN`.

Если агент работает там, где `prisma generate` невозможен (нет бинарника движка), гоняй
узкий `tsc` и докладывай ошибки по категориям. Ожидаемы только `TS2339 Property '…' does not
exist on type 'PrismaClient'` и каскад `TS7006` от них.

---

## 4. Владение файлами — жёсткое

Файл правит **только** задача из правой колонки. Если нужна правка в чужом файле — не делай её,
а опиши в отчёте.

| Файл | Владеет |
|---|---|
| `prisma/schema.prisma` | T0 |
| `src/locales/*.json` (все 7) | **T0 и только T0** |
| `src/lib/notifyI18n.ts` | **T0 и только T0** (все шаблоны уведомлений всех задач) |
| `package.json`, `package-lock.json` | T0 |
| `src/instrumentation.ts` | T0 |
| `src/lib/seo/metaLimits.ts` | T0 (константы и типы; дальше не меняется) |
| `src/lib/{uptime,notify,indexing,mentions,visibility}/types.ts` | T0 (дальше не меняются) |
| `src/components/VisibilityHub.tsx` | T0 |
| `src/lib/mcp/tools.ts` | T0 — строки import и `MCP_TOOLS`; **T4** — только тело обработчика `inspect_url` (учёт квоты) |
| `src/app/site/[id]/page.tsx` | T0 — ровно три точки вставки (раздел 3 брифа T0). Больше никто |
| `src/lib/seo/metaFit.ts`, `src/lib/seo/metaFit.test.ts`, `src/lib/seo/generate.ts`, `src/lib/seo/prompts.ts`, `src/lib/seo/rewrite.ts`, `src/lib/seo/rewriteBatch.ts`, `src/components/SeoTextDetail.tsx`, `src/app/api/seo/meta-fit/**`, `src/lib/mcp/toolsMeta.ts` | T1 |
| `src/lib/uptime/**` (кроме `types.ts`), `src/components/uptime/**`, `src/app/api/uptime/**`, `src/app/page.tsx`, `src/lib/mcp/toolsUptime.ts`, `docs/UPTIME.md` | T2 |
| `src/lib/notify.ts`, `src/lib/notify/**` (кроме `types.ts`), `src/app/api/settings/notify-channels/**`, `src/components/NotifyChannelsCard.tsx`, `src/app/settings/page.tsx`, `docs/NOTIFICATIONS.md` | T3 |
| `src/lib/indexing/**` (кроме `types.ts`), `src/components/IndexAutoPanel.tsx`, `src/app/api/indexing/auto/**`, `src/app/api/indexing/sitemap/check-google/route.ts`, `src/lib/mcp/toolsIndex.ts`, `docs/INDEX-AUTOCHECK.md` | T4 |
| `src/lib/audit/**`, `src/components/SiteAuditPanel.tsx`, `src/app/api/audit/**` | T5 |
| `src/lib/mentions/**` (кроме `types.ts`), `src/components/visibility/MentionsPanel.tsx`, `src/app/api/mentions/**`, `src/lib/mcp/toolsMentions.ts` | T6 |
| `src/lib/visibility/**` (кроме `types.ts`), `src/lib/seo/aeo.ts`, `src/lib/aeoTracker.ts`, `src/lib/aeoScheduler.ts`, `src/components/AeoTracker.tsx`, `src/components/visibility/AiShareOfVoice.tsx`, `src/components/visibility/CitedDomains.tsx`, `src/app/api/aeo/**`, `src/lib/mcp/toolsVisibility.ts`, `docs/VISIBILITY.md` | T7 |
| `CHANGELOG.md` | R |

Файлы-заглушки создаёт T0. После его коммита каждым из них владеет задача из таблицы и
переписывает его целиком. **Никто не трогает** `src/lib/security/safeFetch.ts`,
`src/lib/alertScheduler.ts`, `src/lib/gscQuery.ts`, `src/lib/seo/judge.ts`,
`src/lib/seo/mechanics.ts`. Это общие модули: их можно импортировать, но нельзя менять.

---

## 5. Правила, которые нельзя нарушать

- **Локали — только T0.** `npm run check:i18n` требует одинаковый набор ключей в семи файлах
  (`en ru uk fr es de zh`). T0 заранее создаёт все ключи всех задач из `CONTRACT.md` §7.
  Понадобился новый ключ — используй его в коде и допиши в раздел «Дополнительные ключи»
  своего отчёта. В локали его не добавляй.
- **Шаблоны уведомлений — только T0**, в `src/lib/notifyI18n.ts` (`CONTRACT.md` §8). Планировщики
  работают без UI, поэтому уведомления не читают JSON-локали.
- **Никаких миграций.** Деплой идёт через `prisma db push`, `prisma/migrations/` не используется.
  `prisma/schema.mysql.prisma` генерируется сам и в git не лежит.
- **Схема:** типа `Json` нет (SQLite). JSON хранится в `String` с комментарием `// JSON: <shape>`.
  `createMany({ skipDuplicates })` на SQLite не работает: сначала читай существующие ключи, потом
  дели на insert и update. Пачки — не больше **400** параметров.
- **Тесты регистрируются сами.** T0 дописывает в конец `test:unit` глобы из `CONTRACT.md` §6.
  Новый `*.test.ts` клади только в эти папки, тогда `package.json` править не нужно.
- **Чистая логика — отдельно от Prisma.** Всё, что можно посчитать без базы (очереди,
  классификация, парсинг, агрегация), живёт в модуле без импорта `@/lib/prisma` и покрыто
  тестами `node:test` + `node:assert/strict`. Так тесты гоняются без `prisma generate`.
- **Внешние запросы — только через `safeFetch`** (`src/lib/security/safeFetch.ts`). URL задаёт
  пользователь, значит без проверки это SSRF на внутреннюю сеть VPS (A-Parser на
  `127.0.0.1:9091` — самый наглядный пример).
- **Права доступа:** чтение — `workspaceUserId()`. Изменение настроек и «проверить сейчас» —
  `workspaceUserId("act")`. Всё, что тратит деньги пользователя (LLM, платные API), —
  `workspaceUserId("spend")` плюс явное подтверждение в UI; в MCP — `confirm: true`.
- **Стоимость — до запуска** (`PRODUCT-ROADMAP.md` §3.3). Бесплатное подписано как бесплатное:
  «free · Google quota» или «free · public API», но никогда не `$0.00`.
- **`null` ≠ 0 ≠ «не проверено».** Статус «не знаю» — отдельное состояние с текстом, а не серый
  ноль и не зелёный по умолчанию.
- **UI** — токены `var(--color-*)`, классы `.card`, `.panel`, `.pill`, `.tool-input`, иконки
  `lucide-react`. Цвет не единственный носитель смысла: у каждой точки статуса есть текст для
  `aria-label` и `title`. Проверка на ширине 360 px, в тёмной и светлой теме, в режиме
  privacy blur. В read-only share view — без кнопок изменения.
- **Линт:** в новых файлах 0 ошибок `eslint`. Чаще всего срабатывают два правила:
  `react-hooks/set-state-in-effect` (не пиши `useEffect(() => setX(…))`, корректируй state во
  время рендера) и `@typescript-eslint/no-explicit-any`.
- **Next.js здесь не тот, что в обучении** (`AGENTS.md`). Перед роутами прочитай нужный гайд в
  `node_modules/next/dist/docs/`. Параметры динамических роутов смотри в существующих
  `src/app/api/**/[id]/route.ts` и делай так же.
- **Таблица без схемы — не 500.** Инстанс, который подтянул код, но не сделал `db push`, получает
  `{ notMigrated: true }`, а UI показывает «выполните `npx prisma db push`». Образец —
  `schemaMissing()` в `src/lib/drops/store.ts`.
- **Планировщики** — по образцу `src/lib/serpmon/scheduler.ts`: `setInterval` с защитой от
  повторного входа, пустой тик — один индексированный запрос. Каждая внешняя операция
  выполняется в `withCallContext`, как в `alertScheduler.ts`, чтобы она попала в журнал провайдеров.

---

## 6. Проверка перед сдачей

```bash
npm run check                               # i18n + release + unit-тесты — целиком
npx eslint <каждый твой файл>               # 0 ошибок
npx tsc -p tsconfig.json --noEmit           # новых ошибок нет
```

Перед началом работы прогони полный `tsc` на чистом `feat/wave-oct` и сохрани список ошибок:
это база. При сдаче ошибок должно быть не больше, чем в базе, и ни одной в твоих файлах. Для
итераций заведи временный узкий `tsconfig` и не коммить его.

---

## 7. Отчёт по задаче

В конце — в чат сессии:

1. Что сделано, по файлам.
2. Чего **не** сделано и почему.
3. Какие правки нужны в чужих файлах — списком, чтобы R их применил.
4. Дополнительные i18n-ключи (ключ · en · ru).
5. Что проверено и как (команда → результат, в числах).
6. Решения, принятые не по контракту, — с обоснованием.
7. Хеш последнего коммита в своей ветке.

---

## 8. Как тестировать (для Руслана, после R)

**Только на копии базы.** После `db push` в базе появятся новые таблицы и колонки. Если потом
запустить `main` без них, `db push` в entrypoint откажется работать без `--accept-data-loss`.

```bash
cd ~/Downloads/opengsc/.worktrees/wave-t0
cp ../../.env .
cp ../../dev.db ./wave-test.db
DATABASE_URL="file:./wave-test.db" npx prisma db push
DATABASE_URL="file:./wave-test.db" npm run dev
```

Чеклист приёмки:

1. **Мета (T1).** SEO Tools → Text по любому ключу на французском. В шапке статьи
   `Title` 50–60 символов, `Meta Description` 150–160. В деталях записи есть плашка
   «Title 57/60 ✓». Открыть старую запись с длинным title → «Подогнать мету» → сначала
   бесплатная попытка, платная только после подтверждения.
2. **Аптайм (T2).** На дашборде у каждого сайта точка. В настройках сайта поменять URL монитора
   на `https://<сайт>/nonexistent-page-404` → через ~2 интервала точка красная, сайт в группе
   «Требуют внимания» наверху, в Telegram «упал». Вернуть URL → «поднялся, простой N мин».
   Выключить интернет на машине на 2 минуты → алертов **нет**, статус «проверка недоступна».
3. **Каналы (T3).** Settings → Notifications → Discord webhook → «Тест» приходит. E-mail через
   SMTP (например, Gmail app password) → «Тест» приходит, письмо читается как HTML.
4. **Индексация (T4).** Вкладка Indexing → включить автопроверку, бюджет 50. Через час
   `googleChecked` появился у ~50 URL, счётчик «сегодня 50/2000 (день по PT)». Нажать ручную
   проверку → счётчик растёт и от неё тоже.
5. **Аудит (T5).** Аудит сайта с `/en/`-версией → hreflang-правила с evidence. С ключом PageSpeed
   → карточка PSI на 3–5 страниц. Без ключа → «недоступно», а не ошибка.
6. **Видимость (T6, T7).** Вкладка называется «Видимость», подвкладки: «Ответы ИИ»,
   «Доля голоса», «Упоминания», «LLM Mentions». В «Упоминаниях» после «Проверить сейчас» —
   новости из Google News по брендовым словам. В «Доле голоса» после добавления двух
   конкурентов цифры появляются **без новых платных запросов**.
7. `npm run check` зелёный. Страницы нормально выглядят на телефоне.

Потом — merge в `main`, `npx prisma db push` на проде, `pm2 restart opengsc --update-env`.

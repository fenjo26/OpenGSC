# Волна «Расширение»: Side Panel, слой OpenGSC, режим донора, оверлей выдачи

Ветка интеграции **не нужна**: работа сразу попадает в `main` (так хочет Руслан, сам он
ничего не мержит). Как этого добиться без столкновений, описано в разделе 3.

Этот README написан для агентов-исполнителей. Прочитай его целиком, потом `CONTRACT.md`,
потом бриф своей задачи. Правила из раздела 5 действуют для всех задач без исключений.

---

## 1. Что строим и зачем

Расширение N11 (`extension/`, MV3, ставится распакованным) уже есть, но умеет немного: попап с
мини-аудитом страницы, данные портфеля по URL, «отправить в индекс / в Outreach», CSV из таблицы.
Руслан про него даже забыл: на каждый день он пользуется сторонними расширениями
(SEO META in 1 CLICK, MineOrganic SEO Vision, Keywords Everywhere). Волна делает наше расширение
таким, чтобы сторонние стали не нужны, и добавляет то, чего у них нет и быть не может: данные
самого OpenGSC.

| # | Задача | Что сейчас | Результат |
|---|---|---|---|
| E1 | **Side Panel и разбор страницы** | Попап закрывается при каждом клике; проверок 13 | Боковая панель, которая не закрывается при переходах. Вкладки как у SEO META: Обзор / Заголовки / Ссылки / Картинки / Schema / Social / robots+sitemap. Core Web Vitals локально, подсветка проблем прямо на странице, экспорт CSV/JSON |
| E2 | **Слой OpenGSC для своих страниц** | Попап показывает метрики и индекс, но ничего не советует | Главный запрос GSC против title/H1, «подобрать мету» (бесплатно по коду, с LLM — по подтверждению), **проверка футпринта** по всей сетке, есть ли URL в sitemap |
| E3 | **Режим донора для чужих страниц** | Только кнопка «в Outreach» | Исходящие ссылки с rel и местом на странице, детектор восстановленного дропа и PBN (маркеры WayForge, ссылки на web.archive.org, ссылка вверху `<body>`), «эта страница уже ссылается на ваш сайт» |
| E4 | **Оверлей выдачи Google (расширение)** | Нет | Строка с нашими данными под каждым результатом, шапка с данными по запросу, кнопки действий, «сохранить выдачу», проверка клоакинга |
| E5 | **Серверная часть выдачи** | Нет | `/api/ext/hosts` (всё, что OpenGSC знает о хостах), сохранение выдачи `SerpCapture`, действия (Rank Tracker, SERP Monitor, drops-watch), проверка клоакинга, вкладка «Снимки из браузера» в SERP Monitor, MCP |

### Что сознательно не делаем

- **Объём, CPC и конкуренцию «как у Keywords Everywhere» на каждой выдаче.** У нас это идёт
  через Ahrefs-гейтвей и стоит юнитов. В шапке оверлея показываем только то, что уже лежит в
  `KeywordMetricCache`; «дотянуть» — нет. Эта кнопка может появиться позже отдельной задачей.
- **DNS, SSL по всем IP, Certificate Transparency** (это есть в MineOrganic). Для задач
  пользователей OpenGSC пользы мало, а работы много.
- **Свой SERP-скрейпер.** Оверлей читает только ту выдачу, которую пользователь сам открыл
  в своём браузере. Сам расширение запросов в Google не делает.
- **Публикация в Chrome Web Store.** Установка остаётся распакованной, как в N11.
- **Проверки доступности уровня axe-core.** В E1 есть только простые проверки (alt, `lang`, кнопки
  и ссылки без текста). Полный a11y-аудит — не задача этой волны.

---

## 2. Порядок работ

```
E0 (один) ──► E1 E2 E3 E4 E5 (параллельно) ──► R (ревью в main) ──► тест Руслана
```

1. **E0** делает фундамент и коммитит **прямо в `main`**. Пока коммита E0 нет, остальные
   задачи не стартуют.
2. **E1…E5** — каждая в своём worktree на короткой ветке `feat/ext-eN` от `main` (после E0).
   Закончив, задача **сама** приземляет себя в `main` (раздел 3.2). Руслан ничего не мержит.
3. **R** — ревью уже в `main`: проверяет владение файлами, прогоняет `npm run check`, сшивает
   то, что задачи описали как «нужно в чужом файле», пишет `CHANGELOG.md`.
4. Руслан тестирует по разделу 8.

| # | Бриф | Зависит от |
|---|---|---|
| E0 | `E0-foundation.md` | — |
| E1 | `E1-sidepanel.md` | E0 |
| E2 | `E2-portfolio-layer.md` | E0. От E1 — только интерфейс `Panel.register` и `facts.detail` из контракта |
| E3 | `E3-donor.md` | E0. От E5 — только ответ `/api/ext/hosts` из контракта |
| E4 | `E4-serp-overlay.md` | E0. От E5 — ответы `/api/ext/hosts`, `/serp/*`, `/cloak` из контракта |
| E5 | `E5-serp-server.md` | E0 |
| R | `R-review.md` | все |

E0 кладёт заглушки со всеми сигнатурами и формами ответов, поэтому каждая ветка компилируется и
расширение загружается с первого коммита. Поведение появляется, когда задачи приземлятся.

**Порядок приземления** (если задачи заканчивают одновременно): E5 → E1 → E2 → E3 → E4.
Сервер раньше клиента: так после каждого шага `main` работает.

**Если агентов меньше пяти:** E1 отдельно; E2+E3 (обе — вкладки панели); E4+E5 (оверлей и его
сервер). Владение файлами внутри пары не меняется.

---

## 3. Worktree и приземление в `main`

### 3.1 Worktree — только из терминала Мака

Все сессии работают в одном клоне `~/Downloads/opengsc`. `git checkout -b` там запрещён.

> **Не создавай worktree из песочницы Cowork (VM).** Git запишет в `.git/worktrees/<имя>/`
> абсолютный путь той машины, где выполнена команда (`/sessions/…`). На Маке такого пути нет.

```bash
cd ~/Downloads/opengsc
# E1…E5 — ТОЛЬКО после коммита E0 в main
git worktree add .worktrees/ext-e1 -b feat/ext-e1 main
ln -sfn ../../node_modules .worktrees/ext-e1/node_modules     # 1.7 ГБ, не копировать
cd .worktrees/ext-e1 && npx prisma generate                    # своя копия клиента
```

`.worktrees/` нет в `.gitignore` — `git add` только своих файлов. Уборка:
`git worktree remove .worktrees/ext-eN && git branch -d feat/ext-eN`.

### 3.2 Приземление (делает сама задача)

Владение файлами в волне не пересекается, поэтому rebase проходит без конфликтов.

```bash
cd ~/Downloads/opengsc/.worktrees/ext-eN
git fetch . main:main 2>/dev/null || true      # main — локальная ветка в общем клоне
git rebase main
npm run check && npx eslint <свои файлы>        # ещё раз, уже поверх чужих приземлений
cd ~/Downloads/opengsc && git merge --ff-only feat/ext-eN
```

Если `merge --ff-only` не прошёл (кто-то приземлился между rebase и merge) — повтори rebase.
**Никаких merge-коммитов и `--force`.** В основном клоне не должно быть незакоммиченных
изменений; если они есть — остановись и напиши об этом в отчёте, не трогай их.
`git push` не делать: пушит Руслан.

---

## 4. Владение файлами — жёсткое

Файл правит **только** задача из правой колонки. Нужна правка в чужом файле — не делай её,
опиши в отчёте.

| Файл | Владеет |
|---|---|
| `prisma/schema.prisma` | E0 |
| `src/locales/*.json` (все 7) | **E0 и только E0** |
| `extension/_locales/{en,ru}/messages.json` | **E0 и только E0** |
| `extension/manifest.json` | E0 |
| `extension/background.js`, `extension/bg/menus.js` | E0 (роутер сообщений и прокси к API) |
| `extension/lib/protocol.js`, `extension/lib/settings.js`, `extension/lib/googleDomains.js` | E0 |
| `extension/options.html`, `extension/options.js`, `extension/options.css` | E0 |
| `extension/lib/api.js` | E0 (новые методы клиента — все сразу, по контракту) |
| `src/lib/ext/types.ts` | E0 (дальше не меняется) |
| `src/app/api/ext/lists/route.ts` | E0 (делает целиком) |
| `src/lib/mcp/tools.ts` | E0 — только строка import и вставка в `MCP_TOOLS` |
| `src/app/serp-monitor/[id]/page.tsx` | E0 — ровно одна точка: четвёртая вкладка `captures` |
| `extension/sidepanel.html`, `extension/sidepanel.css`, `extension/panel/core.js`, `extension/panel/tab-page.js`, `extension/bg/panel.js`, `extension/popup.html`, `extension/popup.js`, `extension/popup.css`, `extension/content.js`, `extension/lib/audit.js`, `extension/lib/csv.js`, `extension/lib/vitals.js`, `extension/lib/highlight.js`, `extension/lib/export.js`, `src/lib/ext/audit.test.ts`, `src/lib/ext/auditDetail.test.ts`, `docs/EXTENSION.md` | E1 |
| `extension/panel/tab-opengsc.js`, `src/app/api/ext/insights/route.ts`, `src/app/api/ext/meta-fit/route.ts`, `src/lib/ext/insights.ts`, `src/lib/ext/insights.test.ts` | E2 |
| `extension/panel/tab-donor.js`, `extension/lib/donor.js`, `src/lib/ext/donor.test.ts` | E3 |
| `extension/serp/overlay.js`, `extension/lib/serpParse.js`, `extension/bg/serp.js`, `src/lib/ext/serpParse.test.ts`, `src/lib/ext/__fixtures__/serp/**` | E4 |
| `src/app/api/ext/hosts/**`, `src/app/api/ext/serp/**`, `src/app/api/ext/cloak/route.ts`, `src/lib/ext/hostIntel.ts`, `src/lib/ext/hostIntelPure.ts`, `src/lib/ext/serpCapture.ts`, `src/lib/ext/snippet.ts`, `src/lib/ext/{hostIntel,serpCapture,snippet}.test.ts`, `src/app/api/serp-monitor/captures/**`, `src/components/serpmon/CapturesTab.tsx`, `src/lib/mcp/toolsSerpCaptures.ts` | E5 |
| `CHANGELOG.md`, `README*.md` (строки про расширение) | R |

Заглушки всех файлов создаёт E0. После его коммита каждым файлом владеет задача из таблицы и
переписывает его целиком.

**Никто не трогает** (импортировать можно, менять нельзя): `src/lib/ext/auth.ts`,
`src/lib/ext/origin.ts`, `src/lib/ext/rateLimit.ts`, `src/lib/ext/token.ts`,
`src/lib/ext/urlMatch.ts`, `src/app/api/ext/{page,token,index-queue,outreach}/route.ts`,
`src/lib/security/safeFetch.ts`, `src/lib/seo/googlebot.ts`, `src/lib/seo/metaFit.ts`,
`src/lib/seo/metaLimits.ts`, `src/lib/footprint/**`, `src/lib/serpmon/**`, `src/lib/drops/**`,
`src/lib/pbn/**`, `src/lib/audit/**`, `src/app/api/rank/**`.

---

## 5. Правила, которые нельзя нарушать

**Общие для OpenGSC** (как в прошлых волнах):

- **Локали — только E0.** И 7 JSON приложения (`npm run check:i18n`), и 2 локали расширения
  (`en`, `ru`). Понадобился ключ — используй, допиши в «Дополнительные ключи» отчёта.
- **Никаких миграций.** Деплой — `prisma db push`. Типа `Json` нет: JSON живёт в `String` с
  комментарием `// JSON: <shape>`. Пачки ≤ 400 параметров.
- **Чистая логика — отдельно от Prisma** и покрыта `node:test` + `node:assert/strict`. Тесты
  кладём в `src/lib/ext/*.test.ts` — глоб уже в `test:unit`, `package.json` не трогаем.
- **Внешние запросы сервера — только через `safeFetch`** (`assertSafeTarget` для URL от клиента).
- **Права:** каждый `/api/ext/*` начинается с `extAuth(req, <capability>)`. Чтение — `"read"`,
  бесплатные действия и сетевые проверки — `"act"`, запись (Rank Tracker, SERP Monitor, drops) —
  `"write"`, всё, что тратит деньги — `"spend"` и **`confirm: true` в теле**, иначе
  `400 { error: "confirm_required", estimate }`.
- **Стоимость — до запуска.** Бесплатное подписано «бесплатно · локально» / «бесплатно ·
  публичные источники», никогда не `$0.00`.
- **`null` ≠ 0 ≠ «не проверено».** Неизвестный DR — это «—» с подсказкой, а не 0.
- **Таблица без схемы — не 500**, а `{ notMigrated: true }` (`extTablesMissing` в `auth.ts` или
  `schemaMissing()` в `serpmon/store.ts`).
- **Линт:** 0 ошибок `eslint` в новых TS-файлах. JS расширения — без сборки, классические
  скрипты (как сейчас): `var`/IIFE, без `import`, футер `module.exports` для тестов.

**Свои правила расширения:**

- **API вызывают только страницы расширения и service worker.** Сервер пускает только origin
  `chrome-extension://<id>` (`corsDecision`). Content-скрипт (оверлей, сбор фактов) **никогда**
  не делает `fetch` к OpenGSC: он шлёт сообщение `ext:api` в background (`CONTRACT.md` §5), а
  тот выполняет запрос через `ExtApi`.
- **Лимит 60 запросов в минуту на токен** (`extAuth`). Оверлей делает **один** запрос `hosts` на
  страницу выдачи, панель — не больше трёх при открытии страницы. Повторы — из кеша
  `chrome.storage.session` (10 минут).
- **Содержимое чужих страниц на сервер не уходит.** На сервер уходят URL, хосты, title,
  description, H1, тексты сниппетов выдачи. HTML страниц, тексты абзацев и формы — нет.
- **Никаких следов на чужой странице.** Подсветка и оверлей — внутри одного shadow-host на
  результат или на страницу; атрибуты и классы элементов страницы не меняем; при выключении
  всё удаляется без остатка.
- **Права браузера — по запросу.** На установке у расширения нет постоянных host permissions
  (как в N11). Доступ «ко всем сайтам» для панели и «к доменам Google» для оверлея
  запрашивается из настроек через `chrome.permissions.request` по клику пользователя.
- **Разметка Google меняется.** Всё, что зависит от DOM Google, собрано в `lib/serpParse.js`, а
  в селекторах есть запасные варианты. Если ни один не сработал, оверлей молча не рисуется и
  пишет одну строку в `console.debug`. Страница не должна ломаться.
- **Совместимость с другими расширениями.** Keywords Everywhere, MozBar и подобные вставляют
  свои блоки в те же результаты. Наш парсер не должен принимать их ссылки за органику, а наш
  блок — ломать их.

---

## 6. Проверка перед сдачей

```bash
npm run check                               # i18n + release + unit-тесты — целиком
npx eslint <каждый твой TS/TSX-файл>        # 0 ошибок
npx tsc -p tsconfig.json --noEmit           # новых ошибок нет (база — main после E0)
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json'))"
```

Расширение проверяется руками: `chrome://extensions` → «Загрузить распакованное» →
`~/Downloads/opengsc/extension` (или папка своего worktree) → «Обновить» после каждой правки.
Ошибки service worker — «Inspect views: service worker»; панели — правый клик в панели →
«Просмотреть код». В отчёте перечисли, на каких страницах проверял.

---

## 7. Отчёт по задаче

1. Что сделано, по файлам.
2. Чего **не** сделано и почему.
3. Правки, нужные в чужих файлах, — списком для R.
4. Дополнительные i18n-ключи (ключ · en · ru; для приложения — все 7 языков не нужны, R добьёт).
5. Что проверено и как (команда → результат в числах; страницы, на которых смотрел руками).
6. Решения не по контракту — с обоснованием.
7. Хеш коммита в `main` после приземления.

---

## 8. Как тестировать (для Руслана, после R)

Схема меняется одной таблицей (`SerpCapture`), она только добавляется. Поэтому тест можно
делать прямо на рабочей базе. Если хочется осторожнее — на копии, как обычно:

```bash
cd ~/Downloads/opengsc
cp dev.db wave-ext-test.db
DATABASE_URL="file:./wave-ext-test.db" npx prisma db push
DATABASE_URL="file:./wave-ext-test.db" npm run dev
```

Расширение: `chrome://extensions` → «Обновить» на карточке OpenGSC (распакованное из
`~/Downloads/opengsc/extension`). ID не меняется, токен и список разрешённых ID в Settings
остаются те же.

Чеклист приёмки:

1. **Панель (E1).** Клик по иконке → справа открывается панель. Переход по ссылкам на сайте —
   панель остаётся и обновляется. Настройки → «Анализировать любую страницу без клика» →
   браузер спрашивает разрешение. Вкладки Заголовки/Ссылки/Картинки совпадают с тем, что
   показывает SEO META in 1 CLICK на той же странице. «Подсветить» → картинки без alt и лишние H1
   обведены, повторный клик убирает всё. CWV: LCP/FCP/TTFB/CLS в цифрах. Экспорт CSV открывается
   в Excel.
2. **Слой OpenGSC (E2).** Страница своего сайта → вкладка «OpenGSC»: главный запрос за 28 дней,
   совпадает ли он с title/H1, «в sitemap: да/нет», футпринт. Взять две страницы сетки
   трансферов с одинаковым шаблоном title → футпринт показывает совпадение со вторым сайтом.
   «Подобрать мету» → сначала бесплатный вариант; кнопка с LLM спрашивает подтверждение.
3. **Донор (E3).** Чужая статья со ссылками → вкладка «Донор»: таблица исходящих ссылок с rel и
   местом («в тексте», «меню», «подвал», «вверху body»). Страница дропа, восстановленного
   WayForge → «похоже на восстановленный дроп» с доказательствами. Страница, которая уже
   ссылается на твой сайт, → это видно сразу.
4. **Оверлей (E4+E5).** Настройки → включить оверлей → разрешить google.com и google.gr.
   Запрос `bizzo casino italia` → под каждым результатом строка с DR, возрастом, данными SERP
   Monitor (если хост есть в проекте). Свой сайт подсвечен, и для него показаны клики и позиция
   из GSC. Keywords Everywhere на той же странице не сломан. «Сохранить выдачу» → в SERP Monitor
   → вкладка «Снимки из браузера» — снимок есть, его можно сравнить с ближайшим автоматическим.
   «Проверить клоакинг» у результата → вердикт и найден ли сниппет у бота и у браузера.
   «В Rank Tracker», «В SERP Monitor», «Следить как дроп» работают.
5. `npm run check` зелёный.

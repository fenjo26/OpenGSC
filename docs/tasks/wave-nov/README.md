# Волна «Ноябрь»: весь бэклог одной волной

Ветка интеграции: **`feat/wave-nov`**, создаётся **от `feat/wave-oct`** (коммит `4673b8e` или
новее), а не от `main`. Волна опирается на октябрьскую: каналы уведомлений, квоту URL
Inspection, хаб «Видимость», `metaLimits`. Если к старту октябрьская волна уже влита в `main`,
ответвляйся от `main`.

Прочитай README целиком, потом `CONTRACT.md`, потом бриф своей задачи. Правила из §5
обязательны для всех задач. Они те же, что в `docs/tasks/wave-oct/README.md` §5, с тремя
уточнениями, отмеченными **(нов.)**.

---

## 1. Что строим

| # | Задача | Для кого | Результат |
|---|---|---|---|
| N0 | Фундамент | все | Схема, типы, заглушки, i18n-ключи всех задач, пункты меню, регистрация тестов и планировщиков |
| N1 | Отпечатки сетки + hreflang-генератор | сетка сайтов | Отчёт «одинаковые шаблоны title/H1/description на разных сайтах», запрет таких шаблонов в генераторе, генератор hreflang-разметки |
| N2 | Бэклинки: токсичность, disavow, восстановление | все сайты | Токсичность своего профиля с учётом своей ниши, disavow-файл, приоритет восстановления потерянных ссылок |
| N3 | Локальные позиции | трансферы, массаж | Позиция по городу или координатам, отдельно — место в local pack (тройке на карте) |
| N4 | Local SEO: профиль, NAP, схема, каталоги, GBP | трансферы, массаж | Карточка бизнеса, проверка NAP на сайте и в каталогах, генератор LocalBusiness-разметки, интеграция с Google Business Profile (посты, отзывы, фото) |
| N5 | Trend radar | все | Растущие запросы из своего GSC, подсказки Google по нише, строка в дайджесте |
| N6 | Плагиат + проверка индекса через `site:` | SEO Tools, дропы | Проверка текста по вебу точными цитатами, проверка индексации для сайтов вне GSC |
| N7 | Тональность и AI Overviews | «Видимость» | Тональность упоминаний бренда в ответах ИИ, Google AI Overviews как движок |
| N8 | Отчёты для клиентов | агентства | White-label отчёт (HTML + PDF), ежемесячная рассылка, клиентский доступ |
| N9 | Виджет аудита, лиды, КП | агентства | Встраиваемый iframe-аудит, входящие лиды с находками, коммерческое предложение из аудита |
| N10 | PWA + push-уведомления | все | Установка на телефон, web push как канал уведомлений, офлайн-чтение последних данных |
| N11 | Браузерное расширение | все | Chrome/Edge MV3: «Отправить в OpenGSC», быстрый аудит страницы, позиции и индекс для текущего URL |

### Что работает не сразу (честно, до старта)

- **N4, Google Business Profile.** Google выдаёт доступ к Business Profile API только по заявке
  (форма в Google Cloud, одобрение занимает до нескольких недель). До одобрения квота равна 0.
  Код пишется и тестируется на фикстурах, а UI показывает «нужен доступ к API» со ссылкой на
  заявку. Остальная часть N4 работает без GBP. **Руслану: подай заявку сейчас.**
- **N6, через A-Parser.** Google-прокси A-Parser сейчас ловят капчу (история SERP Monitor).
  Поэтому плагиат и `site:` работают через любой настроенный SERP-провайдер (Serper,
  DataForSEO, A-Parser), а цена показывается до запуска. A-Parser — просто один из вариантов.
- **N11** собирается как отдельный архив: в Chrome Web Store не публикуется. Установка —
  «Загрузить распакованное расширение», инструкция в доке.

---

## 2. Порядок работ

```
N0 (один) ──► N1 … N11 (параллельно, 11 сессий) ──► R ──► тест Руслана ──► main
```

- **N0** коммитит прямо в `feat/wave-nov`. Остальные ответвляются от его коммита.
- **N1…N11** — ветки `feat/wave-nov-nN` и worktree `.worktrees/nov-nN`.
- **R** вливает в порядке **N1 → N2 → N5 → N6 → N7 → N3 → N4 → N10 → N8 → N9 → N11**:
  сначала независимое, потом доставка (N10 добавляет канал), потом то, что им пользуется.

Если сессий меньше 11, объединяй так, владение файлами не меняется:
N1+N5 · N2 · N3+N4 · N6+N7 · N8+N9 · N10+N11.

---

## 3. Worktree — только из терминала Мака

```bash
cd ~/Downloads/opengsc
git worktree add .worktrees/nov-n0 -b feat/wave-nov feat/wave-oct   # если ветки ещё нет
# после коммита N0:
git worktree add .worktrees/nov-n1 -b feat/wave-nov-n1 feat/wave-nov
# …n2…n11
# в каждом worktree:
ln -sfn ../../node_modules .worktrees/nov-nN/node_modules
cp .env .worktrees/nov-nN/.env
cd .worktrees/nov-nN && npx prisma generate
```

**(нов.) Зависимости ставит только N0 и только в основной папке.** В октябре `npm i` внутри
worktree заменил симлинк `node_modules` на реальную копию (1,1 ГБ), и `nodemailer` оказался
только там. Правило такое: N0 выполняет `npm i <пакеты>` в `~/Downloads/opengsc` (основная папка),
а в worktree коммитит только `package.json` и `package-lock.json`. После этого у всех worktree
через симлинк будут одни и те же пакеты. Если `node_modules` в worktree перестал быть симлинком
(`ls -la`), верни симлинк и не коммить ничего из node_modules.

Из песочницы Cowork (VM) worktree не создаётся: git запишет путь `/sessions/…`, которого нет на
Маке.

---

## 4. Владение файлами

| Файл | Владеет |
|---|---|
| `prisma/schema.prisma`, `src/locales/*.json`, `src/lib/notifyI18n.ts`, `package.json`, `package-lock.json`, `src/instrumentation.ts`, `src/components/DashboardShell.tsx`, `src/lib/mcp/tools.ts` (import и `MCP_TOOLS`), `src/proxy.ts`, `next.config.ts` (только заголовки для `/embed/`) | N0 |
| `src/lib/notify/types.ts` (расширение типов, `CONTRACT.md` §2) | N0 |
| `src/app/site/[id]/page.tsx` | никто: в этой волне вставок в страницу сайта нет |
| `src/app/settings/page.tsx` | N0 — точки вставки. Больше никто |
| `src/lib/footprint/**`, `src/app/footprint/**`, `src/app/api/footprint/**`, `src/lib/hreflang/**`, `src/app/seo-tools/hreflang/**`, `src/lib/seo/generate.ts`, `src/lib/seo/prompts.ts` (только блок «шаблоны портфеля»), `src/lib/mcp/toolsFootprint.ts` | N1 |
| `src/lib/backlinks/**`, `src/app/api/backlinks/toxicity/**`, `src/app/api/backlinks/disavow/**`, `src/app/api/backlinks/recovery/**`, `src/components/BacklinkProfile.tsx`, `src/components/backlinks/**`, `src/lib/mcp/toolsBacklinkTox.ts` | N2 |
| `src/lib/rank.ts`, `src/lib/rankScheduler.ts`, `src/lib/rankFallback.ts`, `src/lib/seo/serp.ts`, `src/lib/seo/localPack.ts`, `src/components/RankTracker.tsx`, `src/app/api/rank/**` | N3 |
| `src/lib/local/**`, `src/app/local/**`, `src/app/api/local/**`, `src/components/local/**`, `src/lib/mcp/toolsLocal.ts` | N4 |
| `src/lib/trends/**`, `src/app/api/trends/**`, `src/components/TrendRadar.tsx`, `src/app/demand/**`, `src/lib/digest.ts`, `src/lib/mcp/toolsTrends.ts` | N5 |
| `src/lib/plagiarism/**`, `src/app/seo-tools/plagiarism/**`, `src/app/api/seo/plagiarism/**`, `src/lib/indexing/serpIndex.ts`, `src/app/api/indexing/serp-check/**`, `src/components/IndexAutoPanel.tsx`, `src/lib/seo/toolsNav.ts`, `src/lib/mcp/toolsPlagiarism.ts` | N6 |
| `src/lib/seo/aeo.ts`, `src/lib/aeoTracker.ts`, `src/lib/aeoScheduler.ts`, `src/components/AeoTracker.tsx`, `src/lib/visibility/**` (кроме `types.ts`), `src/components/visibility/AiShareOfVoice.tsx`, `src/app/api/aeo/**`, `docs/VISIBILITY.md` | N7 |
| `src/lib/reports/**`, `src/app/reports/**`, `src/app/api/reports/**`, `src/components/reports/**`, `src/app/share/**`, `src/lib/mcp/toolsReports.ts` | N8 |
| `src/lib/leads/**`, `src/app/embed/**`, `src/app/api/public/**`, `src/app/api/leads/**`, `src/app/leads/**`, `src/components/leads/**`, `src/lib/mcp/toolsLeads.ts` | N9 |
| `public/manifest.webmanifest`, `public/sw.js`, `public/icons/**`, `src/app/layout.tsx`, `src/lib/push/**`, `src/lib/notify.ts`, `src/lib/notify/**` (кроме `types.ts`), `src/app/api/push/**`, `src/components/PushSettingsCard.tsx`, `src/components/NotifyChannelsCard.tsx` | N10 |
| `extension/**`, `src/app/api/ext/**`, `src/lib/ext/**`, `src/components/ExtensionTokenCard.tsx`, `docs/EXTENSION.md` | N11 |
| `CHANGELOG.md`, `README.md`, `README.ru.md`, `docs/MCP-SETUP.md` | R |

Каждая задача пишет свою доку `docs/<ИМЯ>.md` (имя — в брифе). Чужие доки не трогает.

**Никто не трогает:** `src/lib/security/safeFetch.ts`, `src/lib/alertScheduler.ts`,
`src/lib/gscQuery.ts`, `src/lib/seo/judge.ts`, `src/lib/seo/mechanics.ts`,
`src/lib/seo/aparser.ts`, `src/lib/drops/**`, `src/lib/audit/**`, `src/lib/serpmon/**`,
`src/lib/uptime/**`, `src/lib/indexing/*` (кроме `serpIndex.ts` у N6). Импортировать их можно,
менять нельзя. Нужна правка — опиши её в отчёте.

---

## 5. Правила

Все правила из `docs/tasks/wave-oct/README.md` §5 действуют без изменений: локали и
`notifyI18n.ts` только у N0, никаких миграций (`db push`), JSON в `String`, пачки ≤ 400,
тесты только в папках с зарегистрированными глобами, чистая логика отдельно от Prisma, внешние
запросы через `safeFetch` / `assertSafeTarget`, права `read` / `act` / `spend`, цена до запуска,
`null ≠ 0`, общие токены UI, 0 новых ошибок eslint, «таблицы нет → `notMigrated`», планировщики
по образцу `serpmon/scheduler.ts`.

**(нов.) i18n-ключи — в брифах.** Контракт не перечисляет ключи. Каждый бриф заканчивается
таблицей «ключ · en · ru». N0 собирает таблицы из всех одиннадцати брифов и создаёт ключи во
всех семи локалях. Префикс ключа — префикс задачи (`fp*`/`hl*`, `bl*`, `lr*`, `loc*`, `tr*`,
`plg*`/`idxSerp*`, `aiSent*`/`aeo*`, `rep*`, `lead*`, `pwa*`, `ext*`), поэтому ключи двух задач не пересекаются.

**(нов.) Публичные маршруты** (N9 `/embed/**`, `/api/public/**`; N11 `/api/ext/**` по
токену) открывает в `src/proxy.ts` только N0, по списку из `CONTRACT.md` §4. Каждый такой
маршрут сам проверяет доступ: у публичного — rate limit и Turnstile, у расширения — Bearer-токен.
`safeFetch` в публичном контуре вызывается строго с `allowPrivate: false`.

---

## 6. Проверка перед сдачей
```bash
npm run check
npx eslint <каждый твой файл>
npx tsc -p tsconfig.json --noEmit     # не больше базы
```

## 7. Отчёт
Как в октябре: что сделано (по файлам), чего нет и почему, правки в чужих файлах,
дополнительные i18n-ключи, что проверено (команда → числа), решения вне контракта, хеш коммита.

---

## 8. Как тестировать (для Руслана, после R)

На копии базы, как в октябре (`wave-oct/README.md` §8), из `.worktrees/nov-n0`.

1. **N1.** Меню → «Отпечатки»: шаблон «{X} Démo Gratuite : Jouer Sans Inscription ni Dépôt»
   найден на 4 сайтах. SEO Tools → Hreflang: вставить 3 URL с языками → готовые `<link>`,
   sitemap-блок и HTTP-заголовок.
2. **N2.** Сайт → Бэклинки → «Токсичность»: у гемблинг-сайта казино-анкоры **не** токсичны
   (своя ниша), а фарма и адалт — токсичны. «Скачать disavow» → `.txt` с причинами в
   комментариях. «Потерянные» отсортированы по ценности.
3. **N3.** Rank Tracker: ключ «taxi thessaloniki airport» с городом «Thessaloniki» → позиция в
   органике и место в local pack.
4. **N4.** Меню → Local: карточка бизнеса massagethess.gr → NAP-проверка сайта находит разные
   написания телефона; генератор схемы `DaySpa` → валидный JSON-LD; GBP → «нужен доступ к
   API» (до одобрения).
5. **N5.** Demand → Trend radar: растущие запросы за 7 дней против 28; подсказки по сиду «slot».
6. **N6.** SEO Tools → Плагиат: текст с абзацем из Википедии → найден источник. Indexing у
   дропа → «Проверить через site:» с ценой до запуска.
7. **N7.** Видимость → Ответы ИИ: у ответа тональность; движок «AI Overviews».
8. **N8.** Отчёты → новый отчёт со своим логотипом → HTML и PDF; «Отправить сейчас» → письмо.
9. **N9.** Лиды → код iframe → открыть в приватном окне, ввести домен → аудит и форма e-mail →
   лид во входящих с находками → «Сделать КП» → документ.
10. **N10.** На телефоне открыть OpenGSC → «Установить» → push-уведомление о тестовом алерте.
11. **N11.** Загрузить `extension/` в Chrome → токен → на любой странице «Отправить в
    OpenGSC» и мини-аудит.
12. `npm run check` зелёный, телефон ок.

Потом merge в `main`, **`npm i`**, `npx prisma db push`, `npm run build`, `pm2 restart opengsc --update-env`.

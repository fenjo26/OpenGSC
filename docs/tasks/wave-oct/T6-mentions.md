# T6 — Упоминания бренда: Google News и Wikipedia/Wikidata

**Ветка:** `feat/wave-oct-t6` от `feat/wave-oct`, worktree `.worktrees/wave-t6`.
**Владение:** `README.md` §4, строка T6. Компонент показывается на вкладке «Видимость» →
«Упоминания» (хаб сделал T0; хаб не трогаешь).

## Зачем

Руслан увидел в `tkawen-automation` два воркера: `news-mentions-watcher` (Google News RSS по
брендовым словам) и `wikipedia-watcher` (свежие упоминания в Wikipedia и Wikidata). Оба
бесплатны и отвечают на вопрос «где о нас пишут». Для SEO ценнее всего **упоминание без ссылки**:
если издание написало о бренде, попросить у него ссылку — самый дешёвый линкбилдинг. В
OpenGSC уже есть Outreach Workspace, упоминание отправляется туда одной кнопкой.

Третий воркер оттуда, `ai-citation-watcher`, у нас уже есть — это AEO-трекер.

## Источники (все бесплатные, без ключей)

### Google News RSS
`https://news.google.com/rss/search?q=<q>&hl=<lang>&gl=<GL>&ceid=<GL>:<lang>`, где
`q = "<term>" when:7d` (точная фраза, окно 7 дней: при ежедневном запуске ничего не теряется,
дубликаты отсекает `urlKey`).
- Разбор `parseGoogleNewsRss` — `<item>`: `title` (в конце « - Издание» — отрезать в
  `publisher`, если совпадает с `<source>`), `link`, `pubDate`, `<source url>`, `description`
  (HTML — снять теги, ≤ 300 символов). Парсер без новых зависимостей, на регулярках по
  `<item>…</item>` с декодированием сущностей и CDATA. Покрыть тестом на реальной фикстуре.
- `link` — редирект `news.google.com/rss/articles/…`. **Не** разворачивать его на каждом
  запуске: это лишние запросы к Google и риск бана. Хранить как есть; реальный URL статьи
  получается только в `checkMentionLink` (по действию пользователя).
- Пауза между термами ≥ 2 с; ответ ≠ 200 → ошибка терма в `errors`, остальные термы идут дальше.

### Wikipedia (язык сайта + `en`)
- Упоминания: `https://<lang>.wikipedia.org/w/api.php?action=query&list=search&srsearch="<term>"&srlimit=20&format=json&srprop=snippet|timestamp`
  → `kind: "mention"`, `url = https://<lang>.wikipedia.org/wiki/<title>`, `publishedAt =
  timestamp` (время последней правки статьи).
- **Ссылки на домен:** `action=query&list=exturlusage&euquery=<host>&eunamespace=0&eulimit=50`
  и то же для `*.<host>` → `kind: "link"`. Это внешние ссылки из Википедии на сайт, самые ценные
  находки.
- Заголовок `User-Agent: OpenGSC/<version> (+https://opengsc.org; <contact>)`, как требует
  политика Wikimedia API. Без него могут забанить.

### Wikidata
`action=wbsearchentities&search=<name>&language=<lang>&format=json`, затем
`wbgetentities&ids=…&props=claims|labels|descriptions`. Сущность, у которой свойство P856
(official website) совпадает с хостом сайта, → `kind: "entity"`, одна строка на сайт.
Её `lastrevid` храни в `snippet` (формат `rev:<id> · <description>`), чтобы изменение сущности
всплыло новой строкой. Это и есть «свежие изменения в Wikidata».

## Настройки и термы
- `MentionSettings` в `Site.mentionSettings`. Пустые `terms` → `deriveTerms(brandedKeywords,
  host)`: брендовые слова сайта (JSON-массив или строка через запятую — как их уже разбирает
  `parseBrandTerms` в `src/lib/aeoTracker.ts`; импортируй, не копируй) плюс хост без TLD,
  если он не короче 4 символов.
- **Многозначные бренды** — `mustInclude`. «Golden Crown» без контекста принесёт короны и
  отели; с `mustInclude: ["slot", "casino", "machine"]` — только нужное. Совпадение
  `matchesTerm` проверяется по заголовку и сниппету **после** получения, по границе слова, без
  регистра и диакритики. Непрошедшие результаты не сохраняются.
- `exclude` — стоп-слова пользователя.
- Язык и страна по умолчанию — из `Site.market` (карта `market → язык` уже есть в
  `src/lib/seo/regions.ts` → `defaultLanguageFor`).

## Хранилище и планировщик
- `runMentions(userId, siteDbId)`: источники из `settings.sources`, термы по очереди, пачкой
  вставить новые по `(siteId, source, urlKey)` (сначала прочитать существующие ключи, потом
  insert — `skipDuplicates` на SQLite не работает). `urlKey = normalizeMentionUrl(url)`:
  нижний регистр хоста, без `utm_*`, `fbclid`, `gclid`, без `#`, sha1-hex при длине > 191.
- Планировщик: тик раз в час. Сайты с `on`, у которых `lastRunAt` старше 24 ч, — по одному
  за тик на владельца. Первый запуск после включения — сразу (`kickMentionsScheduler`).
- Уведомление (`notify`): после запуска, если есть новые недиспетчеризованные строки, одно
  сообщение на сайт — `mentionsNotifyTitle`/`mentionsNotifyMsg` из `notifyI18n.ts`, до 8 строк
  «Издание — заголовок», `notifyUser(owner, text, { event: "mention" })`, затем `notifiedAt`.
  Первый запуск (исторический бэкфилл) **не** уведомляет: иначе придёт 50 старых статей разом.
- `checkMentionLink(id)`: `safeFetch` страницы (для News — сначала раскрыть редирект Google
  через `safeFetch` с `redirect: "follow"`), найти в HTML `<a href>` на хост сайта или
  поддомен → `linked` / `unlinked`; ошибки и тайм-аут → `unreachable`. Раскрытый URL статьи
  записать в `url`, а `urlKey` не менять.
- Таблицы нет → `{ notMigrated: true }`.

## UI — `src/components/visibility/MentionsPanel.tsx`
- Шапка: `mentionsTitle`, `mentionsFree`, `mentionsHint`, переключатель `mentionsOn`,
  кнопка `mentionsRunNow` → `mentionsRunDone`.
- Настройки (раскрывающиеся): список термов с полем `mentionsMustInclude` (чипы), `mentionsExclude`,
  источники (`mentionsSource_*`), язык, страна, `mentionsNotify`.
- Лента: фильтры состояния (`mentionsState_*`), источника, `linkStatus`, поиск. Строка — дата,
  источник, тип (`mentionsKind_*`), заголовок-ссылка (`target="_blank" rel="noopener
  noreferrer"`), издание, сниппет, статус ссылки. Действия: `mentionsCheckLink`,
  `mentionsReviewed`, `mentionsDismiss`, `mentionsToOutreach`.
- **В Outreach:** через существующий сервис outreach (посмотри, какие функции использует MCP
  `save_outreach_prospect` в `src/lib/mcp/toolsOutreach.ts`, и вызови ту же функцию на сервере
  через маршрут `POST /api/mentions/[id]/outreach` из контракта §4). Evidence = заголовок,
  URL, дата, статус ссылки.
- Пусто → `mentionsEmpty`. Share view — только лента, без действий и настроек.

## MCP — `toolsMentions.ts`
`get_brand_mentions` (`local`): `site` + поля `MentionQuery`.

## Документация
Раздел «Упоминания» для `docs/VISIBILITY.md` пришли текстом в отчёте (файл принадлежит T7, R
вставит): источники, частота, что такое `mustInclude`, почему редиректы Google News не
раскрываются автоматически.

## Тесты — `src/lib/mentions/*.test.ts`
- `parseGoogleNewsRss` на реальной фикстуре (сохрани ответ в `src/lib/mentions/__fixtures__/`):
  число item, publisher отрезан от заголовка, CDATA и сущности декодированы.
- `matchesTerm`: граница слова (`Crown` не совпадает с `Crowning`), диакритика, `mustInclude`.
- `normalizeMentionUrl`: utm снят, хост в нижнем регистре, длинный URL → 40 hex.
- `deriveTerms`: JSON-массив, строка через запятую, пустое → хост без TLD; короткий хост не
  добавляется.
- Wikipedia: разбор `search` и `exturlusage` из фикстур.

## Проверка
```bash
npx tsx --test src/lib/mentions/*.test.ts
npm run check
npx eslint src/lib/mentions src/components/visibility/MentionsPanel.tsx src/app/api/mentions src/lib/mcp/toolsMentions.ts
```

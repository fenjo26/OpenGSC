# N1 — Отпечатки сетки + генератор hreflang

**Ветка:** `feat/wave-nov-n1`. **Владение:** `README.md` §4, строка N1. Дока — `docs/FOOTPRINT.md`.

## Часть A. Отпечатки сетки

### Проблема
При разборе мета-тегов нашлось, что один и тот же шаблон стоит на разных сайтах Руслана:
«{слот} Démo Gratuite : Jouer Sans Inscription ni Dépôt» — на 4 сайтах,
«Stratégie {слот} : Bankroll et Mises — Que Faut-il Faire ?» — на 4 сайтах. Для сетки это
заметный отпечаток: одинаковый скелет title с подставленным названием видно при ручной
проверке и легко связать алгоритмически. Нужен отчёт по портфелю и защита в генераторе.

### Источники (только локальные данные, 0 внешних запросов)
1. **Опубликованное:** последний завершённый `SiteAudit` каждого не архивного сайта →
   `SiteAuditPage.title`, `metaDescription` (H1-текст в базе не хранится — только `h1Count`,
   поэтому H1 в отчёт по опубликованному не входит).
2. **Сгенерированное:** `SeoHistory` типов `outline` и `text` за 180 дней: `meta.title_options[0]`,
   `description_options[0]`, `h1` из аутлайна; из текста — блок меты (`readMetaBlock` из
   `src/lib/seo/metaFit.ts`) и первая строка `# …`. Это ловит шаблон **до** публикации.

### Скелет — `src/lib/footprint/skeleton.ts` (чистые функции)
- Сущности сайта: метка домена без TLD, дефисы → пробелы (`golden-crown-extreme-booster.fr` →
  «golden crown extreme booster»), плюс `Site.brandedKeywords` (разбор — `parseBrandTerms` из
  `aeoTracker.ts`). Для записи истории сущность = её `keyword`.
- `skeletonOf(text, entities)`: fold (NFD без диакритики, нижний регистр) → каждая сущность
  по границе слова → `{x}` (длинные сущности первыми) → числа → `{n}`, годы 2000–2099 → `{y}` →
  пробелы схлопнуты. Скелет, в котором нет `{x}`, сущность не нашёл: он всё равно
  участвует, но помечается `noEntity: true` (совпадение без сущности — ещё сильнее отпечаток).
- Группировка: точный скелет → множество различных `siteId` (для истории — различных
  `keyword`). В отчёт идут группы с числом сайтов ≥ `minSites` (по умолчанию 2) и
  скелетом из ≥ 4 слов (иначе «{x} review» совпадёт у всех — это не отпечаток).
- Похожие: для скелетов, не попавших в точные группы, — Jaccard по множеству слов ≥ 0,85
  (`{x}` не считается). Показывать отдельной секцией «похожие».
- Порог и минимальную длину вынеси в константы и покрой тестами.

### Отчёт — страница `/footprint` и `GET /api/footprint`
- Вкладки «Title» / «Description» / «H1 (сгенерированные)».
- Строка: скелет (с подсвеченными `{x}`), число сайтов, число страниц, пример на каждом сайте
  (URL или запись истории), источник (опубликовано / сгенерировано / оба).
- Сортировка по числу сайтов. Фильтр «только опубликованное».
- Действие «Нормально, скрыть» → `POST /api/footprint/ignore` → скелет попадает в
  `User.footprintIgnore` (JSON-массив) и из отчёта пропадает (переключатель «показать скрытые»).
- Плашка «бесплатно · локальные данные».

### Защита в генераторе — `generate.ts` (только новый блок)
После блока META FIT в `genOutline`:
- Скелеты `title_options` и `description_options` с сущностью = `keyword`.
- Набор «занятых» скелетов портфеля (опубликованное + история **других** ключей, без
  `footprintIgnore`) — кэш в памяти на 1 час.
- Варианты, чей скелет занят, переставить в конец. Если заняты **все** варианты поля — один
  вызов `fetchLLM` (провайдер генерации): «перепиши, не используя эти конструкции: …»,
  3 варианта, проверка кодом (скелет свободен + `fitMetaLocal` в полосе). Не вышло —
  оставить как есть и добавить concern `footprint: <field> reuses a portfolio template`.
- В `prompts.ts` одна строка в блоке МЕТА-ТЕГИ: «не используй шаблонные хвосты; формулировка
  title должна быть уникальной для этого ключа» — без перечисления чужих шаблонов (это раздует
  промпт и подскажет модели те же шаблоны).
- Переключатель в `SeoToolsSettings` не нужен: блок выключается, если в портфеле нет данных.

### MCP — `get_footprints` (local): `kind`, `min_sites`, `include_ignored`.

## Часть B. Генератор hreflang — `/seo-tools/hreflang`

У Руслана сайты с `/` на французском и `/en/` на английском. Валидатор hreflang уже есть в
аудите (`src/lib/audit/hreflang.ts`, октябрь T5). Генератор даёт готовую разметку.

- Ввод: таблица «URL · язык(-регион)» или список URL + правило «префикс пути → язык»
  (`/en/` → `en`, без префикса → `fr`), кнопка «Сгруппировать» собирает альтернативы по
  одинаковому хвосту пути (`/demo/` ↔ `/en/demo/`). Выбор `x-default`.
- Проверка — функциями из `src/lib/audit/hreflang.ts` (импорт, файл не менять): коды,
  дубли, абсолютные URL.
- Выход, три вкладки с кнопкой «Копировать»: `<link rel="alternate" hreflang>` для `<head>`
  каждой страницы · блок `xhtml:link` для sitemap · HTTP-заголовок `Link:`. Плюс скачивание
  sitemap-фрагмента `.xml`.
- «Проверить на сайте»: для до 50 URL `safeFetch` страницы и сравнение того, что стоит сейчас,
  с тем, что должно стоять (diff по каждой странице). Это сеть — подпись «net».
- Чистая логика — `src/lib/hreflang/*.ts`, тесты там же.

## Тесты
- `skeletonOf`: реальные 4 title из прода → один скелет; сущность из дефисного домена; годы и
  числа; `noEntity`; короткий скелет отбрасывается.
- Группировка по разным сайтам; одна и та же фраза на одном сайте — не отпечаток.
- Jaccard-похожие.
- Hreflang: группировка по хвосту пути, `x-default`, вывод трёх форматов (снапшот-строки).

## i18n (N0 создаёт)
| ключ | en | ru |
|---|---|---|
| `fpNavTitle` | Footprints | Отпечатки |
| `fpTitle` | Network footprints | Отпечатки сетки |
| `fpHint` | Templates repeated across your sites. Free, from your own audits and generation history. | Шаблоны, повторяющиеся на разных сайтах. Бесплатно, по вашим аудитам и истории генерации. |
| `fpTabTitle` | Title | Title |
| `fpTabDescription` | Description | Description |
| `fpTabH1` | H1 (generated) | H1 (сгенерированные) |
| `fpSkeleton` | Template | Шаблон |
| `fpSites` | Sites | Сайтов |
| `fpPages` | Pages | Страниц |
| `fpSource_published` | Published | Опубликовано |
| `fpSource_generated` | Generated | Сгенерировано |
| `fpSource_both` | Both | Оба |
| `fpSimilar` | Similar templates | Похожие шаблоны |
| `fpNoEntity` | Identical even without the site name | Совпадает даже без названия сайта |
| `fpIgnore` | Fine, hide | Нормально, скрыть |
| `fpShowIgnored` | Show hidden | Показать скрытые |
| `fpOnlyPublished` | Published only | Только опубликованное |
| `fpEmpty` | No repeated templates found | Повторяющихся шаблонов не найдено |
| `hlTitle` | Hreflang generator | Генератор hreflang |
| `hlHint` | Build hreflang markup for language versions of the same page. | Разметка hreflang для языковых версий одной страницы. |
| `hlPrefixRule` | Path prefix → language | Префикс пути → язык |
| `hlGroup` | Group alternates | Сгруппировать |
| `hlXDefault` | x-default | x-default |
| `hlOutHead` | &lt;head&gt; tags | Теги для &lt;head&gt; |
| `hlOutSitemap` | Sitemap block | Блок для sitemap |
| `hlOutHeader` | HTTP header | HTTP-заголовок |
| `hlCopy` | Copy | Копировать |
| `hlDownload` | Download .xml | Скачать .xml |
| `hlVerify` | Check on the site | Проверить на сайте |
| `hlVerifyOk` | Matches | Совпадает |
| `hlVerifyDiff` | Differs | Отличается |

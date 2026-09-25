# T5 — Пакет правил аудита: hreflang, главный запрос, PageSpeed по выборке, мобильная вёрстка

**Ветка:** `feat/wave-oct-t5` от `feat/wave-oct`, worktree `.worktrees/wave-t5`.
**Владение:** `src/lib/audit/**`, `src/components/SiteAuditPanel.tsx`, `src/app/api/audit/**`.
`src/app/api/gsc/health/route.ts` (там живёт текущий вызов PageSpeed) — **не твой**, только читать.

## Зачем и что уже есть

Руслан спросил, делает ли наш аудит (и одиночный, и bulk на `/audits` — движок у них общий)
то, что обещает SEO-OPTIMIZER: meta, «keywords», скорость, ссылки, мобильную версию.
Ответ по реестру `src/lib/audit/rules.ts`:

| Обещание | У нас |
|---|---|
| Meta title/description отсутствуют, длинные, короткие | есть (`title_*`, `description_*`) |
| Битые ссылки | есть (`broken_links`) |
| Скорость | частично: `slow_response` (время ответа HTML > 3 с) на каждой странице, Core Web Vitals — только для главной во вкладке Health |
| Mobile-friendly | частично: `viewport_missing` |
| Keywords | нет — и «плотность ключей» делать не нужно. Сильнее проверить, что title и H1 содержат запрос, по которому страница **реально** получает показы в GSC. Такие данные есть только у нас |

Сам SEO-OPTIMIZER — README и `.exe` в zip, кода нет. Ничего не скачиваем и не запускаем.

Дополнительно: у Руслана сайты с языковыми версиями (`/` на французском, `/en/` на
английском). Hreflang не проверяется вообще, а ошибки в нём — частая причина, по которой
Google показывает не ту языковую версию.

## Что добавить

Новые правила — в `AUDIT_RULES`, с `titleKey` из `CONTRACT.md` §7.7 (ключи уже в локалях).
Новые факты — в `AuditPageFacts` и в сбор сигналов (`pageSignals.ts`, `crawler.ts`). Для
каждого правила заполняй `evidence` (карта «код → значение») — отчёт должен говорить, **что**
именно не так.

| id | severity | category | scope | affectsScore | Когда срабатывает |
|---|---|---|---|---|---|
| `hreflang_invalid` | warning | metadata | page | да | Код не по BCP 47 / ISO 639-1 (+ ISO 3166-1 регион): `en-UK`, `fr_FR`, `eng`; относительный или не-http URL; один язык указан дважды с разными URL |
| `hreflang_no_return` | warning | metadata | site | да | A → B, B просканирована, но в её наборе нет ссылки на A |
| `hreflang_self_missing` | info | metadata | page | нет | Набор есть, но без самой страницы |
| `hreflang_target_bad` | warning | metadata | page | да | Цель просканирована и отдаёт ≠ 200, редирект, `noindex` или canonical на другой URL |
| `hreflang_x_default_missing` | info | metadata | site | нет | Набор из ≥ 2 языков без `x-default` |
| `lang_hreflang_mismatch` | info | content | page | нет | Язык `<html lang>` ≠ языку своей hreflang-записи (сравнивать только первичный субтег) |
| `viewport_not_responsive` | warning | rendering | page | да | viewport есть, но без `width=device-width`, либо `user-scalable=no`, либо `maximum-scale` < 2 |
| `images_no_dimensions` | info | performance | page | нет | ≥ 1 `<img>` без `width` **и** `height` (атрибуты или `style`), кроме `data:`/SVG-иконок < 32 px, если размер указан |
| `internal_redirect_links` | warning | links | page | да | Страница ссылается на внутренние URL, которые при сканировании ответили 3xx. evidence — до 5 таких ссылок |
| `html_too_large` | info | performance | page | нет | Декодированный HTML > 2 МБ |
| `title_query_mismatch` | info | content | page | нет | См. ниже |
| `cwv_poor` | warning | performance | page | нет | Только для страниц из выборки PageSpeed, см. ниже |

Hreflang читается из трёх мест: `<link rel="alternate" hreflang>` в `<head>`, HTTP-заголовок
`Link` и sitemap (`xhtml:link`). Если хотя бы в одном источнике набор есть — страница «с
hreflang». Разбор — в `hreflang.ts` (чистые функции), кросс-проверки делаются в том же проходе
по всем страницам, где сейчас считаются `titleDuplicate` и `internalInboundLinks`. Цели вне
просканированного множества **не** проверяются отдельными запросами: `unknown` — это не ошибка.

### Главный запрос страницы — `queryAlign.ts`
- Источник — `DailyMetric` сайта за 28 дней: строки с `url = <страница>`, `query ≠ ''`,
  `searchType = "web"`. Главный запрос — с максимальными показами, если у него ≥ 20 показов.
- Правило срабатывает, если **ни** title, **ни** H1 не содержат ни одного значимого токена
  запроса. Токены — после нормализации (нижний регистр, без диакритики, стоп-слова en/fr/es/de/
  it/pt/ru/el/uk в модуле). Совпадение по началу слова (≥ 4 символа), чтобы `casino` совпало с
  `casinos`, а `rtp` — только целиком.
- Для этого `pageSignals.ts` отдаёт текст первого H1 (`h1Text`, ≤ 200 символов).
- Evidence — `auditEvidenceQuery` («Главный запрос: «…» · N показов / 28 дн»).
- Данные читаются **одним** запросом на аудит (группировка по `url`), а не по запросу на
  страницу. Нет GSC-данных → правило молчит.
- URL в `DailyMetric` и URL аудита могут отличаться слешем и `www`. Нормализуй обе стороны
  одной функцией и покрой тестом.

### PageSpeed по выборке — `psi.ts`
- Ключ PageSpeed берётся так же, как его берёт `src/app/api/gsc/health/route.ts` (прочитай
  файл, повтори поиск ключа у себя; сам файл не меняй). Нет ключа → `summary.psi = { status:
  "unavailable" }` и `auditPsiUnavailable` в UI. Не ошибка и не штраф.
- Выборка: главная + по одной странице на «шаблон». Шаблон = первый сегмент пути, у которого
  ≥ 3 страницы; внутри шаблона берётся страница с наибольшим числом входящих внутренних
  ссылок. Максимум 5 URL (вынеси в константу). Только страницы с 200 и без noindex.
- Запрос: `runPagespeed?url=…&strategy=mobile&category=performance`, таймаут 60 с,
  параллельно ≤ 2. Если есть `loadingExperience.metrics` — полевые данные (`auditPsiField`),
  иначе лабораторные (`auditPsiLab`). Сохраняются LCP, INP (только полевой), CLS, TTFB и оценка.
- Результат — в `SiteAudit.summary` (JSON) в поле `psi: { status, items: [...] }`.
  Новых колонок нет.
- `cwv_poor` — для страницы из выборки: полевые LCP > 4 с, или INP > 500 мс, или CLS > 0,25
  (пороги Google «poor»); при лабораторных — только LCP и CLS. `affectsScore: false`: пять страниц
  — выборка, а не сайт.
- Этап идёт после краулинга и не держит аудит: если PSI не ответил за отведённое время,
  аудит завершается, а `psi.status = "partial"`.
- Квота PSI бесплатная (25 000 в день), но это внешний сетевой вызов — через журнал провайдеров,
  провайдер `pagespeed`, стоимость 0.

### Пороги мета — только из `metaLimits.ts`
`title_too_long` / `title_too_short` / `description_*` читают `META_LIMITS.*.auditMin/auditMax`
вместо литералов `65`, `50`, `165`, `150`. Значения те же, поведение не меняется. Это нужно,
чтобы генератор (T1) и аудит больше не расходились.

## UI — `SiteAuditPanel.tsx`
- Новые правила появятся в списке сами (через реестр и `titleKey`). Проверь, что evidence
  выводится для каждого.
- Карточка `auditPsiTitle` над списком проблем: таблица «URL · LCP · INP · CLS · оценка ·
  field/lab», пороговые цвета с текстом, а не только цветом; `auditPsiHint`.
- У проблем `title_too_long | title_too_short | description_too_long | description_too_short`
  кнопка `metaFitSuggest`. Она вызывает `POST /api/seo/meta-fit` (маршрут T1, контракт §4) с
  `items` из затронутых страниц: `keyword` = главный запрос из `queryAlign`, а без него — H1;
  `language` = `htmlLang`. Сначала без `allowLlm`, потом, если что-то осталось вне полосы,
  предложить `metaFitRunLlm` с подтверждением `metaFitConfirm`. Результат — таблица «было / стало /
  длина» с кнопкой `metaFitCopy`. В базу ничего не пишется: сайт Руслан пересобирает сам.
  До слияния T1 маршрут отвечает 501. Покажи понятную ошибку, а не пустоту.
- `exportMd.ts`: PSI-таблица и новые правила в Markdown-отчёте.

## Верификация повторным сканированием
`verification.ts` сравнивает наборы правил между аудитами. Новые правила появятся в «новых»
проблемах первого же аудита после релиза. Пометь это: если в базовом аудите правила ещё не
было (нет в его `summary`), это не регрессия. Проверь, как `verification.ts` отличает
«правила не существовало» от «проблемы не было», и если не отличает — добавь это.

## Тесты
- `src/lib/audit/hreflang.test.ts`: валидные и невалидные коды (`en`, `en-GB`, `zh-Hant`,
  `x-default`, `en-UK` ✗, `fr_FR` ✗, `eng` ✗); отсутствие обратной ссылки; цель-редирект;
  цель вне скана → не ошибка; слияние трёх источников.
- `src/lib/audit/queryAlign.test.ts`: `casino` ↔ `casinos`; стоп-слова; диакритика
  (`démo` ↔ `demo`); нормализация URL (слеш, `www`); запрос с < 20 показами игнорируется.
- `rules.test.ts` (уже зарегистрирован): каждое новое правило срабатывает на своём факте и не
  срабатывает на соседнем; пороги мета совпадают с `META_LIMITS`.
- PSI: выбор выборки (чистая функция), разбор ответа PSI из фикстуры (сохрани реальный ответ
  в `src/lib/audit/__fixtures__/psi-mobile.json`, ключ API из фикстуры убери).

## Проверка
```bash
npx tsx --test src/lib/audit/*.test.ts
npm run check
npx eslint src/lib/audit src/components/SiteAuditPanel.tsx src/app/api/audit
```
Ручная — пункт 5 чеклиста `README.md` §8 на `triple-beasts-of-fortune.fr` (есть `/en/`).

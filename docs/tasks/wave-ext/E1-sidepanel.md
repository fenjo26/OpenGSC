# E1 — Side Panel и разбор страницы

Сделать из попапа боковую панель, которая заменяет на каждый день SEO META in 1 CLICK и
MineOrganic SEO Vision. Всё в этой задаче считается **локально в браузере**, сервер нужен
только для существующего `GET /api/ext/page`.

Владеешь: `sidepanel.html/.css`, `panel/core.js`, `panel/tab-page.js`, `bg/panel.js`,
`popup.*`, `content.js`, `lib/audit.js`, `lib/csv.js`, `lib/vitals.js`, `lib/highlight.js`,
`lib/export.js`, `src/lib/ext/audit.test.ts`, `src/lib/ext/auditDetail.test.ts`,
`docs/EXTENSION.md`.

## 1. Открытие панели — `bg/panel.js`

- На загрузке воркера: если есть `chrome.sidePanel` →
  `setPanelBehavior({ openPanelOnActionClick: true })`; иначе `chrome.action.setPopup({ popup: "popup.html" })`.
- `MSG_OPEN_PANEL` от попапа или оверлея → `chrome.sidePanel.open({ tabId: sender.tab.id })`
  (для попапа — `windowId`). Это работает только в ответ на жест пользователя, поэтому
  сообщение шлют из обработчика клика.
- Панель **одна на окно** (`open({ windowId })`): она должна следовать за активной вкладкой, а
  не жить на одной.

## 2. Ядро — `panel/core.js`

Реестр вкладок и `ctx` — строго по `CONTRACT.md` §4.4.

**Какая страница анализируется.** Активная вкладка текущего окна: `chrome.tabs.query({ active: true, currentWindow: true })`
при старте, затем `tabs.onActivated` и `tabs.onUpdated` (`status === "complete"` и это активная
вкладка). Debounce 300 мс. Пока идёт новый анализ, старый результат остаётся на экране с
пометкой «обновляется…». Не мигать пустым экраном.

**Инъекция и разрешения.** Порядок:

1. URL с `chrome://`, `edge://`, `chrome-extension://`, `view-source:`, Chrome Web Store,
   PDF-вьюер → `scanError: "restricted_page"`, текст `panelRestricted`.
2. `executeScript({ files: PANEL_INJECT })`. Если Chrome ответил ошибкой доступа:
   - `settings.panelAllSites === false` → `scanError: "no_permission"`, экран с двумя
     кнопками: «Анализировать эту страницу» (это клик по иконке: просто подсказка
     `panelClickIcon`, потому что `activeTab` выдаётся только кликом по иконке или пункту
     меню) и «Разрешить для всех сайтов» → `ExtSettings.requestAllSites()` → `refresh()`;
   - иначе → `"injection_failed"` с текстом ошибки мелко.
3. Параллельно — `ExtApi.page(url)` → `ctx.summary` (если инстанс не настроен — `null` и
   плашка «Подключите OpenGSC в настройках», но разбор страницы всё равно работает).

Кеш: результат `GET /api/ext/page` — в `ctx.cache` на 10 минут по URL. Скан страницы не
кешируется (он дешёвый и страница меняется).

**Шапка:** favicon + хост, кнопка «Обновить», переключатель «Подсветить» (§5), меню «Экспорт»
(§6), шестерёнка → настройки. Под шапкой — вкладки из реестра, у которых `applies(ctx)` true.

**Тема:** `prefers-color-scheme`, свои CSS-переменные в `sidepanel.css`. Ширина панели у
пользователя 320–600 px — вёрстка должна работать на 320.

## 3. Факты — `lib/audit.js` + `content.js`

`collectFacts` остаётся как в N11 (тесты N11 не трогать и не ломать) и **добавляет**
`facts.detail` строго по `CONTRACT.md` §4.3. Пределы (≤ 500 заголовков, ≤ 2000 ссылок,
≤ 1000 картинок) — чтобы ответ executeScript не раздувался на гигантских страницах; при
обрезке — флаг `detail.truncated: { headings?: true, links?: true, images?: true }`, панель
показывает «показаны первые N».

Детали, которые легко сделать неправильно:

- **Скрытые заголовки** — `hidden: true`, если `getComputedStyle` даёт `display:none`,
  `visibility:hidden` или размер 0×0. Их показываем серыми, а не прячем: скрытый H1 — это
  находка.
- **Ссылки:** `href` — абсолютный (`a.href`), `javascript:`, `mailto:`, `tel:` и `#…` на ту же
  страницу — отдельные пометки, во внутренние/внешние не идут. `internal` — тот же
  registrable-домен, что у страницы (`www.` и поддомены одного сайта — внутренние). Для
  registrable хватит простого правила «последние две метки, а для двухуровневых суффиксов
  (`co.uk`, `com.gr`, `com.au` …) — три»; список суффиксов скопируй из
  `TWO_LABEL_SUFFIXES` в `src/lib/drops/registries.ts` (там он не экспортирован — копируй
  текстом; классический JS без импорта). Функцию назови `ExtensionAudit.registrableOf(host)`
  и в `auditDetail.test.ts` сверь её с `apexOf()` из `registries.ts` на 40+ хостах, включая
  все двухуровневые суффиксы из того списка: поменяли список там — тест упадёт здесь.
- **rel** — токены в нижнем регистре; `nofollow`, `sponsored`, `ugc` отдельно считаются в
  `counts`.
- **area** — правило из контракта. Порог 150 символов — константа `TEXT_BLOCK_MIN` в
  `audit.js`, E3 её использует.
- **Картинки:** `alt === null` (атрибута нет) и `alt === ""` (декоративная) — разные вещи.
  Без alt — проблема, пустой alt — нет. `ext` — из пути `src` (`webp`, `avif`, `jpg`, `png`,
  `svg`, `gif`, `""`). `lazy` — `loading="lazy"` или `data-src` без `src`.
- **JSON-LD:** `types` — все `@type`, включая вложенные в `@graph`; невалидный JSON →
  `valid: false`, `error` — первые 120 символов сообщения.

`content.js` возвращает `PageScan` (§4.3). `ExtVitals.collect()` возвращает Promise — дождись
его с таймаутом 1500 мс (если не успел — `null` в полях).

## 4. Вкладка «Страница» — `panel/tab-page.js`

`Panel.register({ id: "page", order: 10, applies: () => true, … })`. Внутри — подвкладки:

| Подвкладка | Содержимое |
|---|---|
| **Обзор** | Title и Description с длиной и полосой (границы из `META_LIMITS`, цвет + текст «норма / коротко / длинно»), URL и canonical (пометка, если canonical ведёт на другой URL), meta robots + `noindex`, `lang`, viewport, число слов. Ниже — список проблем, сгруппированный Meta / Контент / Техника / Скорость / Доступность, с количеством в заголовке группы. |
| **Заголовки** | Дерево H1–H6 с отступами по уровню, в порядке HTML. Пометки: нет H1, несколько H1, пропуск уровня (H2 → H4), пустой, скрытый. Клик по заголовку — прокрутка к нему на странице (`executeScript` с функцией `scrollIntoView` по индексу). |
| **Ссылки** | Сводка: всего / внутренние / внешние / уникальные / nofollow / sponsored / ugc. Таблица: анкор, URL, rel, область. Фильтры: внутренние / внешние / nofollow / по области. Поиск по тексту. |
| **Картинки** | Сводка: всего / без alt / с пустым alt / без размеров / lazy. Таблица: миниатюра 40 px (из `src`; если не грузится — значок), alt, размеры, формат. |
| **Schema** | Типы JSON-LD (валидные и нет, с ошибкой), типы microdata. Кнопка «Rich Results Test» → `https://search.google.com/test/rich-results?url=<url>` в новой вкладке. |
| **Social** | Карточка-превью Open Graph (картинка, заголовок, описание, домен) и Twitter; таблица всех og:* и twitter:*. Пометки об отсутствующих обязательных (`og:title`, `og:description`, `og:image`, `og:url`). |
| **robots и sitemap** | `fetch(origin + "/robots.txt")` из панели. Показать текст (моноширинный, до 50 КБ). Вердикт «этот URL закрыт для Googlebot: да/нет и каким правилом» — чистая функция `robotsAllows(robotsTxt, userAgent, path)` по правилам Google (самое длинное совпадение, `*` и `$`, Allow побеждает при равной длине). Список `Sitemap:` из robots + проверка `/sitemap.xml`. Кнопка «Найти этот URL в sitemap» — грузит sitemap (индекс — не глубже одного уровня, ≤ 20 дочерних, каждый ≤ 5 МБ) и ищет URL; результат «найден в <файл>» / «не найден в N файлах». Если `fetch` упал из-за прав — кнопка «Разрешить» (`requestAllSites`). |
| **Скорость** | LCP, FCP, TTFB, CLS с порогами Google (LCP ≤ 2,5 / ≤ 4 с; FCP ≤ 1,8 / ≤ 3 с; TTFB ≤ 0,8 / ≤ 1,8 с; CLS ≤ 0,1 / ≤ 0,25), DOM-узлы, вес переданного. Подпись: «Измерено в вашем браузере, это лабораторные данные, не CrUX». INP — «нужно взаимодействие, не измеряется». Кнопка «PageSpeed Insights» → `https://pagespeed.web.dev/analysis?url=<url>`. |

Новые id проблем в `deriveIssues` (чистая функция, N11-проблемы остаются как есть):

| id | серьёзность | группа | условие |
|---|---|---|---|
| `h1_missing` | error | content | нет видимого H1 |
| `h1_multiple` | warning | content | видимых H1 больше одного |
| `heading_skip` | info | content | есть переход уровня больше чем на 1 вниз |
| `heading_empty` | warning | content | заголовок без текста |
| `images_no_dims` | info | performance | у ≥ 1 картинки нет width/height (атрибуты или CSS aspect-ratio не учитываем — пишем «нет атрибутов») |
| `html_lang_missing` | warning | accessibility | нет `<html lang>` |
| `viewport_missing` | warning | technical | нет meta viewport |
| `link_empty_text` | warning | accessibility | ссылка без текста, без `aria-label` и без картинки с alt |
| `canonical_other` | info | meta | canonical указывает на другой URL (не считая слэша в конце и `#`) |
| `mixed_content` | warning | technical | страница по https, а картинки/скрипты по http |
| `lcp_poor` / `cls_poor` | warning | performance | выше верхнего порога |

Группа N11-проблем — по смыслу (title/description/canonical/og → meta; jsonld → technical;
images_no_alt → accessibility).

**Оценка страницы** — как у MineOrganic, но прозрачная: 100 минус 10 за error, 4 за warning,
1 за info, не ниже 0. При наведении — формула и список того, что сняло баллы. Если скан не
удался — оценки нет («—»), а не 0.

## 5. Подсветка — `lib/highlight.js`

Включается кнопкой в шапке. `executeScript({ func: ExtHighlight.apply, args: [spec] })`, где
`spec` — какие типы подсвечивать: `images_no_alt` (красная рамка), `h1` (оранжевая, с
номером), `nofollow` (синяя пунктирная), `external` (серая пунктирная), `empty_links`.
Чекбоксы типов — в выпадашке рядом с кнопкой.

Реализация: **один** элемент `<opengsc-highlight>` в конце `body` с shadow root; внутри —
абсолютно позиционированные рамки по `getBoundingClientRect()` + `scrollX/Y`, пересчёт на
`scroll`/`resize` через `requestAnimationFrame`. Элементам страницы не добавлять ни
атрибутов, ни классов, ни стилей. `ExtHighlight.clear()` удаляет host и слушатели. Повторный
`apply` сначала делает `clear`. При смене вкладки или URL подсветка снимается.

## 6. Экспорт — `lib/export.js`

Из меню шапки: CSV ссылок, CSV картинок, CSV заголовков, JSON всего `PageScan`. Скачивание —
Blob + `<a download>` в панели. Имя файла: `<host>_<что>_<YYYY-MM-DD>.csv`. CSV — через
`lib/csv.js` (экранирование уже есть), с BOM для Excel.

## 7. `lib/vitals.js`

`ExtVitals.collect()` → Promise<Vitals>. `PerformanceObserver` с `buffered: true` на
`largest-contentful-paint`, `paint`, `layout-shift` (CLS — сумма без `hadRecentInput`, по
сессионным окнам как в web-vitals: окно 5 с, пауза 1 с, берётся максимум), TTFB из
`navigation` (`responseStart − startTime`, если `activationStart` > 0 — вычесть).
`transferKb` — сумма `transferSize` по `resource` + `navigation`; если всё 0 (кросс-доменные
без `Timing-Allow-Origin`) — `null`, не 0. Отключить наблюдатели после сбора.

## 8. Попап

Остаётся как запасной вариант (`setPopup` из §1) и сейчас ещё виден в браузерах без
`sidePanel`. Добавь сверху кнопку «Открыть боковую панель» (`MSG_OPEN_PANEL`), остальное
не трогай.

## 9. Тесты

- `src/lib/ext/audit.test.ts` — N11-тесты остаются зелёными.
- `src/lib/ext/auditDetail.test.ts` — новые id `deriveIssues` (на фикстурах фактов),
  `robotsAllows` (минимум 12 случаев: `*`, `$`, длина правила, Allow vs Disallow, группа по
  user-agent, пустой Disallow), оценка страницы, сверка `registrableOf` с `apexOf`. DOM-половина (`collectFacts`, `area`, `hidden`) проверяется руками — в
  отчёт перечисли страницы: Википедия, любая статья на WordPress, сайт на табличной вёрстке
  (архив 2005 г. из Wayback), SPA (React), свой сайт сетки трансферов.

## 10. `docs/EXTENSION.md`

Переписать под новую версию: установка распакованного, токен и ID расширения, какие
разрешения и зачем (`tabs`, «все сайты» по желанию, домены Google по желанию), что уходит на
сервер (URL, хосты, title/description/H1, сниппеты) и что не уходит (HTML, тексты страниц),
вкладки панели, подсветка, экспорт. Про оверлей и донора — по разделу, тексты возьми из
брифов E3/E4 (напиши кратко, R поправит после приземления).

## 11. Ключи (расширение, en · ru)

| ключ | en | ru |
|---|---|---|
| `panelRefresh` | Refresh | Обновить |
| `panelUpdating` | Updating… | Обновляется… |
| `panelRestricted` | This page can't be analyzed (browser or store page). | Эту страницу проанализировать нельзя (служебная страница браузера или магазина). |
| `panelNoPermission` | No access to this page yet. | Пока нет доступа к этой странице. |
| `panelClickIcon` | Click the OpenGSC icon to analyze this page | Нажмите на иконку OpenGSC, чтобы проанализировать страницу |
| `panelAllowAll` | Allow on all sites | Разрешить для всех сайтов |
| `panelInjectFailed` | Couldn't read the page: $1 | Не удалось прочитать страницу: $1 |
| `panelConnectHint` | Connect OpenGSC in settings to see your data here | Подключите OpenGSC в настройках, чтобы видеть здесь свои данные |
| `panelOpen` | Open side panel | Открыть боковую панель |
| `panelHighlight` | Highlight | Подсветить |
| `panelExport` | Export | Экспорт |
| `panelTruncated` | Showing the first $1 | Показаны первые $1 |
| `panelScore` | Page score | Оценка страницы |
| `panelScoreFormula` | 100 − 10 per error − 4 per warning − 1 per notice | 100 − 10 за ошибку − 4 за предупреждение − 1 за замечание |
| `tabPage` | Page | Страница |
| `pageOverview` | Overview | Обзор |
| `pageHeadings` | Headings | Заголовки |
| `pageLinks` | Links | Ссылки |
| `pageImages` | Images | Картинки |
| `pageSchema` | Schema | Schema |
| `pageSocial` | Social | Соцсети |
| `pageRobots` | robots & sitemap | robots и sitemap |
| `pageSpeed` | Speed | Скорость |
| `pageLenOk` | OK | Норма |
| `pageLenShort` | Too short | Коротко |
| `pageLenLong` | Too long | Длинно |
| `pageCanonicalOther` | Canonical points to another URL | Canonical ведёт на другой URL |
| `pageGroupMeta` | Meta | Мета |
| `pageGroupContent` | Content | Контент |
| `pageGroupTechnical` | Technical | Техника |
| `pageGroupPerformance` | Speed | Скорость |
| `pageGroupAccessibility` | Accessibility | Доступность |
| `pageHidden` | hidden | скрыт |
| `pageSkip` | level skipped | пропущен уровень |
| `pageLinksInternal` | Internal | Внутренние |
| `pageLinksExternal` | External | Внешние |
| `pageLinksUnique` | Unique | Уникальные |
| `pageAreaContent` | in text | в тексте |
| `pageAreaNav` | menu | меню |
| `pageAreaHeader` | header | шапка |
| `pageAreaFooter` | footer | подвал |
| `pageAreaAside` | sidebar | сайдбар |
| `pageAreaTop` | top of body | вверху body |
| `pageAreaOther` | other | другое |
| `pageNoAlt` | No alt | Без alt |
| `pageEmptyAlt` | Empty alt | Пустой alt |
| `pageNoDims` | No size | Без размеров |
| `pageRichTest` | Rich Results Test | Проверка расширенных результатов |
| `pageRobotsBlocked` | Blocked for Googlebot by: $1 | Закрыт для Googlebot правилом: $1 |
| `pageRobotsAllowed` | Allowed for Googlebot | Открыт для Googlebot |
| `pageRobotsMissing` | No robots.txt | robots.txt нет |
| `pageSitemapFind` | Find this URL in sitemap | Найти этот URL в sitemap |
| `pageSitemapFound` | Found in $1 | Найден в $1 |
| `pageSitemapNotFound` | Not found in $1 files | Не найден в $1 файлах |
| `pageLabNote` | Measured in your browser — lab data, not CrUX | Измерено в вашем браузере — лабораторные данные, не CrUX |
| `pageInpNote` | Needs an interaction — not measured | Нужно взаимодействие — не измеряется |
| `pagePsi` | PageSpeed Insights | PageSpeed Insights |
| `exportLinks` | Links (CSV) | Ссылки (CSV) |
| `exportImages` | Images (CSV) | Картинки (CSV) |
| `exportHeadings` | Headings (CSV) | Заголовки (CSV) |
| `exportJson` | Everything (JSON) | Всё (JSON) |
| `hlImagesNoAlt` | Images without alt | Картинки без alt |
| `hlH1` | H1 headings | Заголовки H1 |
| `hlNofollow` | nofollow links | nofollow-ссылки |
| `hlExternal` | External links | Внешние ссылки |
| `hlEmptyLinks` | Links without text | Ссылки без текста |
| `audit_h1_missing` | No H1 | Нет H1 |
| `audit_h1_multiple` | More than one H1 | Больше одного H1 |
| `audit_heading_skip` | Heading level skipped | Пропущен уровень заголовка |
| `audit_heading_empty` | Empty heading | Пустой заголовок |
| `audit_images_no_dims` | Images without width/height | Картинки без width/height |
| `audit_html_lang_missing` | No `<html lang>` | Нет `<html lang>` |
| `audit_viewport_missing` | No meta viewport | Нет meta viewport |
| `audit_link_empty_text` | Links without text | Ссылки без текста |
| `audit_canonical_other` | Canonical points to another URL | Canonical ведёт на другой URL |
| `audit_mixed_content` | HTTP resources on an HTTPS page | HTTP-ресурсы на HTTPS-странице |
| `audit_lcp_poor` | Slow LCP | Медленный LCP |
| `audit_cls_poor` | High CLS | Высокий CLS |

(Ключи проблем в N11 строятся как `audit_<id>` — `popup.js` так их и читает. Держись того же.)

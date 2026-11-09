# E4 — оверлей выдачи Google (сторона расширения)

На странице результатов Google под каждым органическим результатом — короткая строка с тем,
что OpenGSC знает об этом хосте. Над выдачей — шапка с данными по самому запросу и кнопками.
Всё из своей базы, бесплатно. Платное — только по кнопке и со сметой.

Владеешь: `extension/serp/overlay.js`, `extension/lib/serpParse.js`, `extension/bg/serp.js`,
`src/lib/ext/serpParse.test.ts`. Сервер — E5, формы ответов — `CONTRACT.md` §2.

## 1. Как скрипт попадает на страницу

Регистрацию делает `ExtSettings.syncOverlayRegistration()` (E0): content-скрипт
`opengsc-serp` = `lib/protocol.js`, `lib/serpParse.js`, `serp/overlay.js` на
`https://<домен>/search*` для доменов, включённых в настройках. `bg/serp.js` отвечает за:

- кеш ответов `hosts` в `chrome.storage.session` (ключ — `query|gl|hl|page|hash(hosts)`,
  TTL 10 мин), чтобы «назад» в браузере и повторные открытия не тратили лимит 60/мин;
- `MSG_API` уже проксирует E0. Свой обработчик в `bg/serp.js` — только `MSG_SERP_HOSTS`
  (кеш + `ExtApi.hosts`) и `MSG_SERP_INVALIDATE` (сброс кеша запроса после действия). Имена
  уже лежат в `protocol.js` (контракт §5).

## 2. Разбор выдачи — `lib/serpParse.js`

Два слоя. **Чистый** слой покрыт тестами, **DOM-слой** тонкий и проверяется руками.

```js
var SerpParse = {
  // pure
  locale: function (pageUrl, htmlLang) → { engineHost, country, lang, page, startPos, query, device },
  resultUrl: function (rawHref, pageOrigin) → string | null,  // /url?q=… → real URL; google.*, webcache, translate → null
  isOrganicHost: function (host) → boolean,                   // false for google.*, youtube.com/redirect, accounts.google…
  dedupe: function (rows) → rows,                             // same URL twice (sitelinks) → first position wins
  // DOM
  parse: function (document) → { meta: locale(...), results: [{ position, url, host, title, snippet, node }], features: string[] } | null
};
```

**locale:**
- `query` — параметр `q`, `normaliseKeyword`-подобно: trim, схлопнуть пробелы, нижний регистр
  (сервер нормализует ещё раз сам).
- `country` — `gl`, если есть; иначе ccTLD домена (`google.gr` → `gr`, `google.co.uk` → `gb`,
  `google.com` → `""`); `lang` — `hl`, иначе `htmlLang` (`<html lang>`, первые 2 буквы).
  **Не угадывать:** неизвестно — значит `""`, а сервер тогда не сужает проекты SERP Monitor.
- `page` = `floor(start / 10) + 1`, `startPos` = `start + 1` (без `start` — 1). При
  бесконечной прокрутке Google подгружает следующие страницы в тот же DOM — позиции считаем
  сквозными по порядку в DOM, а `page` — по первой странице.
- `device` — `"mobile"`, если ширина окна < 700 и в DOM есть мобильная разметка; иначе `"desktop"`.

**parse (DOM):** органические результаты — блоки внутри `#rso` (запасной вариант — `#search`),
у которых есть `a[href] h3` или `a[href] [role="heading"]`. Исключить: рекламу (`#tads`,
`#tadsb`, `[data-text-ad]`, блоки с подписью «Реклама/Sponsored»), «Похожие вопросы» (PAA),
карусели «Главные новости», видео-карусели, локальный блок, картинки, блоки, вставленные
другими расширениями (нет `h3` внутри ссылки Google-результата, есть их корневые классы —
Keywords Everywhere вставляет свои `div` внутрь результата: их ссылки не брать). Snippet —
текст блока описания (`[data-sncf]`, `.VwiC3b` или `div[style*="-webkit-line-clamp"]`, в
любом порядке, первый непустой), до 300 символов. Классы Google обфусцированы и меняются,
поэтому каждый селектор — со списком запасных, а сам список — константа наверху файла.

`features` — по наличию блоков: `ai_overview` (блок «Обзор от ИИ / AI Overview»), `paa`,
`local_pack`, `top_stories`, `video`, `images`, `shopping`, `knowledge_panel`, `sitelinks`.
Список — `CAPTURE_FEATURES` из контракта.

Не нашлось ни одного результата → `null`, одна строка `console.debug("[opengsc] serp: no results matched")`
и тишина.

**Фикстуры:** сохрани 4–6 реальных выдач (Chrome → «Сохранить как → Веб-страница, только HTML»):
`bizzo casino italia` на google.it, коммерческий запрос на google.gr, запрос с AI Overview и
PAA на google.com, вторая страница (`start=10`), выдача с включённым Keywords Everywhere.
Положи их в `src/lib/ext/__fixtures__/serp/`. **Сохраняй в окне инкогнито без входа в
аккаунт Google**: в обычном окне в HTML попадут имя и e-mail, а фикстуры лежат в публичном
репозитории. Перед коммитом — `grep -il "@gmail\|accounts.google.com/SignOutOptions"` по папке. jsdom в репозитории нет, поэтому тесты гоняют по ним чистый слой (`resultUrl`, `locale`
на URL из фикстур); DOM-разбор фикстур проверь руками, открыв их в браузере с расширением, и
запиши в отчёт результат (сколько органики найдено против того, сколько видно глазами).

## 3. Отрисовка — `serp/overlay.js`

Порядок: `SerpParse.parse(document)` → `chrome.runtime.sendMessage({ type: ExtProtocol.MSG_SERP_HOSTS, body: { hosts, query, country, lang } })`
→ отрисовка. `MutationObserver` на `#rso`/`#search` (debounce 500 мс) — для бесконечной
прокрутки и перерисовок Google: новые результаты получают строку, старые не трогаем.

**Строка под результатом** — один shadow-host `<opengsc-serp-row>` после блока заголовка (перед
сниппетом). Стили — внутри shadow root, цвета под светлую и тёмную тему Google
(`prefers-color-scheme` + проверка фона `body`). Состав (пусто — значит, не показываем, а не
«0»):

`[Ваш сайт: site.gr]` `DR 45` `5 лет` `SERP Monitor: 12 запр., топ-10: 4, с сен 2026` `[новый]/[растёт]/[отскок]` (теги) `→ ссылается на вас: 3` `Outreach: contacted` `Дроп: под наблюдением` `PBN` `⋯`

- Свой сайт — строка подсвечена и показывает GSC по этому запросу: «ваш URL: клики 12,
  показы 340, поз. 4.2 (GSC, 28 дн.)» из `query.own` (если URL результата совпадает —
  иначе «по запросу у вас ранжируется другой URL: …» — это каннибализация, её видно сразу).
- DR без значения — «DR —»; при наведении «нет в базе. Узнать бесплатно → в шапке».
- В компактном режиме (`settings.serpCompact`) — только пилюли без подписей.

**Меню `⋯`** у результата:
- «В Outreach» (`/api/ext/outreach` с URL результата);
- «Следить как дроп» (`serp/action` `drops_watch`);
- «Проверить клоакинг» → `cloak` с `url`, `title`, `snippet`. Ответ рисуется под строкой:
  вердикт («одинаково / отличается / бот заблокирован / ошибка») + причины + «сниппет найден:
  у бота да / у браузера нет». Пока идёт запрос (до 30 с) — спиннер. Лимит сервера 6/мин;
  `429` → «Подождите минуту»;
- «Открыть домен в SERP Monitor» → `<instance>/serp-monitor/<projectId>?tab=domains&q=<host>`
  (если хост есть в проекте).

**Шапка над выдачей** — shadow-host перед `#rso`, одна строка, сворачивается:
- запрос и регион (`gl/hl` или «регион не определён»);
- **Ваши позиции:** из `query.own` — по каждому своему сайту URL, клики, позиция (GSC);
  `query.tracked` — «в Rank Tracker: поз. 7 (вчера)»;
- **SERP Monitor:** «отслеживается в проекте X · последний прогон без шторма / ⚠ шторм»;
- **Метрики запроса:** только из кеша (`query.metrics`): «объём 1 900 · KD 35 · данные от
  12.10»; кеша нет → ничего не показывать;
- кнопки: «В Rank Tracker» (сайт — свой сайт из выдачи, иначе `settings.defaultSiteId`, иначе
  выпадашка из `ExtApi.lists()`), «В SERP Monitor» (проект с тем же `country/lang`, иначе
  `settings.defaultProjectId`, иначе выпадашка), **«Сохранить выдачу»** (`capture`, после
  успеха — «сохранено · открыть»), «Узнать возраст и DR для N хостов (бесплатно)» если
  `missing.age + missing.dr > 0` (→ `enrich` пачками по 20, затем перезапрос `hosts` с
  `MSG_SERP_INVALIDATE`).

Все кнопки сообщают результат прямо в шапке/строке, без `alert()` (диалоги браузера блокируют
расширение). Ошибки — текстом по коду (`CONTRACT.md` §3). Если OpenGSC не настроен или токен
неверный — **одна** плашка в шапке «OpenGSC: подключите расширение в настройках» и ни одной
строки под результатами.

**Без следов:** только наши shadow-host'ы, никаких атрибутов на элементах Google; выключение
оверлея в настройках → `unregisterContentScripts`, и при следующей загрузке страницы ничего нет.

## 4. Производительность

- Один запрос `hosts` на страницу (до 100 хостов). Бесконечная прокрутка — один дозапрос
  только по новым хостам.
- Отрисовка — после `document_idle`; парсинг и рендер ≤ 50 мс на 100 результатов (замерь
  `performance.now()` и напиши в отчёт).
- Ничего не делать, если вкладка в фоне (`document.visibilityState === "hidden"`): дождаться
  `visibilitychange`.

## 5. Тесты — `src/lib/ext/serpParse.test.ts`

`resultUrl` (прямые ссылки, `/url?q=`, `/url?url=`, google-внутренние → null, кривые href),
`locale` (gl/hl, ccTLD без gl, `co.uk` → `gb`, `start`, без `q`), `isOrganicHost`, `dedupe`.
Плюс проверка, что `CAPTURE_FEATURES` из `types.ts` и список фич в `serpParse.js` совпадают.

## 6. Ключи (расширение, en · ru)

| ключ | en | ru |
|---|---|---|
| `serpYourSite` | Your site: $1 | Ваш сайт: $1 |
| `serpYourUrlStats` | your URL: $1 clicks, $2 impr., pos. $3 (GSC, 28 d) | ваш URL: клики $1, показы $2, поз. $3 (GSC, 28 дн.) |
| `serpOtherUrlRanks` | For this query you rank with another URL: $1 | По этому запросу у вас ранжируется другой URL: $1 |
| `serpDrUnknown` | Not in the database yet. Get it for free from the header | Нет в базе. Узнать бесплатно — в шапке |
| `serpAgeYears` | $1 y | $1 г. |
| `serpAgeMonths` | $1 mo | $1 мес. |
| `serpMonitorChip` | SERP Monitor: $1 kw, top-10: $2, since $3 | SERP Monitor: $1 запр., топ-10: $2, с $3 |
| `serpTag_new` | new | новый |
| `serpTag_young` | young | молодой |
| `serpTag_rising` | rising | растёт |
| `serpTag_falling` | falling | падает |
| `serpTag_bounced` | bounced | отскок |
| `serpTag_platform` | platform | платформа |
| `serpTag_own` | yours | ваш |
| `serpLinksToYou` | links to you: $1 | ссылается на вас: $1 |
| `serpOutreachStage` | Outreach: $1 | Outreach: $1 |
| `serpDropWatched` | Drop: watched | Дроп: под наблюдением |
| `serpDropStage` | Drop: $1 | Дроп: $1 |
| `serpPbn` | PBN | PBN |
| `serpMenuOutreach` | Add to Outreach | В Outreach |
| `serpMenuWatch` | Watch as a drop | Следить как дроп |
| `serpMenuCloak` | Check for cloaking | Проверить клоакинг |
| `serpMenuOpenDomain` | Open domain in SERP Monitor | Открыть домен в SERP Monitor |
| `serpCloakSame` | Same for Googlebot and browser | Одинаково для Googlebot и браузера |
| `serpCloakDiffers` | Differs between Googlebot and browser | Googlebot и браузер видят разное |
| `serpCloakBlocked` | Bot blocked by the site | Сайт блокирует бота |
| `serpCloakError` | Check failed | Проверка не удалась |
| `serpCloakSnippet` | Snippet found — Googlebot: $1, browser: $2 | Сниппет найден — у Googlebot: $1, у браузера: $2 |
| `serpYes` | yes | да |
| `serpNo` | no | нет |
| `serpWaitMinute` | Too many checks — wait a minute | Слишком много проверок — подождите минуту |
| `serpRegionUnknown` | region not detected | регион не определён |
| `serpYourPositions` | Your positions | Ваши позиции |
| `serpTracked` | Rank Tracker: pos. $1 ($2) | Rank Tracker: поз. $1 ($2) |
| `serpMonitored` | Tracked in SERP Monitor project $1 | Отслеживается в проекте SERP Monitor $1 |
| `serpStorm` | storm on the last run | шторм в последнем прогоне |
| `serpNoStorm` | no storm on the last run | последний прогон без шторма |
| `serpQueryMetrics` | volume $1 · KD $2 · data from $3 | объём $1 · KD $2 · данные от $3 |
| `serpToRank` | Track in Rank Tracker | В Rank Tracker |
| `serpToMonitor` | Add to SERP Monitor | В SERP Monitor |
| `serpCapture` | Save these results | Сохранить выдачу |
| `serpCaptured` | Saved · open | Сохранено · открыть |
| `serpEnrich` | Get age and DR for $1 hosts (free) | Узнать возраст и DR для $1 хостов (бесплатно) |
| `serpPickSite` | Choose a site | Выберите сайт |
| `serpPickProject` | Choose a project | Выберите проект |
| `serpAdded` | Added | Добавлено |
| `serpAlready` | Already there | Уже есть |
| `serpNotConfigured` | OpenGSC: connect the extension in settings | OpenGSC: подключите расширение в настройках |
| `serpCollapse` | Collapse | Свернуть |
| `serpExpand` | OpenGSC | OpenGSC |
| `err_invalid_url` | Invalid URL | Неверный URL |
| `err_too_many_hosts` | Too many hosts | Слишком много хостов |
| `err_private_host` | Private address — not checked | Частный адрес — не проверяется |
| `err_confirm_required` | Needs confirmation | Нужно подтверждение |
| `err_project_not_found` | SERP Monitor project not found | Проект SERP Monitor не найден |
| `err_site_not_found` | Site not found | Сайт не найден |
| `err_rate_limited` | Too many requests — wait a minute | Слишком много запросов — подождите минуту |
| `err_forbidden` | Your role doesn't allow this | Ваша роль этого не позволяет |
| `err_not_migrated` | Run `npx prisma db push` on the server | Выполните на сервере `npx prisma db push` |

(`err_*` используют и E2, E3: E0 кладёт их один раз.)

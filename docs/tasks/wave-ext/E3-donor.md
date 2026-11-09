# E3 — режим донора для чужих страниц

Когда в панели чужая страница, вкладка «Донор» отвечает на вопросы человека, который думает,
покупать ли здесь ссылку или брать сайт в Outreach:

- куда и как эта страница ссылается;
- не восстановленный ли это дроп или PBN, выданный за живой сайт;
- что OpenGSC уже знает об этом хосте (DR, возраст, ссылается ли он на мои сайты, есть ли он в
  Outreach или в drops).

Владеешь: `extension/panel/tab-donor.js`, `extension/lib/donor.js`, `src/lib/ext/donor.test.ts`.
Серверной части у задачи нет: данные о хостах даёт `POST /api/ext/hosts` (E5, контракт §2).

## 1. Сбор — `ExtDonor.collect(document)`

Форма — `CONTRACT.md` §4.5. Исполняется внутри страницы (файл в `PANEL_INJECT`).

- **outbound** — только ссылки на внешние registrable-домены. Используй
  `ExtensionAudit.registrableOf` и `TEXT_BLOCK_MIN` из `lib/audit.js` (E1; `audit.js` грузится
  раньше `donor.js`). Если E1 ещё не приземлился, а функция нужна для отладки — временная копия
  в `donor.js` с комментарием `TODO(R): использовать ExtensionAudit.registrableOf`. Определение
  `area` — то же, что у E1 (контракт §4.3). Не дублируй код: вызови хелпер E1, если он
  экспортирован (`ExtensionAudit.linkArea(el)`); если нет — попроси в отчёте экспортировать.
- **markers** — `ExtDonor.MARKERS` (контракт §4.6). Ищем по атрибутам и классам
  (`document.querySelector('[data-wf-reconstructed]')` и т.п.), по id (`wm-ipp`) и по тексту
  `<script src>`/`<link href>` (`archive.org/static/`, `wombat`). `count` — сколько найдено,
  `sample` — outerHTML первого совпадения, обрезанный до 120 символов.
- **archiveRefs** — сколько атрибутов `src`, `href`, `srcset`, `poster` и `url(…)` в inline
  `style` ссылаются на `web.archive.org`.
- **firstTextBlockIndex** — индекс (в обходе потомков `body` в порядке документа) первого
  элемента, у которого собственный текст (без детей-блоков) ≥ `TEXT_BLOCK_MIN`. Нужен, чтобы
  сказать «внешняя ссылка стоит выше любого текста».

## 2. Сигналы — `ExtDonor.deriveSignals` (чистая)

| id | severity | условие | evidence |
|---|---|---|---|
| `wayforge_marker` | hard | найден хотя бы один маркер WayForge (`data-wf-*`, `wf-footer-partner`) | маркер × count |
| `wayback_toolbar` | hard | `wm-ipp`, `__wm`, `wombat` | маркер |
| `archive_refs` | soft при 1–4, hard при ≥ 5 | `archiveRefs` | число |
| `link_above_content` | soft | есть внешняя ссылка с `area === "top"` | анкор + хост |
| `many_outbound_hosts` | soft | ≥ 25 разных внешних хостов в `content` | число |
| `sitewide_footer_links` | soft | ≥ 3 внешних ссылки в `footer` на разные хосты | хосты |
| `generator_restore_tool` | hard | `generator` содержит название известного инструмента восстановления (список `RESTORE_GENERATORS`: `Archivarix`, `WayForge`, `Wayback Machine Downloader`, `r-tools`, `waybackpack`) | значение |

`verdict`:

- хотя бы один hard → `"restored_drop"`;
- два и больше soft → `"suspicious"`;
- сигналов нет и `outbound` прочитан → `"clean"`;
- скан не удался → `"unknown"`.

Вердикт — подсказка, а не приговор: в UI формулировка «похоже на восстановленный дроп», и под
ней всегда список доказательств. Нет сигналов — значит, мы ничего не нашли. Это не значит, что
сайт чистый: так и пиши («признаков не найдено»), а не «чистый сайт ✓».

## 3. Вкладка — `panel/tab-donor.js`

`Panel.register({ id: "donor", order: 30, applies: ctx => !!ctx.scan && !(ctx.summary && ctx.summary.inPortfolio) })`.
То есть вкладка видна и тогда, когда OpenGSC не настроен: локальная часть работает без сервера.

1. **Хост** — один запрос `ExtApi.hosts({ hosts: [pageHost, ...уникальные хосты outbound (≤ 99)] })`,
   кеш 10 мин по URL. Блок о самом хосте страницы:
   - DR (с источником и датой), возраст, рефдомены — `null` показывать как «—» с подсказкой
     «нет в базе OpenGSC»;
   - **«Ссылается на ваши сайты: site.gr (3 ссылки, 2 живые)»** — из `linksToUs`; это первое,
     что нужно видеть, поэтому сверху и выделено;
   - стадия в Outreach / в drops / купленный дроп / свой PBN.
   - Кнопки: «В Outreach» (существующий `ExtApi.outreach`), «Следить как дроп»
     (`ExtApi.serpAction({ kind: "drops_watch", host })`). Если `missing.age + missing.dr > 0` —
     «Узнать возраст и DR (бесплатно, публичные источники)» → `ExtApi.enrichHosts([pageHost])`
     → перезапрос `hosts`.
2. **Сигналы** — вердикт + список с evidence. Кнопка «Подсветить ссылки над контентом» —
   через `ExtHighlight.apply` (E1) с типом `external`, если E1 экспортирует фильтр по `area`;
   иначе пропусти и опиши в отчёте.
3. **Исходящие ссылки** — таблица: анкор, хост, rel (nofollow/sponsored/ugc как пилюли), область.
   Если хост ссылки — свой сайт из портфеля (`hosts[].own`), строка выделена: «эта страница уже
   ссылается на site.gr». Фильтры: dofollow / в тексте / только мои сайты. Сводка сверху:
   «N внешних ссылок на M хостов, dofollow K».
4. **Экспорт** исходящих в CSV (`lib/csv.js`).

`ExtApi.*` вызываются прямо из панели (это страница расширения, CORS пропускает). Сообщение
`ext:api` нужно только content-скриптам.

## 4. Тесты — `src/lib/ext/donor.test.ts`

- все маркеры из строки `data-wf-reconstructed …` в `src/lib/pbn/clean.ts` есть в
  `ExtDonor.MARKERS` (прочитать `clean.ts` как текст и вытащить массив регуляркой);
- `deriveSignals` и `verdict` на фикстурах: восстановленный WayForge-сайт, Wayback-копия с
  тулбаром, обычная статья с двумя ссылками в тексте, сайт со сквозными ссылками в подвале,
  пустой скан;
- пороги `archive_refs` (4 → soft, 5 → hard).

DOM-половина проверяется руками. В отчёт перечисли страницы: страница с маркерами WayForge
(возьми восстановленный дроп из `/pbn`: запусти превью или открой ZIP-экспорт WayForge, если он
есть у Руслана в `Claude outputs/wayforge-injector-re/`), копия с web.archive.org, обычный
блог, гостевой пост на бирже.

## 5. Ключи (расширение, en · ru)

| ключ | en | ru |
|---|---|---|
| `tabDonor` | Donor | Донор |
| `donorLinksToUs` | Links to your sites | Ссылается на ваши сайты |
| `donorLinksToUsRow` | $1: $2 links, $3 live | $1: ссылок $2, живых $3 |
| `donorNotInDb` | not in OpenGSC yet | пока нет в базе OpenGSC |
| `donorDr` | DR | DR |
| `donorAge` | Age | Возраст |
| `donorAgeValue` | $1 y $2 m | $1 г. $2 мес. |
| `donorRefdomains` | Ref. domains | Рефдомены |
| `donorInOutreach` | In Outreach: $1 | В Outreach: $1 |
| `donorInDrops` | In drops: $1 | В дропах: $1 |
| `donorWatched` | watched | под наблюдением |
| `donorAsset` | Bought drop | Купленный дроп |
| `donorOwnPbn` | Your PBN site | Ваш сайт PBN |
| `donorToOutreach` | Add to Outreach | В Outreach |
| `donorWatchDrop` | Watch as a drop | Следить как дроп |
| `donorEnrich` | Get age and DR (free, public sources) | Узнать возраст и DR (бесплатно, публичные источники) |
| `donorSignals` | Signals | Сигналы |
| `donorVerdictRestored` | Looks like a restored drop | Похоже на восстановленный дроп |
| `donorVerdictSuspicious` | Looks suspicious | Выглядит подозрительно |
| `donorVerdictClean` | No signs found | Признаков не найдено |
| `donorVerdictUnknown` | Couldn't check | Проверить не удалось |
| `donorSig_wayforge_marker` | WayForge markup found | Найдена разметка WayForge |
| `donorSig_wayback_toolbar` | Wayback Machine leftovers | Остатки Wayback Machine |
| `donorSig_archive_refs` | Links to web.archive.org | Ссылки на web.archive.org |
| `donorSig_link_above_content` | External link above all content | Внешняя ссылка выше всего текста |
| `donorSig_many_outbound_hosts` | Many outbound hosts in the text | Много внешних хостов в тексте |
| `donorSig_sitewide_footer_links` | Site-wide footer links | Сквозные ссылки в подвале |
| `donorSig_generator_restore_tool` | Built by a site-restore tool | Сделан инструментом восстановления сайтов |
| `donorOutbound` | Outbound links | Исходящие ссылки |
| `donorOutboundSummary` | $1 links to $2 hosts, $3 dofollow | $1 ссылок на $2 хостов, dofollow $3 |
| `donorAlreadyLinks` | Already links to $1 | Уже ссылается на $1 |
| `donorFilterDofollow` | dofollow | dofollow |
| `donorFilterContent` | in text | в тексте |
| `donorFilterMine` | my sites only | только мои сайты |
| `donorHighlightTop` | Highlight links above content | Подсветить ссылки над контентом |

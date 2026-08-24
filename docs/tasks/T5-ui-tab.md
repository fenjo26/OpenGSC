# T5 — Вкладка «Обратные ссылки»: импорт, пагинация, избранное, фильтры

Ветка: `feat/backlinks-t5-ui`
Код пиши сразу; запустить получится после T0.

## Задача

Вкладка должна стать инструментом, которым ведут ссылочное, а не вспомогательным
списком. Сценарий владельца: купил ссылки, подрядчик прислал список страниц
размещения, залил его сюда — и дальше видишь, отваливаются они или нет.

## Что прочитать

- `docs/tasks/CONTRACT.md`, разделы 0, 1, 2
- `src/app/site/[id]/page.tsx`, блок вкладки backlinks — примерно строки 2010–2350
- `src/app/api/backlinks/route.ts` — текущий GET/POST/DELETE
- `src/lib/seo/metricsCsv.ts` — `parseTable`, `detectReport`, `toNumber`:
  распознавание колонок уже написано, переиспользуй
- `src/app/seo-tools/links/page.tsx` — там избранное лежит в `localStorage.lwFavDomains`.
  **Это антипример, см. ниже**

## Файлы, которыми ты владеешь

- `src/app/site/[id]/page.tsx`
- `src/app/api/backlinks/route.ts`
- `src/components/BacklinkImportDialog.tsx` (создать)

## Задача 1 — серверная пагинация

Сейчас `/api/backlinks` отдаёт **все** строки, а клиент режет их `displayLimit = 50`.
На профиле в 20 тысяч ссылок вкладка ляжет.

Перепиши GET на `?siteDbId=&page=&pageSize=&status=&rel=&source=&domain=&drMin=&drMax=&favorite=&sort=`
и отдавай `BacklinkListResponse` из раздела 2 контракта.

- `pageSize` — 50 по умолчанию, переключатель 50 / 100 / 250 / 500
- `stats` считается **по всей выборке с учётом фильтров**, не по текущей странице:
  «найдено 137 пропавших» должно быть честным числом, а не «сколько видно»
- сортировка: по DR, по дате появления, по дате пропажи, по домену
- читай из `SiteBacklink`, а не из старой `Backlink` (данные перенесла миграция T0)

## Задача 2 — импорт

Компонент `BacklinkImportDialog.tsx`, одно окно, два входа:

1. **вставка списком** — по одному URL в строке, `#` в начале строки = комментарий
2. **CSV / TSV** — загрузка файла или вставка таблицы

**Формат показывай прямо в окне**, а не в документации:

> Обязательно: `url` — страница-донор.
> Необязательно: `anchor`, `target_url`, `rel`, `dr`, `price`, `note`.
>
> `https://donor.ru/blog/statya, купить окна, https://mysite.ru/okna, dofollow`

После вставки — превью до отправки: «распознали 137 строк, колонки: url, anchor;
колонка *price* не распознана и пропущена; 4 строки отброшены как неверные URL».
Механика распознавания колонок есть в `metricsCsv.ts` — не пиши вторую.

Импорт пишет **только** `urlFrom`, `urlFromNorm`, `urlTo`, `note`, `priceNote`,
`source`, `sources` — и никогда не трогает `api*` и `check*` (правило записи,
раздел 1 контракта). Строка, которая уже есть, не создаётся заново: добавляется
`"csv"` или `"manual"` в `sources`, и заполняется `urlTo`, если он был пуст.

Отбрасывай не-http(s) и мусор, показывай сколько отброшено и почему.

## Задача 3 — избранное в БД, а не в браузере

В Link Monitor избранные домены лежат в `localStorage`. Для дорогой ссылки это плохо:
звёздочка исчезнет при смене браузера и её не увидит второй человек в воркспейсе.

Поэтому `favorite` — колонка в `SiteBacklink`. `PATCH /api/backlinks` с
`{ id, favorite }`, фильтр «только избранные», и звёздочка в строке таблицы.
Избранные всегда попадают в дайджест (это уже забота T6, тебе достаточно колонки).

## Задача 4 — колонки и фильтры

Новые колонки в таблице:

| Колонка | Источник |
|---|---|
| ⭐ | `favorite` |
| Донор | `urlFrom`, хост отдельной строкой сверху, как сейчас |
| Наша страница | `urlTo` |
| Размещение | `checkStatus` — ✓ / ✗ / ⚠ / — |
| Анкор | `checkAnchor`, при пустом — `apiAnchor` с пометкой, что это данные Ahrefs |
| rel | `checkRel` + бейджи `nofollow` / `sponsored` / `ugc` |
| DR | `apiDr` |
| Страница | `pageStatus` — наследник старой колонки «жива» |
| Индекс | `xrStatus` |
| Источник | бейджи из `sources` |

Цвета статуса размещения: `found` — зелёный, `missing` — красный, `blocked` — **амбер**,
`unchecked` — серый. Амбер обязателен: `blocked` значит «сайт не пустил нашего бота»,
а не «ссылку сняли, идите ругаться». Так же, как это уже сделано для `aliveStatus`
в текущей таблице — посмотри, как там устроено, и повтори.

Фильтры: статус размещения, `dofollow`/`nofollow`, источник, домен-донор, диапазон DR,
только избранные, только потерянные по данным Ahrefs (`apiLost`).

## Задача 5 — массовые действия по фильтру

Сейчас массовые действия работают по галочкам на видимой странице. «Перепроверить
всё пропавшее» должно означать **всё**, а не первые 50.

Кнопки «Проверить размещение» и «Удалить» шлют либо `ids`, либо `filter` — тот же
объект фильтра, что в GET. Перед деструктивным действием по фильтру покажи, скольких
строк оно коснётся.

Кнопка проверки дёргает `POST /api/backlinks/verify` (делает T4) и показывает прогресс
из `SiteBacklinkSync`. Пока ветка T4 не влита — свёрстай кнопку и состояние прогресса,
запрос оставь за флагом, опиши в отчёте.

## Задача 6 — что остаётся как было

Кнопки «Check 404», «Индексация XR», экспорт CSV **не удаляются**. Экспорт дополни
новыми колонками (анкор, rel, статус размещения, источник, избранное).

Блок `BacklinkProfile` (доменный профиль сверху) не твой — его правит T1. Не трогай.

## Критерии приёмки

- 20 000 строк в таблице не подвешивают вкладку: в DOM никогда не больше `pageSize` строк
- `stats` совпадает с реальным количеством по фильтру (проверь на выборке, где
  отфильтрованных больше, чем на странице)
- импорт списком и импорт CSV дают одинаковый результат на одних и тех же данных
- повторный импорт того же файла не создаёт дублей и не стирает `check*`
- звёздочка переживает перезагрузку страницы и видна из другой сессии
- `blocked` нигде не отрисован красным
- `npm run check` проходит

## Не делай

- не трогай локали (T0), `prisma/**` (T0), `BacklinkProfile.tsx` и `metrics*` (T1),
  `check-alive` / `check-xr` (остаются как есть)
- не добавляй библиотек таблиц и виртуализации: пагинация серверная, этого достаточно
- не используй `localStorage` для данных, которые должны пережить смену браузера
  или быть видны коллеге. Для запомненного размера страницы и выбранного фильтра —
  можно

## i18n-ключи (создаёт T0, ты только используешь)

```
bluiImport            Import links
bluiImportPaste       Paste a list
bluiImportCsv         Upload CSV / TSV
bluiImportFormat      Required: url — the donor page. Optional: anchor, target_url, rel, dr, price, note.
bluiImportExample     Example
bluiImportPreview     Preview
bluiImportRecognized  Recognised {rows} rows · columns: {cols}
bluiImportSkippedCols Ignored columns: {cols}
bluiImportSkippedRows {n} rows skipped as invalid URLs
bluiImportSubmit      Import
bluiImportDone        Imported {added} new, updated {updated}
bluiPerPage           per page
bluiPage              Page
bluiOf                of
bluiFavorite          Favourite
bluiFavoriteOnly      Favourites only
bluiFilterStatus      Placement
bluiFilterRel         Link type
bluiFilterSource      Source
bluiFilterDomain      Donor domain
bluiFilterDr          DR
bluiFilterLost        Lost per Ahrefs
bluiFilterReset       Reset filters
bluiBulkVerify        Check placement
bluiBulkDelete        Delete
bluiBulkFavorite      Add to favourites
bluiBulkScope         This will affect {n} rows matching the current filter.
bluiSourceApi         Ahrefs
bluiSourceCsv         CSV
bluiSourceManual      Manual
bluiColDonor          Donor page
bluiColTarget         Our page
bluiColAnchor         Anchor
bluiColRel            rel
bluiColPlacement      Placement
bluiColDr             DR
bluiColPage           Page
bluiColSource         Source
bluiAnchorFromApi     per Ahrefs
bluiEmpty             No links yet. Import the pages where your links were placed, or run a full export from Ahrefs.
bluiExport            Export CSV
```

## Дополнительные ключи

Появились по ходу работы (в коде уже используются; добавить в 7 локалей и перевести):

```
bluiSortNewest        Newest first
bluiSortFirstSeen     First seen
bluiSortLastSeen      Last seen
```

Используются как подписи опций сортировки в списке (added_desc / first_seen_desc /
last_seen_desc). До добавления в локали полный `tsc` падает ровно на этих трёх ключах —
это единственные ключи T5, которых нет в основном списке.

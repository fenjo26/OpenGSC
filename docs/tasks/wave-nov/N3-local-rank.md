# N3 — Локальные позиции: город и local pack в Rank Tracker

**Ветка:** `feat/wave-nov-n3`. **Владение:** `README.md` §4, строка N3 (`rank.ts`,
`rankScheduler.ts`, `rankFallback.ts`, `seo/serp.ts`, `seo/localPack.ts`, `RankTracker.tsx`,
`/api/rank/**`). Дока — раздел в `docs/LOCAL-SEO.md` пришли текстом в отчёте (файл N4), R вставит.

## Зачем
Трансферы из аэропорта Салоник и массажный салон живут в локальной выдаче. «taxi thessaloniki
airport» из США и из Салоник — разные выдачи, и половина кликов идёт из тройки на карте
(local pack), а не из органики. Сейчас Rank Tracker знает только страну (`gl`).

## Модель данных (схема уже от N0)
- `TrackedKeyword.location` — `""` (страна, как раньше), название города
  («Thessaloniki, Greece») или координаты `"40.5197,22.9709"`. Входит в `@@unique`.
- `RankCheck.localPack` / `localPackTitle` / `hasLocalPack`; `TrackedKeyword.lastLocalPack`.
- `RankCheck.position` остаётся **только органикой**. Никогда не пиши туда место в паке:
  на `position` завязаны графики, `bestPosition` и алерт `rank_drop` (`CONTRACT.md` §0.2).

## 1. Провайдеры — `serp.ts`
`SerpOptions.location` уже есть. `SerpResponse` += `localPack?: { position: number; title: string;
domain: string | null; address: string | null; rating: number | null }[]` (только тройка).
- **Serper:** `location` уже передаётся. Разобрать `places` ответа в `localPack`.
- **DataForSEO:** если `location` — координаты, `location_coordinate: "<lat>,<lng>,14"`, иначе
  `location_name` (формат DataForSEO «Thessaloniki,Central Macedonia,Greece» — если строка
  пользователя не распознана, ответ API скажет об этом; верни понятную ошибку
  `location_unknown`, а не пустую выдачу). Разобрать `items` с `type: "local_pack"`.
- **A-Parser (`SE::Google`):** опция `location` есть в пресете (проверено на живом инстансе в
  истории SERP Monitor). Передавать её; local pack из ответа A-Parser — только если строка ответа
  его содержит (посмотри на фикстуру `src/lib/serpmon/__fixtures__`; если его там нет — `localPack`
  не заполняется, `hasLocalPack = null`).
- **GoAnyAPI и прочие без location:** локальный ключ на таком провайдере → ошибка
  `location_unsupported`. Никакого тихого отката на страну: позиция по стране, записанная как
  «позиция в Салониках», — неправда.
- Изменения в `serp.ts` не должны менять ответ для вызовов без `location` (SERP Monitor и
  SEO Tools тоже вызывают `runSerp`). Прогони тесты `src/lib/serpmon/*.test.ts`.

## 2. Совпадение с «нами» — `src/lib/seo/localPack.ts` (чистая)
`matchLocalPack(pack, us: { host: string; names: string[] })`: сначала по домену сайта
(граница точки, без `www.`), затем по названию (fold, Jaccard слов ≥ 0,6 с любым из `names`).
`names` = `LocalProfile.name` (если N4 создал профиль; читать через Prisma, модель уже в схеме) +
брендовые слова сайта. Возвращает `{ position, title } | null`.

## 3. Проверка и планировщик — `rank.ts`, `rankScheduler.ts`
- `checkTrackedKeyword` передаёт `location` в `runSerp`, пишет `localPack*` в `RankCheck` и
  `lastLocalPack` в ключ.
- Fallback-провайдер (`rankFallback.ts`) выбирается только среди тех, кто поддерживает
  `location`, если он задан.
- Уведомление об изменениях в паке (выпал из тройки / вошёл / сменилось место): раз в сутки на
  сайт, `localPackTitle/Msg`, событие `local`, дедуп `AlertEvent` (`type: "local_pack"`,
  `dedupeKey: lp:<siteId>:<utcDay>`). Только для ключей с `location`.

## 4. UI — `RankTracker.tsx`
- При добавлении ключа — поле «Город или координаты» с подсказкой; массовое добавление через
  CSV принимает колонку `location`.
- В таблице: колонка «Local pack» (`1–3` / «нет в паке» / «пака нет» / «—» если провайдер не
  сообщает); бейдж города у ключа; фильтр «только локальные».
- В истории ключа: второй ряд на графике — место в паке (ступенчатая линия 1…3 и «вне»).
- Строка цены до запуска — как у остальных проверок.

## 5. API — `/api/rank/**`
Поле `location` в создании/импорте ключей; валидация: ≤ 120 символов, координаты — два числа в
диапазоне. Уникальность — с `location`.

## Тесты — `src/lib/seo/localPack.test.ts`
- `matchLocalPack`: по домену; по названию с диакритикой; чужое похожее название ниже порога.
- Разбор `places` Serper и `local_pack` DataForSEO из фикстур (сохрани реальные ответы без ключей).
- `location_unsupported` для провайдера без location.
- Вызов без `location` возвращает то же, что до изменений (снапшот ответа).

## i18n (N0 создаёт)
| ключ | en | ru |
|---|---|---|
| `lrLocation` | City or coordinates | Город или координаты |
| `lrLocationHint` | e.g. "Thessaloniki, Greece" or "40.5197,22.9709". Empty = whole country. | Например «Thessaloniki, Greece» или «40.5197,22.9709». Пусто — вся страна. |
| `lrLocalPack` | Map pack | Local pack |
| `lrPackNotIn` | Not in pack | Нет в паке |
| `lrPackNone` | No map pack | Пака нет |
| `lrPackUnknown` | Provider does not report | Провайдер не сообщает |
| `lrOnlyLocal` | Local keywords only | Только локальные |
| `lrErr_location_unsupported` | This provider cannot check a city — choose Serper, DataForSEO or A-Parser | Этот провайдер не умеет проверять по городу — выберите Serper, DataForSEO или A-Parser |
| `lrErr_location_unknown` | The provider did not recognise this location | Провайдер не распознал это место |
| `lrPackHistory` | Map pack place | Место в local pack |

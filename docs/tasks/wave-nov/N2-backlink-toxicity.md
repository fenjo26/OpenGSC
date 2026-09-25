# N2 — Бэклинки: токсичность своего профиля, disavow, приоритет восстановления

**Ветка:** `feat/wave-nov-n2`. **Владение:** `README.md` §4, строка N2. Дока — `docs/BACKLINK-TOXICITY.md`.

## Что уже есть и чего нет
Есть Backlinks v2 (`SiteBacklink`: данные Ahrefs + наша проверка страницы донора), алерты
потерь (`lost_link`, `backlink_loss`, `favorite_link`), классификатор токсичности **для дропов**
(`src/lib/drops/toxicity/*`: маркеры казино/фармы/адалта/взлома, анкоры, чужая письменность,
парковки). Нет: токсичности **своего** профиля, disavow-файла и сортировки потерь по ценности.

## Главная ловушка — своя ниша
Классификатор дропов считает гемблинг токсичным. У Руслана гемблинг-сайты, и казино-анкор с
казино-донора для них — **нормальная тематическая ссылка**. Поэтому у сайта есть
`Site.backlinkNiche = { ownNiche: ["gambling", …] }` — коды групп из `MARKERS`
(`src/lib/drops/toxicity/markers.ts`: `gambling_zh`, `gambling_id`, `gambling_generic`, `adult`,
`pharma`, `replica`, `essay_mill`). Элемент ниши совпадает с кодом целиком **или как префикс до
`_`**: `"gambling"` покрывает все три гемблинг-группы. Сигналы этих групп для сайта **не** токсичны, а их
`anchor_`-двойники тоже. Всё остальное (фарма, адалт, взлом, чужая письменность) — токсично
как обычно. Если ниша не задана, UI предлагает её по самому сайту: группы маркеров, которые
встречаются в title и description его главной страницы из последнего аудита. Предложение,
а не автоприменение.

## 1. Классификация донора — `src/lib/backlinks/toxicity.ts` (чистая)
Вход — строки `SiteBacklink` одного `domainFrom` + ниша сайта + язык сайта. Сигналы:
- **маркеры** (`matchMarkers` из drops, импорт) по `apiAnchor`, `checkAnchor`, `pageTitle`,
  `apiSnippet` — минус группы `ownNiche`;
- **анкоры** (`classifyAnchors`) — так же;
- **чужая письменность** анкора или title относительно языка сайта (`scriptsOf`,
  `isNativeScriptForZone`), кроме латиницы на латинском сайте;
- **структура:** `apiDr < 5` вместе с ≥ 20 ссылками с домена (sitewide-помойка); все ссылки
  вне контента (`apiContent = false`) и их ≥ 10; домен-донор — известная парковка
  (`isParked` по title);
- **переоптимизация** (сигнал профиля, не донора): доля точных коммерческих анкоров по
  профилю выше 30 % — выводится баннером, на уровень донора не влияет.

Оценка 0…100 — взвешенная сумма (веса в константах, как `DEFAULT_TOXIC_AT` у дропов):
≥ 60 → `toxic`, ≥ 25 → `suspicious`, иначе `clean`. Нет данных (ни анкора, ни title) →
`unknown`. Результат пишется в `toxLevel`, `toxScore`, `toxSignals`, `toxCheckedAt` **всех**
строк этого донора.

**Глубокая проверка** (по кнопке и только для `suspicious`): `safeFetch` главной страницы
донора → title и фрагмент текста → те же маркеры. Это сеть, подпись «net», до 50 доменов за раз.

## 2. Прогон и алерт — `src/lib/backlinks/store.ts`, `scheduler.ts`
- `POST /api/backlinks/toxicity/run` — пересчитать сайт (локально, без сети; `limit` для
  глубокой проверки).
- Планировщик: тик раз в час. Сайт пересчитывается, если есть строки с `toxCheckedAt` старше
  `SiteBacklinkSync` последней синхронизации (появились новые доноры). После пересчёта —
  если появились **новые** `toxic`-доноры (не было в прошлом прогоне), одно уведомление
  `toxicNewTitle/Msg` (≤ 10 доменов), событие `alert`, дедуп через `AlertEvent`
  (`type: "toxic_new"`, `dedupeKey: toxic:<siteId>:<utcDay>`). Первый прогон по сайту не шлёт
  ничего (иначе весь исторический профиль придёт одним сообщением).

## 3. Disavow
- Решение за оператором: `disavow` никогда не ставится автоматически. UI — массовое
  «Отметить для disavow» на выбранных строках и кнопка «Отметить все toxic».
- `GET /api/backlinks/disavow?siteId=` → `text/plain; charset=utf-8`,
  `Content-Disposition: attachment; filename="disavow-<host>-<date>.txt"`:
  ```
  # OpenGSC disavow file for example.com — generated 2026-11-02
  # Upload: https://search.google.com/search-console/disavow-links
  # toxic · pharma, anchor_adult · 14 links
  domain:spam-donor.xyz
  ```
  Уровень домена по умолчанию; переключатель «отдельные URL» для доноров, где отмечены не
  все ссылки. Комментарий-причина — из `disavowNote` или из сигналов.
- **Предупреждение в UI** (обязательно): Google рекомендует disavow, только если есть ручные
  санкции или много явно купленных/спамных ссылок; ошибочный disavow срезает хорошие ссылки.

## 4. Приоритет восстановления — `src/lib/backlinks/recovery.ts` (чистая)
Потерянные — `apiLost = true`, или `checkStatus = "missing"`, или стал nofollow/sponsored,
или `checkTargetOk = false`. Оценка:
`DR-вес (apiDr/100, минимум 0,05) × (dofollow ? 1 : 0,3) × (apiContent ? 1 : 0,5)
× ценность целевой страницы (1 + log10(1 + клики urlTo за 28 дней из DailyMetric))
× свежесть потери (≤ 30 дней — 1, ≤ 90 — 0,6, дальше 0,3) × (favorite ? 1,5 : 1)`.
Для каждой строки — **тип действия**:
- `page_alive_link_removed` — страница жива, ссылки нет → написать вебмастеру;
- `page_dead` — донор 404/мёртв → попросить восстановить или поставить редирект;
- `nofollowed` — ссылка стала nofollow/sponsored;
- `retargeted` — ведёт не на ту страницу;
- `unknown` — Ahrefs говорит «потеряна», наша проверка не проводилась → «проверить».
Кнопка «В Outreach» — через тот же серверный сервис, что MCP `save_outreach_prospect`.

## 5. UI — `BacklinkProfile.tsx` (+ компоненты в `src/components/backlinks/`)
Новые вкладки внутри профиля: «Токсичность» (ниша сайта с чипами групп и кнопкой «предложить
по сайту»; распределение clean / suspicious / toxic / unknown; таблица доноров с сигналами,
отметкой disavow, глубокой проверкой; баннер переоптимизации) · «Disavow» (предпросмотр файла,
скачивание, предупреждение) · «Восстановление» (таблица потерь по оценке, тип действия,
«В Outreach»). Share view — только чтение, без disavow.

## 6. MCP — `get_backlink_toxicity` (local), `get_disavow_file` (local, возвращает текст файла).

## Тесты — `src/lib/backlinks/*.test.ts`
- Казино-анкор на сайте с `ownNiche: ["gambling"]` → `clean`; тот же анкор без ниши → `toxic`.
- Фарма-анкор на гемблинг-сайте → `toxic`.
- Sitewide DR 2 × 40 ссылок → `suspicious` минимум.
- Нет анкора и title → `unknown`, а не `clean`.
- Формат disavow: заголовок, комментарии, `domain:`, URL-режим, пустой список → только
  заголовок.
- Recovery: порядок по оценке, каждый тип действия.

## i18n (N0 создаёт)
| ключ | en | ru |
|---|---|---|
| `blTabToxicity` | Toxicity | Токсичность |
| `blTabDisavow` | Disavow | Disavow |
| `blTabRecovery` | Recovery | Восстановление |
| `blNiche` | Your niche (not toxic for this site) | Ваша ниша (для этого сайта не токсично) |
| `blNicheSuggest` | Suggest from the site | Предложить по сайту |
| `blTox_clean` | Clean | Чистый |
| `blTox_suspicious` | Suspicious | Подозрительный |
| `blTox_toxic` | Toxic | Токсичный |
| `blTox_unknown` | Not enough data | Мало данных |
| `blToxRun` | Recalculate | Пересчитать |
| `blToxDeep` | Deep check (fetch donor) | Глубокая проверка (загрузить донора) |
| `blToxSignals` | Signals | Сигналы |
| `blOverOptimized` | {pct}% of anchors are exact commercial phrases — over-optimisation risk | {pct}% анкоров — точные коммерческие фразы: риск переоптимизации |
| `blDisavowMark` | Mark for disavow | Отметить для disavow |
| `blDisavowMarkToxic` | Mark all toxic | Отметить все токсичные |
| `blDisavowUnmark` | Unmark | Снять отметку |
| `blDisavowDownload` | Download disavow file | Скачать disavow-файл |
| `blDisavowUrls` | Individual URLs | Отдельные URL |
| `blDisavowWarning` | Google recommends disavow only for manual actions or clearly paid/spam links. A wrong disavow removes good links. | Google рекомендует disavow только при ручных санкциях или явно купленных/спамных ссылках. Ошибочный disavow отключает хорошие ссылки. |
| `blRecScore` | Value | Ценность |
| `blRecAction_page_alive_link_removed` | Page is up, link removed — contact the webmaster | Страница жива, ссылку убрали — написать вебмастеру |
| `blRecAction_page_dead` | Donor page is gone — ask to restore or redirect | Страницы донора нет — попросить восстановить или редирект |
| `blRecAction_nofollowed` | Link became nofollow/sponsored | Ссылка стала nofollow/sponsored |
| `blRecAction_retargeted` | Link points to another page | Ссылка ведёт на другую страницу |
| `blRecAction_unknown` | Lost per Ahrefs — verify | Потеряна по Ahrefs — проверить |
| `blToOutreach` | Add to Outreach | В Outreach |

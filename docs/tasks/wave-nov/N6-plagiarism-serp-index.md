# N6 — Плагиат по вебу + проверка индексации через `site:`

**Ветка:** `feat/wave-nov-n6`. **Владение:** `README.md` §4, строка N6 (в т. ч.
`src/lib/seo/toolsNav.ts` — ты добавляешь в SEO Tools **и** `plagiarism`, **и** `hreflang` для N1,
и `src/components/IndexAutoPanel.tsx`). Дока — `docs/PLAGIARISM.md`.

Обе функции — это точные запросы к поисковику через **любой настроенный SERP-провайдер**
(`getUserSerpCreds` + `runSerp` из `rank.ts` / `serp.ts`, только импорт). A-Parser — один из
вариантов, а не обязательный: его Google-прокси сейчас ловят капчу.

## Часть A. Плагиат — `/seo-tools/plagiarism`
Уже есть `analyze_text`: уникальность против выдачи по ключу. Нет: «откуда списано», то есть
поиска **по всему вебу** по фрагментам текста.

### Алгоритм — `src/lib/plagiarism/*.ts`
1. Нормализация: снять markdown, блок меты, заголовки, списки ссылок.
2. Выборка ≤ **10** «редких» предложений: длина 8–25 слов, без чисел-дат-цен-брендов из
   ключа, максимум специфичных слов (частотный словарь — топ-2000 слов языка текста не
   нужен: хватит «длина слов + доля стоп-слов», стоп-слова возьми из `metaFit.ts`, если они
   экспортированы, иначе свой список). Равномерно по тексту.
3. Каждое → запрос `"<предложение>"` (в кавычках), `num: 10`.
4. Совпадение = результат, чей сниппет содержит ≥ 70 % слов фрагмента подряд (shingle по 4 словам)
   или URL повторяется по ≥ 2 фрагментам. Свой домен (из `Site`, если текст привязан к сайту) —
   не плагиат, помечается «ваш сайт».
5. Отчёт: доля фрагментов с совпадениями, список источников (URL, сколько фрагментов, какие),
   подсветка фрагментов в тексте. Это **оценка**, а не приговор: подпись в UI.

### Цена и подтверждение
`POST /api/seo/plagiarism/estimate` → `{ provider, queries, costUsd | null, free: boolean }`
(цены провайдеров — там же, где их берёт Rank Tracker для оценки; A-Parser — «self-hosted · no
per-request cost»). `POST /api/seo/plagiarism` требует `spend` и `confirm: true`. Кэш по
`textHash` на 7 дней: повторная проверка того же текста бесплатна и мгновенна.

### Где вызывается
Страница `/seo-tools/plagiarism`: вставить текст или выбрать запись истории. Страница
принимает `?history=<id>`. Кнопку «Проверить на плагиат» в `SeoTextDetail.tsx` не добавляешь —
файл не твой. Опиши в отчёте, куда R добавит ссылку на `/seo-tools/plagiarism?history=<id>`.

## Часть B. Индексация через `site:` — для сайтов вне GSC
URL Inspection (октябрь, T4) работает только для своих подтверждённых ресурсов. Для дропов,
чужих сайтов, PBN без GSC нужен `site:`.
- `src/lib/indexing/serpIndex.ts`: запрос `site:<url без схемы>` (для главной — `site:<host>`),
  `num: 10`. `indexed`, если в выдаче есть результат с тем же нормализованным URL (без
  `www.`, слеша, utm); `not_indexed`, если выдача пуста **и** провайдер вернул успех; ошибка
  провайдера — `error` (капча не равна «не в индексе» — то же правило, что в SERP Monitor).
- `POST /api/indexing/serp-check` `{ urls[] ≤ 200, confirm }` — оценка цены без `confirm`,
  проверка с `confirm` (`spend`). Результат пишется в `SitemapUrl.serpIndex*`, если URL
  принадлежит сайту; иначе только возвращается.
- `IndexAutoPanel.tsx`: для URL, где Google-квота исчерпана или ресурса нет в GSC, кнопка
  «Проверить через site:» с ценой; в таблице — отдельная колонка «site:», подписанная как
  **оценка по выдаче**, а не вердикт Google.

## MCP — `toolsPlagiarism.ts`
`check_plagiarism` (paid, `confirm`), `serp_index_check` (paid, `confirm`).

## Тесты — `src/lib/plagiarism/*.test.ts`, `src/lib/indexing/serpIndex.test.ts`
Выборка фрагментов (длина, числа, равномерность); shingle-совпадение; свой домен не плагиат;
разбор выдачи `site:` (нашёлся, не нашёлся, ошибка ≠ not_indexed); нормализация URL; кэш по хешу.

## i18n (N0 создаёт)
| ключ | en | ru |
|---|---|---|
| `plgTitle` | Plagiarism check | Проверка на плагиат |
| `plgHint` | Searches the web for exact fragments of your text. An estimate, not a verdict. | Ищет в вебе точные фрагменты вашего текста. Это оценка, а не приговор. |
| `plgPaste` | Paste text or pick from history | Вставьте текст или выберите из истории |
| `plgEstimate` | {n} searches via {provider} · {cost} | {n} запросов через {provider} · {cost} |
| `plgRun` | Check | Проверить |
| `plgScore` | {pct}% of sampled fragments found elsewhere | {pct}% проверенных фрагментов найдено в других местах |
| `plgSources` | Sources | Источники |
| `plgOwnSite` | Your site | Ваш сайт |
| `plgFragments` | Fragments | Фрагменты |
| `plgCached` | From cache (checked {time}) | Из кэша (проверено {time}) |
| `plgClean` | No matches in sampled fragments | В проверенных фрагментах совпадений нет |
| `idxSerpCheck` | Check via site: | Проверить через site: |
| `idxSerpColumn` | site: | site: |
| `idxSerpHint` | Estimate from search results, not Google's own verdict | Оценка по выдаче, а не вердикт Google |
| `idxSerp_indexed` | Found | Найден |
| `idxSerp_not_indexed` | Not found | Не найден |
| `idxSerp_error` | Check failed | Не удалось проверить |

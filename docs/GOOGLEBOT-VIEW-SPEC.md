# Googlebot View — техническая спецификация

Инструмент для раздела **SEO Tools**: «увидеть» любую страницу так, как её видит краулер Google, и выявить расхождения между тем, что отдаётся боту и живому пользователю — то есть **клоакинг, скрытые редиректы, PBN-схемы** и прочие приёмы конкурентов.

Аналог: `affiliate.fm/tools/googlebot-view`. Отличие нашей версии — честная техническая модель плюс интеграция с уже подключённым в проекте **GSC URL Inspection API** для собственных верифицированных сайтов.

---

## 1. Что это делает (с точки зрения пользователя)

Пользователь вставляет URL → нажимает «Смотреть как Googlebot» → получает:

1. **Вердикт по клоакингу** — крупный баннер: «расхождений нет» / «обнаружено расхождение между видом для Googlebot и для браузера».
2. **Цепочку редиректов** для каждого «взгляда» (Googlebot mobile, Googlebot desktop, обычный браузер) — каждый хоп: код ответа → Location.
3. **Сравнительную таблицу** Googlebot vs Браузер: финальный статус, финальный URL, canonical, meta robots, `X-Robots-Tag`, title, объём контента, индексируемость.
4. **SEO-сигналы**: canonical из HTML vs из HTTP-заголовка, hreflang, meta robots, JS-редиректы (`meta refresh`, `window.location`).
5. **True Google View** (только для своих сайтов, верифицированных в GSC) — реальный вердикт Google: статус индексации, `googleCanonical` vs `userCanonical`, robots.txt state, последний обход.
6. **Wayback-снапшот** (опц.) — последний слепок страницы из archive.org для сравнения.

---

## 2. Честная техническая модель (важно — читать до реализации)

Прошлые разборы содержат распространённое заблуждение, которое нужно зафиксировать, чтобы не строить архитектуру на неверной предпосылке.

**Нельзя отправлять HTTP-запросы «с IP-адресов Google».** Диапазоны из `google.com/…/ipranges` принадлежат Google; исходить из них с нашего сервера физически невозможно. Эти списки нужны для **обратной** задачи — проверить reverse-DNS входящего к тебе запроса, действительно ли он от Googlebot. Ни affiliate.fm, ни любой другой внешний инструмент не фетчит «с гугл-IP».

**Что реально делает такой инструмент — подставляет User-Agent Googlebot** и сравнивает ответы. Наш механизм: тянем один и тот же URL несколькими способами и сопоставляем результаты.

Используемые «взгляды» (User-Agent):

| Взгляд | User-Agent |
|---|---|
| Googlebot Smartphone (основной краулер) | `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)` |
| Googlebot Desktop | `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Googlebot/2.1; +http://www.google.com/bot.html` |
| Обычный браузер (базовый «человеческий» вид) | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36` |
| Googlebot + Referer из выдачи (опц.) | Googlebot-UA + заголовок `Referer: https://www.google.com/` — ловит клоаку, срабатывающую только на переходах из SERP |

Для каждого взгляда **вручную идём по цепочке редиректов** (не полагаемся на авто-follow), максимум 20 хопов, тайм-аут 15 с, фиксируем на каждом шаге: статус, `Location`, `Set-Cookie`, а также клиентские редиректы (`<meta http-equiv=refresh>`, `window.location`, `location.href`).

Финальные ответы **диффаем**: статус, финальный URL, canonical, meta robots, `X-Robots-Tag`, title, хэш/длина контента, наличие JS-редиректов. Любое существенное расхождение между видом для Googlebot и для браузера → сигнал клоакинга.

### 2.1 Матрица выборок — почему одной пары фетчей недостаточно

*(добавлено 2026-08-19; реализовано в `analyzeUrl` / `buildMatrix` / `diffViews`)*

Одно сравнение «бот vs браузер» отвечает не на тот вопрос. Реальная страница отличается между **любыми** двумя запросами: ротация баннеров, счётчики, CSRF-токены, таймстемпы, обфускация email от Cloudflare. Бинарный хэш называет всё это «различием» и не даёт отличить сдвиг в одно слово от подменённого дорвея — именно так инструмент начинает кричать «клоака» на чистых сайтах.

Поэтому каждая сторона запрашивается **дважды**, и запросы внутри раунда уходят параллельно:

| Пара | Что измеряет |
|---|---|
| Googlebot #1 ↔ Googlebot #2 | собственная изменчивость страницы во времени |
| Браузер #1 ↔ Браузер #2 | то же самое с другой стороны |
| Googlebot #n ↔ Браузер #m (4 пары) | изменчивость **по аудитории** — собственно вопрос |
| Googlebot #1 ↔ Браузер (mobile) | контроль устройства |

`noiseFloor = 1 − min(схожесть базовых пар)`. Клоакой считается только та часть кросс-дельты, которая **превышает** noiseFloor. Пример из практики (retailrevolt.ca): внутри раунда бот и юзер совпадают побайтово, между раундами схожесть 0.98 — то есть страница меняется во времени, а не по аудитории, и вердикт обязан быть «чисто».

**Контроль устройства.** Основной краулер Google — смартфон, а дефолтный «человеческий» взгляд — десктоп. Сайт с серверным device detection отдаёт им честно разные шаблоны. Поэтому мы дополнительно тянем страницу мобильным браузерным UA (`chromeMobile`) и берём **лучшее** совпадение из двух: если страница сходится с мобильным браузером, различие объясняется устройством, а не аудиторией. Эта поправка может только снизить балл — она убирает известную безобидную причину, а не оправдывает настоящую.

**Метрика.** Не хэш, а нормализованная схожесть 0..1 (`src/lib/seo/textSimilarity.ts`): Jaccard по 3-словным шинглам поверх текста, из которого вычищены известные пер-запросные артефакты — `__cf_email__` / `[email protected]`, `/cdn-cgi/*`, nonce/CSRF/session, UUID и длинные hex-блобы, cache-busting `?v=`, таймстемпы. Словесные шингли (а не символьные окна) означают, что одна вставка сдвигает k шинглов, а не разъезжает весь документ — тот самый сбой, из-за которого наивные чанковые диффы объявляют изменённой всю страницу после одного добавленного `<span>`.

Короткие тексты по этой метрике чувствительнее длинных (одно слово — большая доля). Это не сглаживается специально: noiseFloor измеряется **той же метрикой на той же странице**, поэтому чувствительность сокращается.

**`confidence`**: `high` — обе базовые пары получены и noiseFloor ≤ 2%; `medium` — калибровки нет либо страница шумная; `low` — какой-то из фетчей упёрся в антибот-стену. Показывается всегда, рядом с баллом.

### 2.2 Что не является клоакой, но должно быть видно

Вердикт отвечает ровно на один вопрос — «отдают ли разное разным». Находки, которые под него не подпадают, идут в отдельное поле `notes` и никогда не влияют на балл. Первая из них: **клиентский редирект, одинаковый для бота и для браузера**. Клоаки нет, но в индекс попадает один адрес, а посетитель оказывается на другом — типовая схема дорвея, и молча терять её нельзя.

### 2.3 Исправленные дефекты реализации (2026-08-19)

- `renderWithFirecrawl` анализировал `rawHtml`, а не отрендеренный DOM (`rawHtml || renderedHtml`), из-за чего заявленный в шапке функции детект **JS-клоаки был выключен**: сырой HTML в этом классе одинаков для всех по определению. Добавлен явный параметр `prefer`, по умолчанию `"rendered"`.
- Тот же метод возвращал `finalUrl: url` (вход), игнорируя `metadata.url`. Из-за этого самая весомая проверка (`разные финальные хосты`, +50) **не могла сработать на рендер-пути в принципе**. Теперь финальный URL и статус читаются из ответа, а выполненный редирект попадает в цепочку хопов.
- Взгляд «Googlebot + Referer из выдачи» фетчился и **никогда ни с чем не сравнивался**. Теперь диффается против браузера, результат в `refererDiff` и сворачивается в общий вердикт с пометкой источника.
- `parseSeoSignals` возвращал один и тот же JS-редирект столько раз, сколько ветвей скрипта его содержат (в UI это выглядело как пять разных находок). Добавлен дедуп.

### Почему это вскрывает клоаку и PBN
- **Клоакинг money-page:** боту отдают «белый» контент, браузеру — редирект на офер (или наоборот). Мы показываем оба вида и подсвечиваем несоответствие.
- **Скрытый PBN-редирект:** 301/JS-редирект срабатывает только для определённого UA/referrer. Цепочка хопов делает его видимым.

### Ограничения (обязательно показать в UI как дисклеймер)
- **Только UA-based детект.** IP-based клоакинг (разный контент только для реальных IP Google) невидим для *любого* внешнего инструмента, включая affiliate.fm. Не обещаем того, чего не можем.
- **Reverse-DNS проверка.** Сайты, которые валидируют Googlebot по обратному DNS, отдадут нам «человеческую» версию или `403` (наш IP не принадлежит Google). Это само по себе сигнал — фиксируем и показываем как «сайт различает настоящего/поддельного бота».
- **JS-клоакинг.** Простой `fetch` не исполняет JS. Статически ловим паттерны JS-редиректа; полноценный рендеринг — опция Фазы 2 через Firecrawl (уже в проекте) с Googlebot-UA.

---

## 3. Роль GSC (ground truth — только для своих сайтов)

**URL Inspection API в проекте уже подключён и рабочий** — используется на странице сайта (`src/app/site/[id]/page.tsx`) во вкладках **Health** и **Optimize**, а также при проверке индексации. Авторизация — Google **OAuth** аккаунта пользователя (`GOOGLE_CLIENT_ID/SECRET` + токены `Account`), подключается в `/settings`. Два готовых эндпоинта:
- `POST /api/gsc/inspect` (`src/app/api/gsc/inspect/route.ts`) — через `googleapis`, с кэшем в `PageInspection`.
- `POST /api/indexing/sitemap/check-google` — прямой fetch к `searchconsole.googleapis.com/v1/urlInspection/index:inspect`, с авто-рефрешем токена.

**Но именно поэтому GSC нельзя навести на конкурента.** `urlInspection.index.inspect` работает **исключительно для property, верифицированных под аккаунтом пользователя**. На чужой домен Google отвечает `403 "You do not own this property"` — это подтверждается прямо в текущем коде проекта (`check-google/route.ts` уже ловит эту ошибку):

```
isOwnershipError = status===403 && (msg.includes('do not own') || msg.includes('not part of this property'))
→ hint: 'property_not_verified'
```

Это ограничение самого Google API, а не проекта; обойти его невозможно. Поэтому для **конкурентской разведки GSC не участвует вообще** — работает только Раздел 2 (UA-диф + цепочка редиректов), которому не нужны ни API, ни владение сайтом.

Логика панели: если хост инспектируемого URL совпадает с одним из `Site` пользователя → показываем панель **True Google View**, переиспользуя готовый `POST /api/gsc/inspect` (новый OAuth-код не пишем). Для чужих URL панель просто скрыта.

> **Нюанс реализации.** Сам вызов `sc.urlInspection.index.inspect` возвращает от Google полный `indexStatusResult` с полями `googleCanonical`, `userCanonical`, `indexingState`, `robotsTxtState`, `pageFetchState`, `crawledAs`, `coverageState`, `lastCrawlTime`. Но текущий роут сохраняет/отдаёт клиенту лишь подмножество — `coverageState` (как `status`), `lastCrawlTime` и `richResults` (см. строку ~176). Чтобы показать ключевое для нас `googleCanonical` vs `userCanonical`, роут нужно **расширить**: пробросить эти поля в ответ (и, при желании, в модель `PageInspection`). Это небольшая правка существующего файла, а не новый OAuth-код.

Таким образом инструмент честно разделён: **конкуренты → UA-диф + цепочка редиректов**; **свои сайты → плюс реальный вердикт Google**.

---

## 4. Архитектура и файлы (по существующему паттерну проекта)

Три новых файла + правки в трёх местах регистрации + ключи локалей.

### 4.1 `src/lib/seo/googlebot.ts` — ядро логики
Изолированная логика без UI, по образцу `src/lib/seo/scrape.ts` (переиспользуем хелперы `decodeEntities`/`stripTags` — вынести в общий модуль или скопировать).

```ts
export const UA = {
  gbMobile:  "…Googlebot/2.1; +http://www.google.com/bot.html) …Mobile…",
  gbDesktop: "…compatible; Googlebot/2.1; +http://www.google.com/bot.html",
  chrome:    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) …Chrome/120.0 Safari/537.36",
} as const;

export interface Hop {
  url: string;
  status: number;
  location?: string;         // из заголовка Location (для 3xx)
  redirectType?: "http" | "meta-refresh" | "js";
  setCookie?: boolean;
}

export interface ViewResult {
  ua: keyof typeof UA;
  ok: boolean;
  blocked?: boolean;         // 403/429 — сайт режет поддельного бота
  hops: Hop[];               // цепочка редиректов (до 20)
  finalUrl: string;
  finalStatus: number;
  headers: {                 // отобранные заголовки финального ответа
    xRobotsTag?: string;
    canonicalHeader?: string;  // rel=canonical из Link-хедера
    contentType?: string;
    vary?: string;
    cacheControl?: string;
  };
  signals: SeoSignals;
  bodyHash: string;          // sha1 нормализованного текста — для диффа
  wordCount: number;
  error?: string;
}

export interface SeoSignals {
  canonicalHtml?: string;    // <link rel="canonical">
  metaRobots?: string;       // <meta name="robots">
  hreflang: { lang: string; href: string }[];
  title: string;
  metaDescription?: string;
  h1?: string;
  jsRedirects: string[];     // найденные meta-refresh / location.* цели
  indexable: boolean;
  indexableReasons: string[];// напр. ["meta robots: noindex", "X-Robots-Tag: none"]
}

export interface CloakingDiff {
  verdict: "clean" | "suspicious" | "cloaking";
  score: number;             // 0–100
  flags: string[];           // человекочитаемые причины
}

export interface AnalyzeResult {
  url: string;
  views: ViewResult[];       // gbMobile, gbDesktop, chrome (+ gb+referer опц.)
  diff: CloakingDiff;
  wayback?: { url: string; timestamp: string } | null;
  ownSite?: { siteId: string } | null;  // если URL — верифицированный сайт
}

// Основные функции:
export async function followChain(url: string, ua: string, opts?: {...}): Promise<ViewResult>;
export function parseSeoSignals(url: string, html: string, headers: Headers): SeoSignals;
export function diffViews(views: ViewResult[]): CloakingDiff;
export async function analyzeUrl(url: string, opts?: {...}): Promise<AnalyzeResult>;
```

### 4.2 `src/app/api/seo/googlebot/route.ts` — API-роут
По образцу `src/app/api/seo/scrape/route.ts`: auth через `getServerSession(authOptions)`, валидация тела.

```
POST /api/seo/googlebot
body: {
  url: string;
  referer?: boolean;         // добавить взгляд Googlebot+referer
  includeWayback?: boolean;
  firecrawlKey?: string;     // для JS-рендера (Фаза 2)
}
→ 200: AnalyzeResult
→ 400: { error: "bad_url" | "private_host" }
→ 401: { error: "Unauthorized" }
```

Роут сам не дёргает GSC — он лишь возвращает `ownSite.siteId`, если хост совпал с сайтом пользователя; далее **клиент** вызывает существующий `POST /api/gsc/inspect` (не дублируем OAuth-логику).

### 4.3 `src/app/seo-tools/googlebot/page.tsx` — UI
`"use client"`, `useLanguage()`, стилистика как в `src/app/seo-tools/links/page.tsx` (классы `panel`, `tool-input`, кнопки `btnPurple`/`btnGhost`). Блоки:
- Поле URL + кнопка запуска; тумблеры «Mobile/Desktop», «как из Google (referer)», «Wayback».
- Баннер-вердикт (зелёный/жёлтый/красный по `diff.verdict`).
- Цепочка редиректов по каждому взгляду.
- Сравнительная таблица Googlebot vs Браузер.
- Блок SEO-сигналов (canonical HTML vs header, hreflang, meta robots, JS-редиректы).
- Панель **True Google View** — рендерится только если `ownSite`, данные из `/api/gsc/inspect`.
- Ссылка на Wayback-снапшот.
- (Опц.) Сохранение в историю — переиспользуем `src/lib/seo/history.ts`, добавив тип `"googlebot"`.

### 4.4 Регистрация в навигации (2 места)
- `src/app/seo-tools/layout.tsx` → массив `TABS`: `{ href: "/seo-tools/googlebot", key: "seoTabGooglebot", icon: Bot }` (иконка `Bot` из `lucide-react` — проверено, существует).
- `src/app/seo-tools/page.tsx` → массив `TILES`: `{ href: "/seo-tools/googlebot", key: "seoTabGooglebot", desc: "seoTileGooglebot", icon: Bot, color: "#4285F4" }` (гугловский синий).

### 4.5 Локали (3 файла, ключи должны совпадать во всех)
В `src/locales/ru.json`, `uk.json`, `en.json` добавить одинаковый набор ключей:
`seoTabGooglebot`, `seoTileGooglebot`, `gbvTitle`, `gbvSub`, `gbvRun`, `gbvUrlPh`, `gbvVerdictClean`, `gbvVerdictSuspicious`, `gbvVerdictCloaking`, `gbvColGooglebot`, `gbvColBrowser`, `gbvRedirectChain`, `gbvHopStatus`, `gbvCanonicalHtml`, `gbvCanonicalHeader`, `gbvCanonicalGoogle`, `gbvMetaRobots`, `gbvXRobots`, `gbvHreflang`, `gbvJsRedirect`, `gbvBlocked`, `gbvTrueView`, `gbvIndexStatus`, `gbvLastCrawl`, `gbvWayback`, `gbvDisclaimer`, `gbvOwnSiteOnly`.

> Проверка: в каждом из трёх файлов сейчас по 2072 ключа — после правок число должно остаться равным во всех трёх.

---

## 5. Правила детекта клоакинга (эвристики диффа)

`diffViews()` сравнивает основной взгляд Googlebot (`gbMobile`) с браузером (`chrome`) и начисляет баллы:

| Условие | Баллы | Флаг |
|---|---|---|
| Разные финальные хосты (редирект только для одного UA) | +50 | «Редирект только для браузера/бота» |
| Разный финальный статус (напр. 200 vs 302) | +40 | «Разный код ответа» |
| canonical для бота ≠ canonical для браузера | +30 | «Подмена canonical» |
| `noindex` только в одном из видов | +30 | «Различие индексируемости» |
| Разница `wordCount` > 40% | +25 | «Существенно разный объём контента» |
| Разные `bodyHash` при одинаковом статусе/URL | +15 | «Контент отличается» |
| JS-редирект есть только в одном виде | +25 | «JS-редирект для конкретного UA» |
| Googlebot-UA получил `403/429`, браузер — `200` | +20 | «Сайт блокирует поддельного бота (reverse-DNS)» |

Итог: `score ≥ 50` → `cloaking`; `20–49` → `suspicious`; `< 20` → `clean`. Баллы и флаги показываем в UI, чтобы вердикт был объяснимым, а не «чёрным ящиком».

---

## 6. Edge-кейсы и безопасность

- **SSRF (критично).** Роут фетчит произвольный URL от пользователя на стороне сервера → до запроса резолвить хост и **блокировать приватные/зарезервированные диапазоны** (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fd00::/8`) и облачные metadata-эндпоинты (`169.254.169.254`). Иначе `400 private_host`.
- **Циклические редиректы** — счётчик хопов, обрыв на 20, пометка «loop».
- **Относительный/протокол-относительный `Location`** — резолвить относительно текущего URL.
- **Не-HTML `Content-Type`** (pdf, image) — не парсить как HTML, показать тип и размер.
- **Гигантские страницы** — читать тело с ограничением (напр. 2 МБ), затем обрыв.
- **Self-referencing canonical** — норма, не флаг.
- **IDN/punycode** — нормализовать хост перед сравнением.
- **Тайм-ауты** — 15 с на взгляд; частичный результат лучше падения.
- **Вежливость** — один прогон = ~3–4 запроса к целевому URL; не зацикливать, добавить лёгкий rate-limit на пользователя.

---

## 7. Фазы

**MVP (Фаза 1):** взгляды `gbMobile` + `chrome`, ручная цепочка редиректов, парсинг сигналов, вердикт-диф, SSRF-защита, панель True Google View для своих сайтов, регистрация в TABS/TILES, локали. Это уже полностью закрывает «увидеть страницу как Googlebot + поймать UA-клоаку».

**Фаза 2:** взгляд `gbDesktop` и `gb+referer`, Wayback, сохранение в историю, JS-рендеринг через Firecrawl (ловля JS-клоаки), гео-варианты (через прокси, если появятся).

---

## 8. Юридично-этическая заметка

Подстановка User-Agent для просмотра публичных страниц — стандартная SEO-разведка, но стоит соблюдать вежливый rate-limit и не долбить чужой сайт. Инструмент читает только публично отдаваемый контент; приватные данные не затрагиваются.

---

## 9. Оценка объёма

- `googlebot.ts` — ~250–320 строк.
- `route.ts` — ~60–90 строк (+ SSRF-хелпер).
- `page.tsx` — ~250–350 строк (основной объём — UI-разметка вида/таблиц).
- Регистрация + локали — мелкие точечные правки.

Ориентир для Фазы 1 (MVP) — 1 рабочий день.

---

## 10. Rich Results — взгляд настоящего Googlebot (обход IP-клоаки)

**Проблема.** UA-спуф (`followChain`) и рендер через Firecrawl ходят с дата-центрового IP. Продвинутые клоакеры (гемблинг, PBN) отдают «версию для Googlebot» только на **реальный IP Google** (проверка reverse-DNS). Такую IP-клоаку не видит ни один внешний фетчер.

**Единственный способ** увидеть эту версию — прогнать URL через собственный инструмент Google (**Rich Results Test**), который краулит как настоящий Googlebot с IP Google. Официального API нет (Mobile-Friendly Test API отключён Google в конце 2024), поэтому автоматизируем веб-инструмент headless-браузером.

Реализация: `src/lib/seo/richResults.ts` (Playwright) + `POST /api/seo/googlebot/rich-results` + кнопка/вставка в UI. Возвращает `ViewResult` с `ua: "gbRichResults"` — авторитетный взгляд Googlebot; из него бар сигналов подсвечивает off-domain canonical (напр. `d2eplantparlour.com`).

**Два режима:**
- **Авто** — Playwright анонимно (без Google-логина) открывает Rich Results Test, сабмитит URL, ждёт результат, извлекает rendered HTML. Экспериментально: возможна CAPTCHA, DOM Google меняется → селекторы в `richResults.ts` (`TEST_BTN`/`VIEW_PAGE`/`HTML_TAB`) придётся подкручивать.
- **Ручная вставка** (надёжный fallback) — пользователь копирует HTML из Rich Results Test → инструмент парсит его как взгляд Googlebot. Работает всегда, без Playwright и без нарушения ToS.

**Установка Playwright на сервере (для авто-режима):**

```bash
npm install                      # playwright ставится из optionalDependencies
npx playwright install chromium  # + системные библиотеки: npx playwright install-deps
```

В Docker добавить установку `chromium` и его зависимостей в `Dockerfile`.

**Опционально — залогиненная сессия** (выше лимиты, реже CAPTCHA): экспортировать `storageState` залогиненного в Google браузера в JSON и указать путь в env `GOOGLE_RICH_RESULTS_STORAGE_STATE`. **Важно про безопасность:** этот файл = полная сессия Google-аккаунта; храни его как секрет, по умолчанию режим анонимный и куки не нужны.

**Юридично.** Автоматизированный доступ к инструменту Google — серая зона по его ToS. Ручная вставка таких вопросов не создаёт. Авто-режим — на усмотрение и риск владельца проекта.

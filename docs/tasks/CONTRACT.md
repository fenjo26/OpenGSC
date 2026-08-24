# CONTRACT — общий контракт задач T0…T6

Единственный источник правды по именам. Копировать буквально, не «улучшать».

---

## 0. Смысловое ядро, которое нельзя перепутать

В существующем коде вкладки «Обратные ссылки» есть проверка `check-alive`. Она отвечает
на вопрос **«страница-донор отвечает 200?»**. Она **не** отвечает на вопрос
**«ссылка на нас всё ещё стоит на этой странице?»**.

Сейчас площадка может снять ссылку, оставив страницу живой, и в интерфейсе будет
зелёная галочка. Вся эта волна существует, чтобы развести два вопроса.

Поэтому в новой модели **два независимых поля состояния**, и путать их нельзя:

- `pageStatus` — доступность страницы-донора: `unknown | alive | dead | blocked`
- `checkStatus` — наличие нашей ссылки на ней: `unchecked | found | missing | blocked | error`

`pageStatus = "alive"` при `checkStatus = "missing"` — это и есть «кинули», главный
сценарий продукта. Никогда не выводи одно из другого.

Третий независимый источник — что говорит Ahrefs (поля `api*`). Ценность именно
в расхождениях:

| Ahrefs | наша проверка | `apiJsCrawl` | Вывод |
|---|---|---|---|
| видит | `found` | — | всё честно |
| не видит | `found` | — | поставили, Ahrefs не переобошёл |
| видит | `missing` | `true` | ссылка вставляется JS — не кидок |
| видит | `missing` | `false` | сняли только что |
| не видит | `missing` | — | **кинули** |

---

## 1. Prisma-модели

Добавляются в **оба** файла: `prisma/schema.prisma` и `prisma/schema.mysql.prisma`.
В mysql-варианте длинные строковые поля, участвующие в индексах и уникальных ключах,
объявляй с `@db.VarChar(500)` — иначе MySQL не построит индекс по `TEXT`.

```prisma
model SiteBacklink {
  id            String   @id @default(cuid())
  siteId        String

  // --- идентичность ---
  // urlFrom хранится ровно как пришёл (из импорта или от API), чтобы строки
  // склеивались с таблицей клиента. urlFromNorm — нормализованный ключ для дедупа.
  urlFrom       String
  urlFromNorm   String
  urlTo         String   @default("")   // наша страница; "" когда неизвестна
  domainFrom    String   @default("")

  // --- что говорит провайдер (Ahrefs) ---
  apiSeen       Boolean   @default(false)
  apiLost       Boolean   @default(false)
  apiLostReason String    @default("")
  apiAnchor     String    @default("")
  apiAlt        String    @default("")
  apiDofollow   Boolean   @default(true)
  apiNofollow   Boolean   @default(false)
  apiSponsored  Boolean   @default(false)
  apiUgc        Boolean   @default(false)
  apiContent    Boolean   @default(true)    // is_content: в контенте, а не в футере
  apiImage      Boolean   @default(false)
  apiJsCrawl    Boolean   @default(false)   // Ahrefs нашёл ссылку только через JS-рендер
  apiDr         Float?
  apiHttpCode   Int?
  apiLinkType   String    @default("")
  apiSnippet    String    @default("")      // snippet_left + snippet_right, обрезано до 500
  apiFirstSeen  String    @default("")      // YYYY-MM-DD
  apiLastSeen   String    @default("")
  apiFetchedAt  DateTime?

  // --- что говорит наша собственная загрузка страницы ---
  checkStatus        String   @default("unchecked") // unchecked|found|missing|blocked|error
  checkAnchor        String   @default("")
  checkRel           String   @default("")   // сырой rel, как в HTML
  checkNofollow      Boolean  @default(false)
  checkSponsored     Boolean  @default(false)
  checkUgc           Boolean  @default(false)
  checkFoundUrl      String   @default("")   // абсолютный URL найденной ссылки
  checkMatchedDomain String   @default("")   // какой из наших доменов совпал
  checkTargetOk      Boolean?                // ссылка ведёт на обещанный urlTo
  checkError         String   @default("")
  checkInsecure      Boolean  @default(false) // страница взята с отключённой проверкой TLS
  checkedAt          DateTime?

  // --- доступность самой страницы-донора (наследник старого check-alive) ---
  pageStatus    String    @default("unknown") // unknown|alive|dead|blocked
  pageTitle     String    @default("")
  pageCheckedAt DateTime?

  // --- индексация (перенос из старой модели Backlink) ---
  xrStatus       String    @default("")   // indexed|not_indexed|error
  xrCheckedAt    DateTime?
  twoIndexStatus String    @default("")   // submitted
  twoIndexAt     DateTime?

  // --- данные оператора ---
  source    String   @default("api")  // кто создал строку: api|csv|manual
  sources   String   @default("")     // все источники, через запятую: "api,csv"
  favorite  Boolean  @default(false)
  priceNote String   @default("")
  note      String   @default("")

  addedAt   DateTime @default(now())
  updatedAt DateTime @updatedAt

  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)

  @@unique([siteId, urlFromNorm, urlTo])
  @@index([siteId, checkStatus])
  @@index([siteId, apiLost])
  @@index([siteId, favorite])
  @@index([siteId, domainFrom])
  @@index([siteId, addedAt])
}

model SiteBacklinkEvent {
  id         String   @id @default(cuid())
  siteId     String
  backlinkId String
  // appeared | lost | returned | rel_downgraded | rel_upgraded | anchor_changed | target_changed
  kind       String
  detail     String   @default("")   // JSON: {"from":"...","to":"..."}
  origin     String   @default("api") // api | check
  createdAt  DateTime @default(now())

  @@index([siteId, createdAt])
  @@index([backlinkId, createdAt])
}

model SiteBacklinkSync {
  id             String    @id @default(cuid())
  siteId         String
  kind           String    @default("api")      // api | verify
  status         String    @default("running")  // running | completed | error
  stage          String    @default("pull")     // pull | persist | completed | error
  progress       Int       @default(0)          // 0..100
  pagesPulled    Int       @default(0)
  rowsSeen       Int       @default(0)
  unitsSpent     Int       @default(0)
  complete       Boolean   @default(false)      // см. раздел 4 — можно ли делать выводы о потерях
  paginationMode String    @default("")         // offset | keyset
  summary        String?                        // JSON
  error          String?
  heartbeatAt    DateTime?
  startedAt      DateTime  @default(now())
  finishedAt     DateTime?

  @@index([siteId, startedAt])
}
```

В модель `Site` добавляется обратная связь:

```prisma
  siteBacklinks SiteBacklink[]
```

### Правило записи, которое делает три источника совместимыми

Строка одна, писателей трое. Каждый писатель в `update` называет **только свою группу полей**:

- выгрузка из API трогает только `api*` + `domainFrom` + `sources`
- чекер размещений трогает только `check*` + `pageStatus` / `pageTitle` / `pageCheckedAt`
- импорт и оператор трогают только `urlTo`, `favorite`, `note`, `priceNote`, `source`, `sources`

Никогда не пиши `update: { ...всё }`. Обнулённое чужое поле — это стёртый результат
проверки, за которую пользователь уже заплатил временем или деньгами.

Доступ — через Prisma-клиент (`prisma.siteBacklink...`), как у существующей модели
`Backlink`. Слой `rawQuery`/`runUpsert` здесь **не** нужен: это не платный
add-on, который должен деградировать на немигрированной БД.

---

## 2. Общие типы — `src/lib/seo/backlinkTypes.ts`

Создаёт T0. Все остальные импортируют, никто не правит.

```ts
export type PlacementStatus = "unchecked" | "found" | "missing" | "blocked" | "error";
export type PageStatus = "unknown" | "alive" | "dead" | "blocked";
export type BacklinkSource = "api" | "csv" | "manual";
export type BacklinkEventKind =
  | "appeared" | "lost" | "returned"
  | "rel_downgraded" | "rel_upgraded"
  | "anchor_changed" | "target_changed";

/** Разобранный атрибут rel. Булев "nofollow" недостаточен: sponsored и ugc
 *  тоже не передают вес, но nofollow при этом может отсутствовать. */
export interface RelFlags {
  raw: string;
  nofollow: boolean;
  sponsored: boolean;
  ugc: boolean;
  /** true, когда не выставлен ни один из трёх — то есть ссылка реально передаёт вес */
  dofollow: boolean;
}

/** Одна ссылка, найденная на странице-доноре. */
export interface PlacementHit {
  /** URL донора ровно как его передали на вход (для джойна с таблицей клиента) */
  sourceUrl: string;
  /** URL страницы, которая фактически ответила (после редиректов) */
  finalUrl: string;
  /** какой из наших доменов совпал */
  matchedDomain: string;
  /** абсолютный URL ссылки */
  linkUrl: string;
  /** анкор; для картиночных ссылок — alt; схлопнутые пробелы, максимум 200 символов */
  anchor: string;
  isImage: boolean;
  rel: RelFlags;
}

/** Результат сканирования одной страницы. */
export interface PlacementScan {
  sourceUrl: string;
  finalUrl: string;
  status: PlacementStatus;
  pageStatus: PageStatus;
  httpStatus: number;
  /** пусто при status !== "error" */
  error: string;
  /** страница взята с отключённой проверкой сертификата */
  insecure: boolean;
  hits: PlacementHit[];
}

/** Строка, как её отдаёт API интерфейсу. */
export interface BacklinkRow {
  id: string;
  urlFrom: string;
  urlTo: string;
  domainFrom: string;
  favorite: boolean;
  source: BacklinkSource;
  sources: string[];

  apiSeen: boolean;
  apiLost: boolean;
  apiAnchor: string;
  apiDr: number | null;
  apiDofollow: boolean;
  apiSponsored: boolean;
  apiUgc: boolean;
  apiContent: boolean;
  apiJsCrawl: boolean;
  apiFirstSeen: string;

  checkStatus: PlacementStatus;
  checkAnchor: string;
  checkRel: string;
  checkNofollow: boolean;
  checkSponsored: boolean;
  checkUgc: boolean;
  checkTargetOk: boolean | null;
  checkError: string;
  checkedAt: string | null;

  pageStatus: PageStatus;
  pageTitle: string;
  xrStatus: string;
  addedAt: string;
}

export interface BacklinkListStats {
  total: number;
  found: number;
  missing: number;
  blocked: number;
  unchecked: number;
  apiLost: number;
  favorites: number;
  nofollow: number;
}

export interface BacklinkListResponse {
  rows: BacklinkRow[];
  total: number;
  page: number;      // 1-based
  pageSize: number;
  stats: BacklinkListStats;   // по всей выборке с учётом фильтров, не по странице
}

/** Итог одного прогона — и для выгрузки, и для проверки. Формат общий,
 *  потому что дайджест и UI читают его одинаково. */
export interface SyncSummary {
  scanned: number;
  withLink: number;
  zeroMatches: number;
  errors: number;
  blocked: number;
  byDomain: Record<string, number>;
  byError: Record<string, number>;
  unitsSpent: number;
  complete: boolean;
}
```

---

## 3. Ядро парсера — сигнатуры (реализует T2, потребляет T4)

```ts
// src/lib/seo/linkPlacement.ts
export function canonicalizeDomain(input: string): string | null;
export function matchOwnedDomain(host: string, owned: string[]): string | null;
export function parseRel(rel: string | null | undefined): RelFlags;
export function decodeBody(buf: ArrayBuffer, contentTypeHeader: string): string;
export function extractBaseHref(html: string, finalUrl: string): string;
export function findPlacements(
  html: string,
  finalUrl: string,
  ownedDomains: string[],
  opts?: { sourceUrl?: string },
): PlacementHit[];
```

---

## 4. Флаг `complete` — правило, которое нельзя нарушать

В существующем `/api/metrics/backlinks` есть строка

```ts
const complete = minDr === 0 && profile.refDomains.length < limit;
```

Смысл: **выводы о потерях можно делать только по полной выгрузке.** Частичная —
упёршаяся в лимит, отфильтрованная по DR, оборванная на середине — может добавлять
строки, но не имеет права помечать что-либо потерянным. Иначе мы выдумаем потери
и разошлём алерты о том, чего не было.

В новой схеме то же самое живёт в `SiteBacklinkSync.complete`. Правила:

- `complete = true` только когда прогон дошёл до конца без фильтров и без обрыва.
- Пока в БД нет **ни одного** завершённого прогона с `complete = true`, дайджест
  и алерты обязаны молчать о потерях (первая полная выгрузка иначе отрапортует
  «потеряно 8000 ссылок» на пустом месте).
- `apiLost` теперь приходит от Ahrefs напрямую (`history=all_time` + поле `is_lost`),
  а не вычисляется как «не пришло в этой выгрузке». Локальное вычисление остаётся
  только для CSV-импорта, у которого истории нет по определению.

---

## 5. Шлюз Ahrefs — факты, на которые опирается код

Хост берётся из `getMetricsCreds()` (`src/lib/seo/metricsClient.ts`), не хардкодится.
У Руслана это `https://ahrefs-api.groupbuyseo.org` — реселлерский шлюз, wire-совместимый
с Ahrefs API v3. Официальный хост `https://api.ahrefs.com`. Путь после хоста одинаковый.

- **Цена:** `units = max(50, per_row_cost × rows_returned)`, где `per_row_cost` — сумма
  стоимостей **уникальных** полей в `select` + `where` + `order_by`. Поле, по которому
  фильтруют или сортируют, биллится, даже если не возвращается.
- **Тарифы полей:** 15 — AI-цитирование (`chatgpt`, `gemini`, `perplexity`, …);
  10 — traffic/volume/difficulty/value и их суффиксы `_prev` / `_merged`;
  5 — счётчики ref-доменов (`refdomains`, `refdomains_source`, `class_c`, `all_positions`,
  `dofollow_refdomains`, …); 1 — всё остальное.
- **Неудачные (4xx/5xx) и закэшированные ответы стоят 0 юнитов.**
- **Не более 3 одновременных запросов на ключ**, иначе 429. Семафор уже есть
  в `src/lib/seo/metrics.ts`.
- Ответ списочного эндпоинта — **объект**, а не массив: `{ "backlinks": [...] }`.
- 400 (неизвестное поле в `select`) — чинить, не ретраить. 401 — ключ.
  402 — кончились юниты. 403 — продукт не подключён к ключу. 429 — бэкофф.
  502 — временное, ретраить с бэкоффом.
- **`offset`.** Официальная дока Ahrefs его для `refdomains` / `all-backlinks`
  не документирует, дока шлюза перечисляет в общих параметрах. Считать неизвестным
  и проверять в рантайме — см. ТЗ T3.
- **`/v3/subscription-info/limits-and-usage` бесплатен** и возвращает
  `units_limit_api_key`, `units_usage_api_key`, `units_limit_workspace`,
  `units_usage_workspace`, `usage_reset_date`, `api_key_expiration_date`.

### Набор полей для выгрузки бэклинков (все по 1 юниту)

```
url_from, url_to, anchor, alt, is_dofollow, is_nofollow, is_sponsored, is_ugc,
is_content, is_image, domain_rating_source, first_seen_link, last_seen,
is_lost, lost_reason, http_code, js_crawl, link_type, snippet_left, snippet_right
```

Двадцать полей = 20 юнитов на строку. 10 000 ссылок ≈ 200 000 юнитов ≈ $5 по
цене $0.000025/юнит. **Ни при каких условиях не добавляй сюда `traffic` (10),
`traffic_domain` (10), `refdomains_source` (5).**

---

## 6. i18n — распределение префиксов

Все ключи создаёт T0 в семи локалях (`en, ru, uk, fr, es, de, zh`). Остальные задачи
только используют. Список нужных ключей каждая задача декларирует в своём ТЗ.

| Префикс | Задача |
|---|---|
| `blsrc*` | T1 — источник данных, баланс, ошибки ключа |
| `blsync*` | T3 — выгрузка из API |
| `blchk*` | T4 — проверка размещений |
| `blui*` | T5 — вкладка, импорт, фильтры, пагинация |
| `dgl*` | T6 — дайджест и алерты по ссылкам |

Существующие ключи `backlinks*`, `bl*Full`, `blp*` уже заняты старой вкладкой
и профилем — не переиспользовать и не переопределять.

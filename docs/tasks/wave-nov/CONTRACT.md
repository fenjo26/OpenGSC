# CONTRACT — волна «Ноябрь», N0…N11

Единственный источник правды по схеме, общим именам, маршрутам и шаблонам уведомлений.
Копировать буквально. Ошибку не исправлять молча — писать в отчёте. i18n-ключи — в конце
каждого брифа (`README.md` §5).

---

## 0. Ловушки, ради которых написан контракт

1. **Своя ниша — не токсичность (N2).** Классификатор дропов (`src/lib/drops/toxicity`) считает
   казино, ставки и адалт токсичными: для дропа это верно. Для гемблинг-сайта Руслана ссылка с
   казино-анкором — нормальная тематическая ссылка. Поэтому у сайта есть `backlinkNiche`
   (группы маркеров, которые для него не токсичны), и классификатор получает её явно.
2. **Local pack ≠ органика (N3).** Позиция в тройке на карте и позиция в органической выдаче —
   два разных числа в двух полях. Слить их в одно `position` значит испортить историю, графики
   и алерты `rank_drop` для всех существующих ключей.
3. **Город меняет identity ключа (N3).** Один и тот же запрос из Салоник и из Афин — два разных
   отслеживаемых ключа. `location` входит в `@@unique`, по умолчанию `""` (как раньше), и
   старые строки остаются теми же ключами.
4. **До одобрения GBP API — 0, а не ошибка (N4).** Квота непроверенного проекта равна 0. Это
   состояние `gbp_access_required` с объяснением и ссылкой на заявку, а не красный стектрейс.
5. **Точная цитата стоит денег (N6).** Каждое предложение, проверенное на плагиат, — это один
   запрос в SERP. Выборка ограничена (≤ 10 предложений), цена считается и показывается **до**
   запуска, а без подтверждения платный провайдер не вызывается.
6. **Публичный контур не видит ничего своего (N9).** Виджет аудита открыт анониму. Он не
   читает GSC, сайты, ключи и лиды владельца, `safeFetch` вызывает с `allowPrivate: false`,
   ограничен rate limit и Turnstile. Утечка через него — худший сценарий волны.
7. **Отчёт клиенту — снимок, а не живая ссылка на всё (N8).** Отправленный отчёт хранит свой
   HTML и не меняется задним числом. Клиентская ссылка открывает только отчёты своего сайта.
8. **Push без HTTPS не работает (N10).** Service worker и Push API доступны только на `https://`
   (и `localhost`). На `http://` UI объясняет это и не показывает кнопку.

---

## 1. Prisma (N0 вставляет дословно)

### 1.1 Поля в существующих моделях

`model Site`:
```prisma
  // Backlink toxicity (N2). JSON: { ownNiche: string[] } — marker-group codes from
  // src/lib/drops/toxicity/markers.ts that are NOT toxic for this site (e.g. ["gambling"]).
  backlinkNiche   String?
  localProfile    LocalProfile?
  localCitations  LocalCitation[]
  gbpPosts        GbpPost[]
  gbpReviews      GbpReview[]
  trendSeeds      TrendSeed[]
  trendItems      TrendItem[]
  clientReports   ClientReport[]
```

`model User`:
```prisma
  reportBranding  String?          // JSON: ReportBranding (N8)
  widgetKey       String? @unique  // public id of the workspace's audit widget (N9)
  widgetSettings  String?          // JSON: WidgetSettings (N9)
  extToken        String? @unique  // browser-extension bearer token (N11), separate from mcpToken so it can be revoked alone
  footprintIgnore String?          // JSON: string[] — footprint skeletons the operator marked as fine (N1)
  extAllowedIds   String?          // newline-separated extension ids allowed by CORS (N11)
  gbpToken        String?          // JSON: { refresh_token, access_token, expires_at, scope } — Business Profile OAuth (N4), server-only
```

`model SiteBacklink` (после блока `--- operator data ---`):
```prisma
  // --- toxicity of the donor, for THIS site's niche (N2) ---
  toxLevel      String    @default("unknown") // unknown|clean|suspicious|toxic
  toxScore      Int?                          // 0..100
  toxSignals    String?                       // JSON: string[] — KNOWN_TOX_SIGNALS codes
  toxCheckedAt  DateTime?
  disavow       Boolean   @default(false)     // operator decision, never set automatically
  disavowNote   String    @default("")
```
и индекс `@@index([siteId, toxLevel])`.

`model TrackedKeyword`:
```prisma
  location      String    @default("")  // "" = country-level (as before) | city name | "lat,lng"
  lastLocalPack Int?                    // 1..3 = place in the map pack, null = not in pack / no pack
```
и **замена** `@@unique([siteId, keyword, device, country])` на
`@@unique([siteId, keyword, device, country, location])`.

`model RankCheck`:
```prisma
  localPack      Int?     // 1..3, null = not in pack
  localPackTitle String?  // business name Google showed at that place
  hasLocalPack   Boolean? // the SERP had a map pack at all; null = provider does not say
```

`model SitemapUrl`:
```prisma
  serpIndexStatus   String?   // indexed | not_indexed | error — from a site: query (N6), NOT Google's own verdict
  serpIndexChecked  DateTime?
  serpIndexProvider String?
```

`model AeoCheck`:
```prisma
  sentiment      String?  // positive | neutral | negative | mixed; null = not analysed
  sentimentScore Float?   // -1..1
  sentimentNote  String?  // ≤ 300 chars, what the answer says about the brand
```

### 1.2 Новые модели (в конец файла)

```prisma
// ─── Local SEO (N4) ──────────────────────────────────────────────────────────
model LocalProfile {
  id            String   @id @default(cuid())
  siteId        String   @unique
  name          String
  businessType  String   @default("LocalBusiness") // schema.org type: TaxiService, DaySpa, Restaurant…
  street        String   @default("")
  locality      String   @default("")
  region        String   @default("")
  postalCode    String   @default("")
  country       String   @default("")   // ISO-3166 alpha-2
  phone         String   @default("")   // E.164
  email         String   @default("")
  lat           Float?
  lng           Float?
  hours         String?                 // JSON: { day: "Mo".."Su", opens: "09:00", closes: "21:00" }[]
  priceRange    String   @default("")
  sameAs        String   @default("")   // newline-separated profile URLs
  serviceAreas  String   @default("")   // newline-separated cities/areas
  gbpAccount    String?                 // "accounts/123"
  gbpLocation   String?                 // "locations/456"
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)
}

model LocalCitation {
  id         String    @id @default(cuid())
  siteId     String
  url        String
  directory  String    @default("")          // human label, e.g. "Yelp", "Xo.gr"
  status     String    @default("unchecked") // unchecked|consistent|mismatch|missing|unreachable
  found      String?                         // JSON: { name?, phone?, address? } as seen on the page
  diffs      String?                         // JSON: NapDiff[]
  checkedAt  DateTime?
  createdAt  DateTime  @default(now())

  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)
  @@unique([siteId, url])
}

model GbpPost {
  id           String    @id @default(cuid())
  siteId       String
  summary      String
  ctaType      String?                        // BOOK | ORDER | LEARN_MORE | CALL | SIGN_UP
  ctaUrl       String?
  mediaUrl     String?                        // public https image URL
  scheduledAt  DateTime
  status       String    @default("scheduled") // draft|scheduled|published|failed
  gbpName      String?                        // resource name returned by the API
  error        String?
  createdAt    DateTime  @default(now())

  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)
  @@index([status, scheduledAt])
}

model GbpReview {
  id         String    @id @default(cuid())
  siteId     String
  reviewId   String
  author     String    @default("")
  rating     Int                              // 1..5
  comment    String    @default("")
  createTime DateTime
  replyText  String?
  replyTime  DateTime?
  fetchedAt  DateTime  @default(now())
  notifiedAt DateTime?

  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)
  @@unique([siteId, reviewId])
  @@index([siteId, createTime])
}

// ─── Trend radar (N5) ────────────────────────────────────────────────────────
model TrendSeed {
  id        String   @id @default(cuid())
  siteId    String
  seed      String
  lang      String   @default("")
  country   String   @default("")
  createdAt DateTime @default(now())

  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)
  @@unique([siteId, seed])
}

model TrendItem {
  id              String   @id @default(cuid())
  siteId          String
  source          String   // gsc_rising | gsc_new | suggest
  query           String
  score           Float    // source-specific, higher = hotter; see src/lib/trends
  impressions     Int?
  prevImpressions Int?
  seed            String?
  firstSeenAt     DateTime @default(now())
  lastSeenAt      DateTime @default(now())
  dismissed       Boolean  @default(false)

  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)
  @@unique([siteId, source, query])
  @@index([siteId, lastSeenAt])
}

// ─── Plagiarism (N6) ─────────────────────────────────────────────────────────
model PlagiarismCheck {
  id         String    @id @default(cuid())
  userId     String
  historyId  String?                  // SeoHistory id when checking a generated text
  textHash   String                   // sha1 of the normalised text
  provider   String                   // serper | dataforseo | aparser | …
  status     String    @default("running") // running | done | failed
  queries    Int       @default(0)
  costUsd    Float?
  result     String?                  // JSON: PlagiarismResult
  error      String?
  createdAt  DateTime  @default(now())
  finishedAt DateTime?

  @@index([userId, createdAt])
  @@index([userId, textHash])
}

// ─── Client reports (N8) ─────────────────────────────────────────────────────
model ClientReport {
  id          String    @id @default(cuid())
  userId      String
  siteId      String
  title       String
  template    String    @default("executive") // executive | detailed | technical | local
  sections    String                           // JSON: ReportSectionId[]
  periodDays  Int       @default(30)
  schedule    String    @default("off")        // off | weekly | monthly
  sendDay     Int       @default(1)            // weekday 1..7 or day of month 1..28
  recipients  String    @default("")           // comma-separated e-mails
  notes       String    @default("")           // operator's "what we did" text, markdown
  shareToken  String?   @unique                  // client link /share/report/<token> (N8); null = link off
  lastSentAt  DateTime?
  nextSendAt  DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  site Site             @relation(fields: [siteId], references: [id], onDelete: Cascade)
  runs ClientReportRun[]
  @@index([userId])
  @@index([nextSendAt])
}

model ClientReportRun {
  id         String    @id @default(cuid())
  reportId   String
  periodFrom DateTime
  periodTo   DateTime
  html       String                // frozen rendered snapshot — never re-rendered
  pdfPath    String?               // under data/reports/, when a PDF was produced
  sentTo     String?
  error      String?
  createdAt  DateTime  @default(now())

  report ClientReport @relation(fields: [reportId], references: [id], onDelete: Cascade)
  @@index([reportId, createdAt])
}

// ─── Leads from the embeddable audit widget (N9) ─────────────────────────────
model Lead {
  id        String   @id @default(cuid())
  userId    String                        // workspace owner the widget belongs to
  domain    String
  email     String
  name      String   @default("")
  message   String   @default("")
  score     Int                           // 0..100, the lite audit's score
  findings  String                        // JSON: LeadFinding[]
  source    String   @default("widget")   // widget | manual
  status    String   @default("new")      // new | contacted | won | lost | client
  ipHash    String                        // salted sha256 — never the raw IP
  origin    String   @default("")         // page the widget was embedded on
  proposal  String?                       // markdown, generated by N9
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId, createdAt])
  @@index([userId, status])
}

// ─── Web push (N10) ──────────────────────────────────────────────────────────
model PushSubscription {
  id        String    @id @default(cuid())
  userId    String
  endpoint  String    @unique
  p256dh    String
  auth      String
  userAgent String    @default("")
  events    String    @default("")   // comma-separated NotifyEvent; "" = all
  failures  Int       @default(0)
  lastOkAt  DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}

// Instance-wide key/value for generated secrets that must survive restarts (VAPID keys, N10).
model InstanceSetting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
}
```

---

## 2. Изменения общих типов (N0)

- `src/lib/notify/types.ts`: `NotifyEvent` += `"lead" | "local" | "trend"`;
  `NOTIFY_EVENTS` дополнить этими тремя; `NotifyChannelId` += `"webpush"`.
- `src/lib/seo/aeo.ts` **не** трогает N0: движок `"ai_overview"` добавляет N7.

---

## 3. Заглушки N0

N0 создаёт каждый модуль из таблицы с **одним** экспортом-маркером
`export const NOT_IMPLEMENTED = "Nx";` и пустым тестом в папке с глобом. Сигнатуры внутри
задачи владелец определяет сам: наружу они не видны, кроме маршрутов из §4.
Для страниц — клиентский компонент с заголовком из ключа `<prefix>Title` брифа.
Для планировщиков — `export function startXScheduler(): void {}` (пустая, не бросает).

| Модуль / страница | Задача |
|---|---|
| `src/lib/footprint/index.ts`, `src/app/footprint/page.tsx`, `src/lib/hreflang/index.ts`, `src/app/seo-tools/hreflang/page.tsx`, `src/lib/mcp/toolsFootprint.ts` | N1 |
| `src/lib/backlinks/index.ts`, `src/lib/backlinks/scheduler.ts` (`startBacklinkToxScheduler`), `src/lib/mcp/toolsBacklinkTox.ts` | N2 |
| `src/lib/seo/localPack.ts` | N3 |
| `src/lib/local/index.ts`, `src/lib/local/scheduler.ts` (`startLocalScheduler`), `src/app/local/page.tsx`, `src/lib/mcp/toolsLocal.ts` | N4 |
| `src/lib/trends/index.ts`, `src/lib/trends/scheduler.ts` (`startTrendsScheduler`), `src/components/TrendRadar.tsx`, `src/lib/mcp/toolsTrends.ts` | N5 |
| `src/lib/plagiarism/index.ts`, `src/app/seo-tools/plagiarism/page.tsx`, `src/lib/indexing/serpIndex.ts`, `src/lib/mcp/toolsPlagiarism.ts` | N6 |
| `src/lib/reports/index.ts`, `src/lib/reports/scheduler.ts` (`startReportsScheduler`), `src/app/reports/page.tsx`, `src/components/reports/ReportBrandingCard.tsx`, `src/lib/mcp/toolsReports.ts` | N8 |
| `src/lib/leads/index.ts`, `src/app/leads/page.tsx`, `src/app/embed/audit/page.tsx`, `src/components/leads/WidgetSettingsCard.tsx`, `src/lib/mcp/toolsLeads.ts` | N9 |
| `src/lib/push/index.ts`, `src/components/PushSettingsCard.tsx` | N10 |
| `src/lib/ext/index.ts`, `src/components/ExtensionTokenCard.tsx`, `extension/manifest.json` (минимальный MV3) | N11 |

MCP: каждый `tools*.ts` из таблицы экспортирует `X_TOOLS: McpTool[] = []`; N0 регистрирует
все в `MCP_TOOLS`. Имена массивов: `FOOTPRINT_TOOLS`, `BACKLINK_TOX_TOOLS`, `LOCAL_TOOLS`,
`TRENDS_TOOLS`, `PLAGIARISM_TOOLS`, `REPORTS_TOOLS`, `LEADS_TOOLS`.

Планировщики в `src/instrumentation.ts` после блока mentions:
`startBacklinkToxScheduler`, `startLocalScheduler`, `startTrendsScheduler`, `startReportsScheduler`.

Меню (`DashboardShell.tsx`), после `/serp-monitor`: `/footprint` (`fpNavTitle`, иконка
`Fingerprint`), `/local` (`locNavTitle`, `MapPin`), `/reports` (`repNavTitle`, `FileText`),
`/leads` (`leadNavTitle`, `Inbox`). SEO Tools получает `hreflang` и `plagiarism` через
`src/lib/seo/toolsNav.ts` — это делает N6 для обоих (файл его).

Settings (`settings/page.tsx`), N0 вставляет после `<UptimeSettingsCard />`:
`<PushSettingsCard />`, `<ReportBrandingCard />`, `<WidgetSettingsCard />`, `<ExtensionTokenCard />`.

Регистрация тестов — в конец `test:unit`:
```
src/lib/footprint/*.test.ts src/lib/hreflang/*.test.ts src/lib/backlinks/*.test.ts src/lib/seo/localPack.test.ts src/lib/local/*.test.ts src/lib/trends/*.test.ts src/lib/plagiarism/*.test.ts src/lib/indexing/serpIndex.test.ts src/lib/reports/*.test.ts src/lib/leads/*.test.ts src/lib/push/*.test.ts src/lib/ext/*.test.ts
```

Зависимости (N0, в основной папке, см. README §3): `web-push` и `@types/web-push` (N10).
Для PDF (N8) новых зависимостей нет: `playwright` уже в `package.json`, а если на сервере
нет браузера, отчёт отдаётся как HTML.

---

## 4. Маршруты

| Метод и путь | Доступ | Задача |
|---|---|---|
| `GET /api/footprint?kind=title\|h1\|description&minSites=2` | read | N1 |
| `POST /api/footprint/ignore` | act | N1 |
| `POST /api/backlinks/toxicity/run` `{ siteId, limit? }` | act (net) | N2 |
| `GET /api/backlinks/toxicity?siteId=` · `PUT …/niche` | read · act | N2 |
| `GET /api/backlinks/disavow?siteId=` → `text/plain` | read | N2 |
| `PATCH /api/backlinks/disavow` `{ ids[], disavow, note? }` | act | N2 |
| `GET /api/backlinks/recovery?siteId=` | read | N2 |
| `/api/rank/**` (существующие + `location`) | как было | N3 |
| `/api/local/profile`, `/api/local/nap`, `/api/local/citations`, `/api/local/schema`, `/api/local/gbp/**` | read / act | N4 |
| `GET /api/trends?siteId=` · `POST /api/trends/run` · `/api/trends/seeds` | read / act | N5 |
| `POST /api/seo/plagiarism/estimate` · `POST /api/seo/plagiarism` | act · **spend** | N6 |
| `POST /api/indexing/serp-check` `{ urls[], confirm }` | **spend** | N6 |
| `/api/reports/**` | read / act | N8 |
| `GET /api/reports/share/[token]` | публичный по токену | N8 |
| `GET /embed/audit?key=` (страница) | **публичный** | N9 |
| `POST /api/public/audit` · `POST /api/public/lead` | **публичный** | N9 |
| `/api/leads/**` | read / act | N9 |
| `GET /api/push/vapid` · `POST·DELETE /api/push/subscribe` · `POST /api/push/test` | read / act | N10 |
| `/api/ext/**` | Bearer `extToken` | N11 |

**`src/proxy.ts` (N0)** пропускает без сессии: `/embed/`, `/api/public/`, `/api/ext/`,
`/api/reports/share/`, `/share/report/`, `/manifest.webmanifest`, `/sw.js`, `/icons/`. Каждый такой маршрут сам
проверяет доступ (README §5). Для `/embed/**` N0 не ставит `X-Frame-Options: DENY` — проверь,
не ставит ли его `next.config.ts` глобально; если ставит, исключение для `/embed/` делает N0.

---

## 5. Шаблоны уведомлений (N0, `notifyI18n.ts`, все 7 языков)

| поле | en | ru |
|---|---|---|
| `toxicNewTitle: (site) => string` | ☣️ {site}: new toxic backlinks | ☣️ {site}: новые токсичные ссылки |
| `toxicNewMsg: (site, n, lines) => string` | *{site}* — {n} new toxic referring domain(s):\n{lines} | *{site}* — новых токсичных доноров: {n}\n{lines} |
| `gbpReviewTitle: (site, rating) => string` | ⭐ {site}: new {rating}★ review | ⭐ {site}: новый отзыв {rating}★ |
| `gbpReviewMsg: (site, author, rating, text) => string` | *{site}* — {author}, {rating}★:\n{text} | *{site}* — {author}, {rating}★:\n{text} |
| `localPackTitle: (site) => string` | 📍 {site}: map pack changes | 📍 {site}: изменения в local pack |
| `localPackMsg: (site, lines) => string` | *{site}*:\n{lines} | *{site}*:\n{lines} |
| `trendsTitle: (site) => string` | 📈 {site}: rising queries | 📈 {site}: растущие запросы |
| `trendsMsg: (site, lines) => string` | *{site}*:\n{lines} | *{site}*:\n{lines} |
| `digestTrends: string` | Rising queries | Растущие запросы |
| `leadNewTitle: (domain) => string` | 📥 New lead: {domain} | 📥 Новый лид: {domain} |
| `leadNewMsg: (domain, email, score, top) => string` | *{domain}* · {email}\nScore {score}/100\nTop issues: {top} | *{domain}* · {email}\nОценка {score}/100\nГлавные проблемы: {top} |
| `reportSentMsg: (title, to) => string` | 📄 Report “{title}” sent to {to}. | 📄 Отчёт «{title}» отправлен: {to}. |

Событие для каждого: `toxic*` → `alert`, `gbpReview*` и `localPack*` → `local`, `trends*` →
`trend`, `lead*` → `lead`, `reportSent*` → `digest`.

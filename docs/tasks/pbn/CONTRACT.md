# PBN restore + bulk link injector — CONTRACT

Единый источник правды для модуля. Замысел и обоснование — `claude/pbn-restore-plan.md`
(в проекте) и `Claude outputs/wayforge-injector-re/`. Навигация решена: отдельная страница
`/pbn`, группа меню `network` (уже в `DashboardShell.tsx`), пункт `/pbn` встаёт между `/drops`
и `/indexer`.

Правила репозитория, которые тут действуют (из AGENTS.md и заметок): редактируем только
`prisma/schema.prisma` (mysql-копия генерируется, миграции не пишем — деплой через `db push`);
JSON-поля = `String` с `// JSON:`; строки в составных ключах ≤191; тесты пишутся как
`node:test` + запуск `tsx --test`, файл дописывается в конец `test:unit`; i18n — 8 локалей,
`check:i18n` должен быть зелёным; страницы в обёртке `.main-content`; `prisma as any` требует
disable-строки no-explicit-any; новые файлы держим lint-чистыми.

## Готово и проверено (ядро, 26 тестов, tsc чистый)

`src/lib/pbn/` — чистая логика, без Prisma и сети:
- `anchors.ts` — `planAnchors(anchors, shares, count, seed): AnchorPlan`, `seedFromString`.
  Доли типов (exact|brand|url|generic) методом наибольшего остатка + детерминированное
  перемешивание. Заменяет `i % n` WayForge. Тип без анкоров квоты не получает; пустой список →
  пустой план (голый домен НЕ подставляем).
- `score.ts` — `scoreSnapshot(m): SnapshotScore`, `pickBestSnapshot(snaps)`. Вердикты:
  recommended | thin | brand_mismatch | parked_or_doorway | no_snapshot. Вес на контенте
  (текст 0.65, страницы 0.35), чужой бренд в `<title>` ловится по токенам (pets.com→PETsMART).
  Пустой ввод → `no_snapshot`, НЕ выдуманный снимок.
- `clean.ts` — `cleanHtml(html,{domain}): CleanResult`, `residualFootprints(html): string[]`.
  Раскрывает web.archive.org-обёртки (свои ассеты → относительный путь), режет трекеры,
  исходящие на чужие домены и `javascript:`-ссылки. `residualFootprints` — гейт экспорта:
  должен быть `[]` (ни archive.org, ни маркеров data-wf-*).
- `place.ts` — `findTextBlocks`, `choosePlacement(html,anchor): {needsParagraph, block?}`,
  `buildAnchorTag(url,text,rel)`, `injectIntoBlock(html,block,tag,surrounding?)`. Место под
  ссылку ищется по СОДЕРЖИМОМУ (p|td|div|li, текст ≥150) — табличная вёрстка тоже; нет блока →
  `needsParagraph`, НЕ дамп в начало body. Тег `<a>` без единого маркера/класса/стиля.

## Схема (готово в schema.prisma, нужен `prisma db push` на сервере)

`PbnSite` (userId+domain unique: snapshotTimestamp, status scanning|fetching|ready|partial|error,
pagesRequested/Restored, pagesFailed JSON, cleanedStats JSON, diskPath, assetDomain) →
`PbnPage` (siteId, path, title, textChars, blocks JSON, status ok|needs_paragraph|skipped) ·
`PbnCampaign` (userId, targetUrl, anchors JSON, shares JSON, scope, relShares JSON, siteIds JSON) ·
`PbnLink` (siteId, campaignId?, pagePath "/"|"*"|путь, anchorText, anchorKind, targetUrl, rel,
placement content|nav|footer, surroundingText?, status placed|skipped, skipReason?).

## Осталось построить (на это ядро;型-чек роутов/UI отсюда невозможен — Prisma-клиент не генерится)

### Стадия/движок — `src/lib/pbn/restore.ts` (по образцу `drops/toxicity/stage.ts`)
- `prescan(domain)`: `cdxGate` + `loadProxyPool` + `safeFetch` (зона web.archive.org,
  ARCHIVE_MIN_INTERVAL_MS) → метрики снимков → `pickBestSnapshot`. Бесплатно, net.
- `restore(site)`: выкачать ≤100 (по умолчанию, настраивается) страниц + ассеты выбранного
  снимка на диск `data/pbn/<userId>/<domain>/`, `cleanHtml` по каждой, `findTextBlocks` → PbnPage,
  отчёт pagesRequested/Restored/pagesFailed. Ретраи, прокси-лизинг, дедлайн как в tox-слайсе.
- `applyCampaign(campaign)`: `planAnchors` по сайтам → на каждый сайт `choosePlacement`; при
  `needsParagraph` — LLM-абзац под тему страницы (paid, `resolveAiCreds(userId,args,"dropsHistory")`
  или новый taskId; `assertConfirmed`); `injectIntoBlock`; записать PbnLink; переписать файл на
  диске из строк PbnLink (идемпотентно).

### Роуты — `src/app/api/pbn/` (зеркало MCP, `workspaceUserId("write")`, `schemaMissing`→503)
- `POST /api/pbn/prescan` `{domains[]}` → снимки со score (×4 воркера, net).
- `POST /api/pbn/restore` `{items:[{domain,snapshotTimestamp}]}` → фон, прогресс поллингом.
- `GET|PATCH /api/pbn/site/:id` — состояние; PATCH `{snapshotTimestamp}` пересобирает.
- `POST /api/pbn/campaign` `{targetUrl,anchors,shares,scope,relShares,siteIds,confirm}` → применить.
- `GET /api/pbn/site/:id/preview?path=&v=` — noindex-превью с инжектом.
- `GET /api/pbn/site/:id/zip` — ZIP: сайт + robots + файлы бот-щита; гейт `residualFootprints=[]`.

### MCP — `src/lib/mcp/toolsPbn.ts`, экспорт `PBN_TOOLS`, в `MCP_TOOLS` (tools.ts)
`pbn_prescan` (net) · `pbn_restore` (net) · `pbn_campaign_apply` (paid, confirm) ·
`pbn_site` (local) · `pbn_zip` (local). Схемы и cost по образцу `toolsDrops.ts`.

### UI — `src/app/pbn/page.tsx` (`.main-content`)
Текстарея доменов → таблица снимков со score/вердиктом → восстановление с прогрессом →
панель кампании (target, scope ×3, анкоры с долями по типам, relShares, кнопка AI-абзаца) →
«Применить к N сайтам» → таблица placed/skipped (с причиной). Per-site: iframe-превью с
кэш-бастером, список/правка ссылок, смена снимка, ZIP. Пункт `/pbn` добавить в `useNavItems()`
в группу `network` между drops и indexer (пометка уже стоит в коде). Флаг видимости — как у
Private Indexer (RESPONSIBLE-USE.md), по образцу `/aparser`.

### i18n
Ключи `pbn*` на 8 локалей (`src/locales/*.json`), одной задачей сразу все — как в волнах.

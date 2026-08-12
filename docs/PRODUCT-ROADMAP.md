# OpenGSC — продуктовый roadmap и план интеграции OSS-идей

> Статус документа: рабочий план, 12 августа 2026 года. Он описывает порядок работ и
> критерии готовности. Фактический прогресс итераций отмечен ниже.

## Текущий прогресс

На ветке `codex/roadmap-foundation` уже собран совместимый фундамент без изменения старых
URL и основных форматов API:

- синхронизация версии 1.3.0 и автоматические release/i18n checks;
- честный single-operator и SQLite support contract, скрытие макетного Team UI за флагом;
- локализованное acknowledgement рисков Private Indexer и единый responsible-use текст;
- безопасный outbound fetch с DNS/IP pinning, повторной проверкой redirects и лимитами;
- SQLite backup с `integrity_check` перед изменением схемы;
- lifecycle/heartbeat для audit и платных SEO jobs без автоматического повтора платного вызова;
- исполняемый registry из 30 правил только для встроенного Site Audit;
- Audit Verification: повторный обход и результаты `resolved`, `still present`, `regression`,
  `inconclusive` в UI, API и MCP.
- Outreach Workspace внутри Links: campaigns, prospect evidence, stage history, follow-up,
  draft/copy без отправки, связь с Backlink/alive-check и четыре локальных MCP action.
- Related Intent как второй режим существующей Cannibalization: inverted token/ranking-URL index,
  page roles, position/flip-flop evidence, confidence и только review-рекомендации.
- Content Operations как отдельный stateful workflow поверх, а не вместо Demand/Outline/Text/Rewrite:
  очередь и audit trail, импорт готового текста из History, approval/review, детерминированный
  preflight, зашифрованный fine-grained GitHub token, обязательный diff/confirm и PR без auto-merge.
- Краулер конкурентов вместо публичного чекера: тот же движок, но внутри консоли и по любому чужому
  домену — техническое состояние, платформа, инфраструктура, масштаб, плюс сопоставление отпечатков
  аналитики и рекламы между проверками для поиска сеток. Публичная страница удалена: приложение,
  вся суть которого в отсутствии публичных поверхностей, не должно иметь лендинг для лидогенерации.
- Sitemap Inventory внутри Indexing: рекурсивные sitemap/gzip/extensions, безопасная модель
  disappearance, diff, явная metadata verification и отдельный sitemap-seeded запуск Site Audit.
- Source Audit как отдельная read-only вкладка Content Operations: ограниченный GitHub snapshot,
  независимый registry Next.js/security/architecture правил, история и ссылки на строки без
  хранения исходников или изменения репозитория.

- SEO Production skill в `.agents/skills/seo-production/`: task card, demand evidence, outline-first,
  claim ledger, детерминированная проверка и передача пакета в Content Operations без публикации.
- Post-deploy outcome: проверка реального HTTP 200 после merge, связывание URL с Indexing и
  Rank Tracker, baseline за 28 дней и checkpoints 7/30/90 из собственных данных GSC с поправкой на
  задержку отчётности. Ни один платный сабмит и ни один merge не выполняются автоматически.
- `OPENGSC_ALLOW_PRIVATE_TARGETS`: явная форточка для аудита локального стейджинга. По умолчанию
  выключена, публичный Free SEO Checker игнорирует её всегда.
- Бэкап SQLite до `git reset --hard` в `update.sh` и защита локальных баз в `.gitignore`.

Остаётся отдельным этапом обновление внешнего сайта `opengsc.org` и первый корректный
Git tag/GitHub Release. Они не маскируются как готовые функции.

## 1. Цель

Следующий цикл развития OpenGSC должен не увеличивать количество разрозненных SEO-инструментов,
а замыкать уже имеющиеся данные и действия в проверяемые рабочие процессы:

1. нашли проблему или возможность;
2. показали доказательства и ожидаемый эффект;
3. пользователь одобрил действие;
4. OpenGSC помог выполнить работу;
5. результат перепроверен по crawl, GSC, индексации и позициям.

Главный продуктовый результат — переход от «панели с большим количеством данных» к системе,
которая ведёт SEO-задачу от обнаружения до доказанного результата. При этом сохраняются ключевые
свойства OpenGSC: self-hosted, SQLite-first, один Node-процесс, необязательные внешние API,
явная цена до платного запроса и отсутствие скрытых расходов.

## 2. Что уже есть и что нельзя дублировать

Новые функции должны встраиваться в существующие поверхности:

- повторная проверка исправлений — внутрь **Site → Audit**, а не в новый верхнеуровневый раздел;
- выбранные technical/crawlability checks — в существующий Site Audit rule engine. Самостоятельные
  **AI Visibility** и **SEO Tools → GEO** сохраняют свои данные, настройки, экраны и логику;
- outreach — продолжение **SEO Tools → Links / Link Monitor**;
- semantic intent conflicts — развитие существующей страницы **Cannibalization**;
- sitemap inventory — развитие **Site → Indexing**;
- content operations — оркестрация Demand, Outline, Text, Rewrite, Analysis, Indexing и Rank Tracker;
- writing workflow — agent skill поверх существующего MCP, а не ещё один генератор текста;
- public health check — отдельная публичная воронка, но на том же audit-ядре.

Если новая функция повторяет существующий экран или API, сначала расширяется текущая модель.
Новый раздел создаётся только когда у задачи свой жизненный цикл и состояние, а не потому, что
исходный OSS-проект показывал её отдельной страницей.

## 3. Обязательные продуктовые и технические правила

### 3.1 Единый UI и CSS

Все новые экраны обязаны выглядеть частью OpenGSC:

- использовать токены из `src/app/globals.css`: `var(--color-*)`, `var(--radius-*)`,
  `var(--shadow-*)`, `var(--page-*)`;
- переиспользовать `.card`, `.card-header`, `.panel`, `.pill`, `.tool-input`, `.metric-chip`
  и существующие композиции страниц;
- поддерживать dark/light theme, wide/compact layout и privacy blur;
- использовать `lucide-react`; не добавлять второй icon set;
- не добавлять Tailwind, MUI или отдельную design-system зависимость;
- не копировать CSS из исследованных проектов;
- при повторении одного UI-паттерна в двух и более новых модулях вынести небольшой общий
  компонент, например `StatusBadge`, `EmptyState`, `ConfirmModal` или `EvidenceTable`;
- проверять desktop, tablet и мобильную ширину от 360 px;
- сохранять клавиатурную навигацию, видимый focus, `aria-*` и понятные loading/empty/error states;
- в read-only share view скрывать все мутации, ключи, контакты и внутренние заметки.

Состояния не кодируются только цветом. У каждого verdict должны быть текст, иконка и при
необходимости короткое объяснение: `passed`, `warning`, `failed`, `unknown`, `not applicable`.

### 3.2 i18n

В приложении семь локалей: `en`, `ru`, `uk`, `fr`, `es`, `de`, `zh`. Множества ключей во всех
файлах полностью совпадают и проверяются автоматически. Это инвариант.

Для каждой пользовательской функции:

- все семь JSON-файлов меняются в одном PR;
- ключи остаются плоскими и получают префикс модуля;
- пользовательский текст не пишется литералом в JSX, кроме имён продуктов, протоколов и API;
- динамические значения подставляются тем же способом, что уже используется проектом;
- ошибки API возвращают стабильный code, а UI переводит code через `t()`;
- даты и числа форматируются активной локалью;
- названия SEO-сигналов можно оставлять как общепринятые термины, но объяснения переводятся;
- перед merge проверяется равенство key set всех семи локалей.

Рекомендуемые префиксы: `auditVerify*`, `auditRule*`, `outreach*`, `contentOps*`,
`sitemapInv*`, `kcIntent*`, `publicCheck*`, `jobRecovery*`.

### 3.3 Данные, стоимость и честность

- `null`, `unknown`, `not checked` и настоящий ноль не смешиваются.
- Любой платный запрос показывает provider, оценку цены, лимит и состояние cache **до** запуска.
- Платные MCP-действия требуют `confirm: true`.
- Рендер страницы не инициирует платный fetch.
- AI-рекомендация всегда отделена от детерминированного факта.
- Экспериментальные GEO-сигналы не снижают основной health score.
- Автоматическая публикация, редирект, canonical, outreach email и merge не выполняются без
  отдельного явного режима и понятного approval gate.

### 3.4 Лицензии и безопасность стороннего кода

- MIT-код можно адаптировать с сохранением copyright/license notice и записью в third-party notice.
- AGPL-проекты (`DispatchSEO`, `bisibility`) используются только как источник продуктовых идей;
  их код не переносится в MIT-кодовую базу.
- Проекты без лицензии используются только для понимания задачи и независимой реализации.
- Непрозрачные EXE/DLL/BAT/CMD-архивы из `guest-post-backlinks-tool` и `sitemap-harvester`
  не запускаются, не распаковываются в приложение и не поставляются пользователям.
- Любой переносимый алгоритм получает тесты на собственных fixtures OpenGSC.

## 4. Карта приоритетов

| Приоритет | Направление | Зачем | Что даст |
|---|---|---|---|
| P0 | Product truth и release hygiene | Публичные обещания должны совпадать с продуктом | Доверие, понятные версии, меньше ложных ожиданий |
| P0 | Безопасный outbound fetch | Audit и публичные проверки принимают внешние URL | Защита от SSRF, redirect abuse и слишком больших ответов |
| P0 | Единый контракт фоновых задач | Перезапуск процесса сейчас может оборвать работу | Меньше потерянных crawl/AI-задач и оплаченной впустую работы |
| P1 | Audit Verification | Сейчас аудит находит проблемы, но не доказывает исправление | Цикл found → fixed → verified, история и регрессии |
| P1 | Audit Rule Registry + новые checks | Проверки разбросаны и частично дублируются | Расширяемое ядро для UI, MCP и public checker |
| P1 | Outreach Workspace | Link Monitor заканчивается на списке prospects | Управляемая link-building воронка и измеримый результат |
| P1 | Related Intent Cannibalization | Текущий отчёт видит прежде всего одинаковый GSC query | Конфликты похожих интентов и более точный план консолидации |
| P2 | Sitemap Inventory | Сейчас sitemap используется в основном как список URL | Изменения, orphan pages, crawl seeds и контроль покрытия |
| P2 | Content Operations → PR | Инструменты создания и измерения не соединены | Полный цикл idea → PR → index → rank |
| P2 | Public Site Health Check | Сильный продукт пока виден только после установки | Публичная демонстрация и входящая воронка |
| P2 | SEO Production agent skill | Контентный pipeline мощный, но workflow агента фрагментирован | Повторяемое производство с fact/integrity gates |
| Done | Source Audit | Использует уже подключённые репозитории | Проверка кода до deployment без смешивания runtime-аудитов |
| Later | Team / multi-user | Это отдельная архитектура, а не UI-переключатель | Агентства и совместная работа, если спрос подтверждён |

## 5. Этап 0 — product truth, release hygiene и эксплуатационная база

Этот этап выполняется до крупных новых модулей. Он небольшой по объёму, но задаёт честный
контракт продукта и снижает риск строить новые workflow на неустойчивой основе.

### 5.1 Release hygiene

**Найдено**

- `package.json` содержит `1.3.0`;
- badges в `README.md` и `README.ru.md` показывают `1.2.3`;
- `CHANGELOG.md` уже содержит секцию `1.3.0`;
- на GitHub на 12 августа 2026 года нет Releases и тегов.

**Что сделать**

1. Сделать `package.json` единственным источником текущей версии.
2. Добавить проверку, что badges в обоих README и верхняя секция CHANGELOG совпадают с ним.
3. Ввести release checklist: version bump → changelog → build/test → tag `vX.Y.Z` → GitHub Release.
4. Автоматизировать создание release notes из соответствующей секции CHANGELOG.
5. Не ставить ретроактивный `v1.3.0` на текущий `main`, пока не найден точный commit релиза.
6. Следующий реальный выпуск оформить полностью и проверить Update Banner на tagged release.

**Что даст**

- пользователь понимает, какую версию установил;
- ссылки badges ведут не в пустую страницу;
- обновления можно обсуждать и откатывать по стабильным версиям, а не только по commit SHA;
- уменьшается расхождение README, UI, MCP и CHANGELOG.

**Готово, когда**

- CI падает на version drift;
- есть хотя бы один корректно оформленный tag и GitHub Release;
- README, Settings → System, MCP metadata и CHANGELOG показывают одну версию.

### 5.2 Публичный disclaimer и честное позиционирование

**Найдено**

README уже честно описывает reseller API и Private Indexer, но публичный
`opengsc.org/disclaimer/` остаётся общим: Google affiliation, API quota, безопасность и
отсутствие профессионального совета. На публичной странице нет явного описания doorway pages,
UA/DNS cloaking, риска penalties/deindexing, referral/reseller API и возможного нарушения
условий Ahrefs/Semrush.

**Что сделать**

1. Синхронизировать публичный disclaimer с разделом Disclaimer в README.
2. Отдельно описать, что Private Indexer необязателен и изолирован от остальных функций.
3. До первого включения Indexer показывать локализованное risk acknowledgement.
4. На reseller-карточках оставить явную маркировку referral и ссылку на официальный API.
5. Обновить disclaimer во всех языках публичного сайта и поставить фактическую дату изменения.
6. Добавить короткую ссылку «Risks and responsible use» рядом с Indexer, Googlebot View и
   reseller settings; не прятать её только в footer.

**Что даст**

- меньше юридических и репутационных рисков;
- пользователь не воспринимает опасный модуль как стандартную SEO-рекомендацию;
- публичный сайт и репозиторий говорят одно и то же.

**Готово, когда**

- публичная страница перечисляет оба специфических риска;
- все entry points на рискованные функции ведут к одному актуальному тексту;
- Indexer нельзя включить, не увидев предупреждение.

### 5.3 Честный database support contract

**Найдено**

Основная схема, installer, Docker, raw read-only MCP SQL и эксплуатационные инструкции
ориентированы на SQLite. MySQL/MariaDB имеют отдельный экспериментальный verification guide,
но остаются несовместимости в raw SQL, upsert semantics, timestamp coercion и MCP SQL.

**Решение**

- официально обозначить SQLite единственным fully supported production path;
- MySQL/MariaDB назвать experimental/unsupported и не обещать feature parity;
- не усложнять новые модули dual-dialect ветками без подтверждённого пользовательского спроса;
- вынести будущую поддержку MySQL в отдельный RFC: adapter boundary, migrations, locking,
  read-only SQL и полный CI matrix.

**Что даст**

- понятная установка и поддержка;
- новые функции не задерживаются из-за мнимой совместимости;
- пользователи MySQL заранее знают ограничения.

**Готово, когда**

- README, Docker docs, installer и testing guide используют одинаковые формулировки;
- каждая экспериментальная инструкция имеет предупреждение и список неработающих функций.

### 5.4 Single-operator truth и незавершённые Team/Super Sites экраны

**Найдено**

Архитектура рассчитана на одного владельца экземпляра с несколькими подключёнными Google
аккаунтами. Моделей `Organization`, `Member`, `Role` и серверного team authorization нет.
Team name, sharing toggle, members count и Super Sites в Settings в основном живут в локальном
React state и создают впечатление готовой функции.

**Что сделать сейчас**

1. Скрыть незавершённые Team/Members/Super Sites пункты из production navigation или поместить
   их за явный experimental flag.
2. Удалить обещания sharing/billing/5-year unlock из доступного UI, пока за ними нет сервера.
3. В README и Settings обозначить модель «one operator, multiple Google accounts».
4. Не смешивать portfolio tags с понятием team/workspace.

**Что не делать сейчас**

Не достраивать multi-user попутно с Outreach или Content Ops. Настоящая team model потребует
RFC по ownership всех существующих строк, приглашениям, ролям, audit log, secrets, share links,
MCP tokens и миграции текущего `userId`-scoping.

**Что даст**

- интерфейс не обещает несуществующую функцию;
- меньше тупиковых экранов и вопросов поддержки;
- будущая team model проектируется целиком, а не как набор клиентских переключателей.

### 5.5 Общий безопасный outbound fetch

Идея основана на MIT-подходах LLMScout, EchoSEO и site-health-check, но реализуется как общий
OpenGSC-модуль.

**Что сделать**

Создать один server-only fetch boundary и постепенно перевести на него audit, public checker,
page optimization fetch и другие URL, которые задаёт пользователь:

- разрешать только `http:` и `https:`;
- блокировать loopback, private, link-local, multicast и cloud metadata ranges;
- резолвить DNS и повторять проверку на каждом redirect;
- ограничить redirect chain, timeout и максимальный response body;
- проверять content type до чтения body;
- ограничить concurrency и использовать явный User-Agent;
- возвращать структурированные причины: blocked target, timeout, too large, invalid content,
  HTTP error;
- не превращать blocked/unknown в SEO fail.

**Что даст**

- защита self-hosted экземпляра от SSRF;
- одинаковое сетевое поведение всех audit-инструментов;
- меньше зависаний и memory spikes на патологических страницах.

**Готово, когда**

- есть тесты на IPv4/IPv6 private ranges, DNS rebinding-shaped redirects, redirect loops,
  oversized body и timeout;
- ни один публичный URL endpoint не использует голый `fetch(userUrl)`.

### 5.6 Устойчивый контракт фоновых задач

**Найдено**

Fire-and-forget и in-process schedulers сохраняют простую эксплуатацию, но работа в полёте
теряется при PM2 restart/deploy. Stale sweep корректно завершает phantom jobs, а MCP rewrite
уже сохраняет каждую страницу отдельно и использует heartbeat. Этот удачный паттерн нужно
распространить, не добавляя Redis/Temporal только ради моды.

**Что сделать**

1. Определить общий job contract: `status`, `stage`, `progress`, `attempt`, `heartbeatAt`,
   `checkpoint`, `lastError`, `idempotencyKey`, `startedAt`, `finishedAt`.
2. Вынести heartbeat и stale/recovery policy в общий server-only helper.
3. На boot находить interrupted jobs и классифицировать их как:
   - безопасно продолжить с checkpoint;
   - можно повторить только после подтверждения;
   - нельзя продолжить, но частичный результат сохранён.
4. Не повторять оплаченный LLM/provider call автоматически, если неизвестно, завершился ли он.
5. Для Site Audit сохранять crawl frontier/visited pages пакетами или хотя бы позволять
   «Retry from last completed snapshot».
6. Для content generation сохранять результаты между дорогими стадиями MAP/REDUCE/write.
7. Для GSC sync хранить состояние в БД, а не только в module variable.
8. В UI показывать `interrupted`, `recoverable`, `retry required`, а не общий `error`.

**Что даст**

- deploy не уничтожает длительную работу;
- пользователь видит сохранённый прогресс;
- меньше повторных платных запросов;
- новые Content Ops и audit verification получают надёжную основу.

**Готово, когда**

- integration test останавливает worker между стадиями и подтверждает recovery;
- повторный POST с тем же idempotency key не создаёт вторую платную задачу;
- restart semantics документированы в `docs/ARCHITECTURE.md`.

## 6. Этап 1 — Audit Verification и реестр правил Site Audit

### 6.1 Audit Rule Registry

**Источники идей:** LLMScout, EchoSEO, svelte-vitals. Используется только совместимый MIT-код
или независимая реализация.

**Что сделать**

Ввести стабильный формат правила:

```ts
type AuditRule = {
  id: string;
  category: "technical" | "content" | "performance" | "security" | "crawlability";
  severity: "critical" | "high" | "medium" | "low" | "info";
  evaluate(input: AuditFacts): AuditFinding[];
};
```

Каждый finding несёт `ruleId`, URL, verdict, evidence, impact, fix, source и confidence.
Rule engine не должен зависеть от React, Prisma или конкретного reporter.

Это реестр только встроенного **Site Audit**. Он не читает и не заменяет состояние
**AI Visibility** или **SEO Tools → GEO**: у этих инструментов остаются самостоятельные модели,
настройки, API и UI. Похожие сигналы могут иметь общую идею, но выполняются и объясняются в
контексте своего инструмента.

Добавить в существующий набор по приоритету:

1. JSON-LD parse validity и required properties;
2. Organization/Person schema + `sameAs`;
3. Open Graph и Twitter Card completeness;
4. redirect chain;
5. security headers и mixed content;
6. image weight;
7. robots snippet directives;
8. полный AI-crawler report с различием training/search bots;
9. informational: llms.txt, Speakable, Markdown negotiation, RFC 8288 Link header.

**Что даст**

- один источник истины для dashboard, MCP, Markdown export и public checker;
- проще добавлять правила и тестировать false positives;
- стабильные `ruleId` позволяют сравнивать audit snapshots.

### 6.2 Re-crawl to verify

**Источник идеи:** EchoSEO.

**Пользовательский сценарий**

На завершённом аудите пользователь нажимает **Re-crawl to verify**. Новый audit знает baseline
и после завершения показывает:

- `resolved` — проблема исчезла и соответствующий URL/источник данных реально перепроверен;
- `still present` — та же проблема осталась;
- `regression` — появилась новая проблема;
- `inconclusive` — проблема не найдена, но URL не удалось перепроверить;
- page changes — status, title, description, canonical, noindex, H1, content size.

**Ключевое правило честности**

Отсутствие issue в новом crawl не означает исправление. Для crawl-based rule URL должен быть
успешно получен; для PSI/performance rule должна существовать новая завершённая measurement.

**UI**

- comparison bar внутри `SiteAuditPanel`;
- baseline selector среди предыдущих завершённых audit;
- summary cards и фильтры по verdict/severity/rule;
- раскрываемая evidence table;
- read-only comparison доступен через существующий share token;
- кнопки действий скрыты в guest view.

**Что даст**

- доказательство результата работы, а не только повторный score;
- видимость регрессий после deployment;
- основа для агентного workflow «исправь и перепроверь».

**Готово, когда**

- baseline всегда старше current и относится к тому же site;
- невозможно получить false resolved из-за timeout/неполного crawl;
- comparison работает на старых audits без новых полей в режиме graceful degradation;
- MCP `get_audit_comparison` возвращает те же counts и evidence, что UI.

## 7. Этап 2 — рабочие процессы роста

### 7.1 Outreach Workspace

**Источник идеи:** задача из guest-post-backlinks-tool и более зрелые product patterns из
DispatchSEO. Сторонний код не используется.

**Почему это нужно**

Link Monitor и `link-prospecting` skill уже находят multi-linker domains, но OpenGSC теряет
prospect после выдачи списка. Нет памяти о контакте, follow-up и полученной ссылке.

**Что сделать**

Добавить серверную модель prospect/campaign:

- domain, source mention и связанный competitor;
- DR/evidence snapshot на момент добавления;
- contact name, email/contact URL и источник контакта;
- pitch angle, target asset и внутренние заметки;
- stage: discovered, qualified, ready, contacted, replied, negotiating, won, lost;
- last contact, next follow-up, owner note;
- полученный backlink и alive status;
- audit trail смены стадий.

MVP не отправляет email. Он создаёт workspace, шаблоны, copy action, reminders и link verification.
Email-интеграция рассматривается позже с rate limits, consent, unsubscribe и защитой от спама.

**UI**

- новый режим внутри Links: Mentions / Prospects / Campaigns;
- существующие cards, pills, filters и table density;
- Kanban допустим только как альтернативное представление, не как отдельный CSS-мир;
- email и заметки скрыты в share view и privacy mode.

**Что даст**

- link prospecting становится измеримым процессом;
- видны conversion rate и реально выигранные ссылки;
- агент может готовить персонализированные pitch на основе сохранённого evidence.

**Готово, когда**

- mention можно сохранить в prospect без повторного paid fetch;
- stage/follow-up переживают restart и доступны MCP;
- won prospect связывается с Backlink и проверкой alive;
- ни одно действие не рассылает сообщения автоматически.

### 7.2 Related Intent Cannibalization

**Источник идеи:** SEO Keyword Cannibalization & Intent Overlap Detector. Его простой
Jaccard/bigram алгоритм рассматривается как прототип задачи, не как готовая semantic model.

**Статус:** реализовано как аддитивный режим существующего отчёта. Exact-query остаётся режимом
по умолчанию и сохраняет старый API shape. Related Intent строит кандидатов через inverted index
по query tokens и наблюдаемым ranking URLs из GSC; live SERP/LLM не вызываются скрыто. Он показывает
page role, query/URL overlap, position gap, дневные flip-flops, confidence и варианты только для
ручной проверки. Для CJK используются детерминированные character bigrams.

**Что сделать**

Добавить второй слой к текущему exact-query report:

1. нормализовать и кластеризовать похожие GSC queries;
2. построить кандидатов через inverted token index, а не полный O(n²) по всему portfolio;
3. учитывать SERP overlap, ranking URL, position distance и flip-flops по датам;
4. сравнивать title/H1/content facts страниц;
5. показывать business-role conflict: guide vs product vs category vs landing;
6. выдавать варианты `merge`, `differentiate`, `canonical review`, `internal linking`, но не
   выполнять их автоматически;
7. объяснять confidence и evidence каждого вывода.

Clicks/impressions помогают выбрать более сильную страницу, но не дают права автоматически
назначать canonical: conversion purpose, backlinks и интент могут быть важнее трафика.

**Что даст**

- находятся конфликты разных формулировок одного интента;
- меньше ошибочных рекомендаций «объединить всё»;
- существующий cannibalization report становится заметно сильнее простого GSC grouping.

### 7.3 Sitemap Inventory

**Источник идеи:** продуктовая задача sitemap-harvester; его бинарный архив не используется.

> Реализовано как совместимое расширение вкладки Indexing: старые indexing-поля и JSON-ответы
> сохранены, добавлены metadata/diff/coverage, gzip и sitemap extensions. Исчезновение требует двух
> полных успешных sync; partial/error не дают отрицательного evidence. Site Audit получает только
> явный `seedFromSitemap` и собственный orphan finding — его модели, registry и UI не объединяются
> с Indexing, AI Visibility или SEO Tools → GEO.

**Что сделать**

- сохранять `lastmod`, source sitemap, sitemap type, firstSeen, lastSeen и content metadata;
- поддерживать sitemap index, image/video/news extensions и gzip;
- показывать added, changed, disappeared и invalid URLs между sync;
- не считать disappearance удалением до повторной успешной sitemap sync;
- давать Site Audit возможность стартовать от sitemap URLs, чтобы находить orphan pages;
- связывать inventory с Google inspection status и Site Audit coverage;
- отдельно отмечать ненадёжный `lastmod`, который меняется без наблюдаемого page change.

**Что даст**

- контроль фактического URL inventory;
- обнаружение orphan, missing и accidentally removed pages;
- audit покрывает больше, чем внутренний BFS от homepage.

## 8. Этап 3 — Content Operations и публикация через PR

**Источник идеи:** DispatchSEO. Из-за AGPL переносится только продуктовая концепция;
реализация создаётся независимо на существующих примитивах OpenGSC.

> Реализован безопасный MVP: самостоятельная очередь в SEO Tools, импорт готового текста из
> `SeoHistory`, закрытые переходы состояний, audit timeline, server-only AES-GCM storage токена,
> проверка repository/base branch, bounded diff и повторный preflight непосредственно перед
> явным созданием branch/commit/PR. Auto-merge отсутствует; merge и факт deployment не смешиваются.
> Автоматическая HTTP-проверка deployment, indexing/rank handoff и отчёт 7/30/90 остаются следующим
> совместимым расширением этой модели.

### 8.1 MVP workflow

1. Demand/agent создаёт Content Idea с keyword, intent, evidence, target site и ожидаемым эффектом.
2. Пользователь approve/reject/reorder.
3. Одобренная идея запускает существующий Outline/Text/Rewrite pipeline.
4. Deterministic gates проверяют fact drift, keyword coverage, heading drift и sameness.
5. GitHub integration создаёт branch и PR, но не push в main.
6. Пользователь вручную merge через GitHub.
7. OpenGSC ждёт реальный HTTP 200 после deployment.
8. URL отправляется в indexing workflow и keyword — в Rank Tracker.
9. Через 7/30/90 дней карточка показывает GSC/rank outcome относительно baseline.

### 8.2 Безопасность публикации

- начать с GitHub App или fine-grained token с минимальными permissions;
- секреты не попадают в prompt, branch, logs или MCP result;
- код из PR не запускается в job с write/merge credentials;
- zero checks не считается green;
- auto-merge и unattended builder не входят в MVP;
- для WordPress/других CMS позже добавляются publishing adapters, а не обходной прямой POST.

### 8.3 UI

Content Ops получает собственную поверхность только после MVP, потому что имеет состояние и
жизненный цикл. До этого queue можно встроить в SEO Tools History. Карточка идеи показывает:

- why now и source evidence;
- стоимость генерации до запуска;
- approval state и current stage;
- PR/deploy/index/rank status;
- последние ошибки и безопасный retry.

**Что даст**

- соединит уже написанные модули в уникальный end-to-end продукт;
- уменьшит ручное копирование текста между OpenGSC, редактором и GitHub;
- позволит измерять не количество сгенерированных статей, а опубликованный и ранжируемый результат.

**Готово, когда**

- ни одна идея не публикуется без approval;
- PR всегда содержит evidence/target keyword/validation result;
- после merge URL автоматически связывается с indexing и rank tracking;
- interrupted build восстанавливается по общему job contract;
- audit log объясняет каждую смену состояния.

## 9. Этап 4 — публичный Site Health Check

**Источники идей:** site-health-check, EchoSEO и базовый сценарий seo-audit-backend.

> Реализован Public Lite без регистрации и постоянного хранения: публичен только отдельный route,
> он не видит GSC/сайты/API-ключи оператора. Результат домена живёт в memory cache 15 минут,
> rate-limit хранит только salted hash соединения 10 минут, Turnstile включается парой env keys.
> Персональные report URLs и email не создаются; Expert report остаётся отдельным будущим opt-in.

### 9.1 Цель

Показать ценность OpenGSC до установки: пользователь вводит домен, получает ограниченный
внешний аудит и видит, что полный продукт умеет хранить историю, данные GSC и verification.

### 9.2 Состав

Public Lite, без регистрации:

- HTTPS/certificate;
- indexability;
- title/description/H1;
- canonical;
- basic schema/OG;
- security headers;
- несколько performance facts;
- короткие «последствие + действие».

Expert report после явного consent/email, если этот канал нужен маркетингу:

- расширенные facts и evidence;
- crawl нескольких страниц с жёстким лимитом;
- shareable snapshot;
- CTA установить OpenGSC и подключить GSC для исторических данных.

### 9.3 Ограничения

- только общий safe fetch boundary;
- Turnstile/rate limiting/cache;
- noindex для персональных report URLs или корректная access policy;
- минимальный сбор данных и documented retention;
- отсутствие ключа PageSpeed даёт `unavailable`, а не fail;
- public report не раскрывает потенциально опасные details вроде exposed usernames без gating;
- никакого платного запроса без явного согласия и лимита.

**Что даст**

- работающий product demo на `opengsc.org`;
- органическую и referral-воронку;
- повторное использование audit engine вместо отдельного маркетингового прототипа.

## 10. SEO Production agent skill

**Источник идеи:** Awesome SEO Writing Skill (MIT). Подход seo-blog-writer-claude к выдуманному
личному опыту и bypass AI detectors не используется.

Добавить `.agents/skills/seo-content-production/` поверх существующих MCP tools:

1. task card: reader, intent, primary/supporting keywords, constraints;
2. outline-first;
3. claim ledger и primary-source verification;
4. draft через существующий content pipeline;
5. deterministic audit;
6. rewrite high-priority findings;
7. humanization без выдуманных историй, тестов и опыта;
8. integrity recheck изменённых facts, numbers, links и keywords;
9. content package: article, metadata, audit note, image suggestions.

**Что даст**

- повторяемый процесс для Codex/Claude/Cursor;
- меньше галлюцинаций и механического «AI-текста»;
- skill использует факты и инструменты OpenGSC, а не дублирует их prompt-ом.

## 11. Отдельный Source Audit и то, что остаётся отложенным

### Source Audit — реализован независимо

После GitHub integration добавлена отдельная вкладка **Source Audit** внутри Content Operations.
От svelte-vitals взята только продуктовая идея registry/reporters: его SvelteKit rules и исходный
код не переносились. Правила реализованы независимо под установленный Next.js 16 и проверены по
локальной документации этой версии.

Текущий контракт:

- пользователь явно выбирает подключённый репозиторий и ветку;
- GitHub tree/blob API читает максимум 80 подходящих файлов, 256 КБ на файл и 4 МБ суммарно;
- проверка выполняется только в памяти, а БД хранит commit SHA, счётчики и bounded findings;
- имена подозрительных env-переменных допустимы в evidence, но значения секретов и исходники нет;
- результат помечается неполным при GitHub tree truncation, слишком больших файлах или лимите;
- проверка только читает GitHub и никогда не создаёт commit/PR, не исправляет код автоматически;
- heartbeat позволяет честно пометить зависший запуск как interrupted после restart.

Registry содержит консервативные SEO/performance/correctness/security/architecture checks:
Metadata API, sitemap/robots conventions, raw images и alt, `next/font`, public secret-like env
names, server env in Client Components, безопасная JSON-LD serialization, raw HTML review,
user-derived raw fetch, wildcard remote images, page/route conflicts и очень крупные Client
Components. Findings ведут в конкретный GitHub-файл/строку и предлагают ручное исправление.

Это не новый runtime-аудит сайта. **Site Audit**, **AI Visibility** и **SEO Tools → GEO** сохраняют
собственные модели, настройки, API, экраны и правила; ни один их отчёт не читается и не
перезаписывается Source Audit. SARIF, framework adapters кроме Next.js и автоматический audit PR
остаются будущими расширениями после подтверждения спроса.

### bisibility как отдельный сервис

Не подключать PostgreSQL + Valkey + Temporal ради функций, которые OpenGSC уже имеет. Изучать
как reference для provider adapters, SERP snapshots, cost ledger, webhooks, team roles и deploy
timeline. Код AGPL не переносить.

### Полноценный multi-user

Не входит в этот roadmap. Если появится подтверждённый спрос агентств, сначала отдельный RFC и
миграционный план. До этого интерфейс остаётся честно single-operator.

### Автоматический outreach и auto-merge

Оба действия имеют внешний эффект и высокий репутационный риск. Они возможны только после
стабильного ручного workflow, audit log, limits и отдельного opt-in.

## 12. Рекомендуемый порядок поставки

### Milestone A — Truth & Safety

1. Release hygiene.
2. Публичный disclaimer и risk acknowledgement.
3. SQLite/MySQL support wording.
4. Скрытие незавершённых Team/Super Sites UI.
5. Safe outbound fetch.
6. Общий job contract и recovery policy.

Результат: продукт честно описан, безопаснее принимает URL и лучше переживает restart.

### Milestone B — Verified Audit

1. Audit Rule Registry.
2. Перенос существующих issue codes в registry без изменения UX.
3. Новые high-confidence checks.
4. Baseline snapshots и comparison service.
5. Re-crawl to verify UI + MCP.

Результат: OpenGSC не только находит проблему, но доказывает исправление и показывает регрессии.

### Milestone C — Growth Workspace

1. Outreach models/API.
2. Links UI и MCP actions.
3. Related Intent Cannibalization.
4. Sitemap Inventory и sitemap-seeded audit.
5. SEO Production skill.

Результат: найденные возможности превращаются в сохранённые и измеримые задачи.

### Milestone D — Content Operations MVP

1. Content Idea queue и approvals.
2. GitHub connection.
3. PR creation и deterministic gates.
4. Post-merge deployment detection.
5. Indexing + Rank Tracker handoff.
6. Outcome reporting 7/30/90.

Результат: уникальный closed-loop workflow от спроса до опубликованной и измеренной страницы.

### Milestone E — Public Funnel

1. Public Lite checker.
2. Rate limiting, Turnstile, cache, retention.
3. Expert/share report.
4. Marketing CTA и conversion measurement.

Результат: публичный сайт демонстрирует продукт на реальном домене пользователя.

## 13. Definition of Done для каждой новой функции

Функция не считается законченной, пока не выполнено всё применимое:

- есть пользовательская проблема, expected outcome и non-goals;
- используется существующая страница/компонент, если новый раздел не обоснован;
- UI использует общие CSS tokens/classes и работает в dark/light;
- mobile, empty, loading, partial, error, unknown и read-only states проверены;
- добавлены ключи во все семь локалей, key sets совпадают;
- API авторизован и scoped к владельцу/site/project;
- внешние URL проходят safe fetch;
- paid/quota/net действия помечены и не запускаются при render;
- длительная работа использует общий job contract и idempotency;
- deterministic logic покрыта unit tests, workflow — integration test;
- MCP и UI используют одну business logic, если функция доступна обоим;
- документация и disclaimer обновлены;
- миграция работает на основной SQLite-конфигурации и имеет rollback/backup note;
- лицензия и attribution проверены;
- `npm run build` проходит на чистой базе зависимостей.

## 14. Метрики результата

Нельзя оценивать roadmap только количеством новых страниц. Нужны продуктовые показатели:

- Audit: доля повторно проверенных findings; resolved/still present/regression/inconclusive;
- Reliability: interrupted jobs, recovered jobs, повторные paid calls, stale failures;
- Outreach: qualified → contacted → replied → won и живые backlinks;
- Cannibalization: рассмотренные conflicts и выбранное действие, без автоматических редиректов;
- Sitemap: discovered/orphan/disappeared URLs и audit coverage;
- Content Ops: idea → approved → PR → live → indexed → ranking, время между стадиями;
- Public Checker: completed scans, report opens и install/docs conversions при минимальном PII;
- Release: version drift failures, оформленные releases и успешные upgrade paths.

Метрики хранятся локально по умолчанию. Отправка продуктовой телеметрии наружу не добавляется
неявно и требует отдельного решения по privacy.

## 15. Решение по исходным OSS-проектам

| Проект | Решение |
|---|---|
| EchoSEO | Взять MIT-подход audit verification, snapshots и public checker; адаптировать к Prisma/SQLite |
| LLMScout | Взять недостающие MIT-checks и идеи hardened fetch; не подключать отдельный CLI |
| site-health-check | Взять public/expert packaging, `na` semantics и понятные action texts |
| Awesome SEO Writing Skill | Адаптировать workflow в OpenGSC agent skill с attribution |
| DispatchSEO | Независимо реализовать queue/approval/PR/outcome; AGPL-код не копировать |
| bisibility | Только архитектурный reference; не добавлять второй backend stack |
| svelte-vitals | Взята только идея rule/reporter architecture; Source Audit реализован независимо под Next.js, Svelte rules/код не переносились |
| Cannibalization Detector | Взять идею related-query conflicts; простой lexical O(n²) не переносить как production engine |
| guest-post-backlinks-tool | Только идея outreach workspace; код/архив не использовать |
| sitemap-harvester | Только идея sitemap inventory; бинарный архив не использовать |
| seo-audit-backend | Не интегрировать; сценарий покрывается public checker на общем audit engine |
| seo-blog-writer-claude | Не использовать anti-detector и fabricated-experience подход |

## 16. Открытые решения перед реализацией

1. Является ли public checker приоритетом привлечения или сначала нужен installed-product value?
2. Какой первый publishing target: GitHub-only или сразу adapter contract для CMS?
3. Нужно ли хранить audit screenshots, учитывая размер SQLite/backup, или начать с HTML evidence?
4. Как долго хранить crawl snapshots и public reports?
5. Какие background jobs безопасно автоматически resume, а какие всегда требуют подтверждения?
6. Следующий release после Milestone A — patch `1.3.x` или feature release `1.4.0`?

Решение по Outreach принято: MVP включает reminders и локализованный draft/copy, но никогда не
отправляет сообщение автоматически. Первый publishing target для Content Operations — GitHub PR;
CMS adapters остаются следующим расширением, а не частью первого контура.

До ответа на эти вопросы можно реализовывать Milestone A и Audit Rule Registry: они полезны при
любом выборе дальнейшего продуктового направления.

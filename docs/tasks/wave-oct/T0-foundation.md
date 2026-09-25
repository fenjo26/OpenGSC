# T0 — Фундамент

**Ветка:** работаешь прямо в `feat/wave-oct` (worktree `.worktrees/wave-t0`).
**Идёшь первым и один.** T1…T7 ответвляются от твоего коммита. Всё, что ниже, должно оказаться
в `feat/wave-oct` до того, как стартуют остальные.

Прочитай `README.md` и `CONTRACT.md` целиком. Ты единственный, кто меняет схему, локали,
`notifyI18n.ts`, `package.json`, `instrumentation.ts` и три точки в `src/app/site/[id]/page.tsx`.
Ошибёшься в имени — ошибутся все семь задач, поэтому копируй из контракта буквально.

Перед началом прогони полный `npx tsc -p tsconfig.json --noEmit` и `npx eslint` по файлам,
которые будешь менять (`DashboardShell` не трогаешь, а `page.tsx`, `settings/page.tsx`,
`tools.ts` и `notify.ts` трогаешь). Сохрани числа ошибок как базу.

## 1. Схема
Внеси всё из `CONTRACT.md` §1 в `prisma/schema.prisma`: новые поля в `Site`, `User`,
`SitemapUrl`, индекс `SitemapUrl`, семь новых моделей в конец файла.
Проверка: `npx prisma validate && npx prisma generate`. Миграцию не пиши.

## 2. Файлы типов (дословно из §2)
- `src/lib/seo/metaLimits.ts`
- `src/lib/uptime/types.ts`
- `src/lib/notify/types.ts`
- `src/lib/indexing/types.ts`
- `src/lib/mentions/types.ts`
- `src/lib/visibility/types.ts`

Тесты `types.test.ts` (`node:test` + `node:assert/strict`, как в `src/lib/serpmon/types.test.ts`):
- `uptime`: `UPTIME_INTERVALS` строго по возрастанию; `DEFAULT_UPTIME_SETTINGS.defaultIntervalMin`
  входит в `UPTIME_INTERVALS`; `0 < UPTIME_OFFLINE_RATIO ≤ 1`.
- `notify`: в `NOTIFY_EVENTS` нет `"test"` и нет дублей.
- `indexing`: `DEFAULT_INDEX_INSPECT.dailyBudget < INSPECTION_DAILY_LIMIT`;
  `INSPECTION_PER_MINUTE ≤ 600`; `INSPECTION_TZ === "America/Los_Angeles"`.
- `mentions`: `DEFAULT_MENTION_SOURCES` без дублей.
- `visibility`: тип-only — один тест, что модуль импортируется.
- Для `metaLimits` отдельный файл не нужен: проверь в `src/lib/seo/metaFit.test.ts`
  (заглушка T1 — одной строкой), что у обоих полей `auditMin ≤ targetMin ≤ targetMax ≤ auditMax`
  и что `metaLength("Ελληνικά") === 8`. T1 перепишет файл, но эти две проверки обязан сохранить.

## 3. Заглушки модулей
Каждый файл из `CONTRACT.md` §3 — с точными экспортами. Тела —
`throw new Error("wave: <fn> not implemented (Tn)")`. **Не бросают** (пустые функции):
`startUptimeScheduler`, `kickUptimeScheduler`, `startIndexScheduler`, `kickIndexScheduler`,
`startMentionsScheduler`, `kickMentionsScheduler`: их вызывает `instrumentation.ts` при старте.

| Файл(ы) | Для кого |
|---|---|
| `src/lib/seo/metaFit.ts`, `src/app/api/seo/meta-fit/route.ts` (POST → `501 { error: "not_implemented" }`) | T1 |
| `src/lib/uptime/{check,state,store,scheduler}.ts` | T2 |
| `src/lib/notify/{format,channels}.ts` | T3 |
| `src/lib/indexing/{queue,quota,inspect,status,scheduler}.ts` | T4 |
| `src/lib/audit/{hreflang,queryAlign,psi}.ts` (`export {}` + комментарий «T5») | T5 |
| `src/lib/mentions/{parse,sources,store,scheduler}.ts` | T6 |
| `src/lib/visibility/{sov,store}.ts` | T7 |
| `src/lib/mcp/{toolsMeta,toolsUptime,toolsIndex,toolsMentions,toolsVisibility}.ts` — `export const X_TOOLS: McpTool[] = [];` | T1, T2, T4, T6, T7 |

### Компоненты-заглушки
Клиентские, `"use client"`, default export. Показывают `card` с заголовком из §7 и строкой
«…» — ничего больше:

| Файл | Пропсы | Заголовок | Для кого |
|---|---|---|---|
| `src/components/uptime/UptimePanel.tsx` | `{ siteDbId: string }` | `uptimeTitle` | T2 |
| `src/components/uptime/UptimeSettingsCard.tsx` | — | `uptimeSettingsTitle` | T2 |
| `src/components/uptime/UptimeDot.tsx` | `{ badge: UptimeBadge \| null; size?: number }` — рендерит `null` | — | T2 |
| `src/components/NotifyChannelsCard.tsx` | — | `notifyChTitle` | T3 |
| `src/components/IndexAutoPanel.tsx` | `{ siteDbId: string; domain: string }` | `idxAutoTitle` | T4 |
| `src/components/visibility/MentionsPanel.tsx` | `{ siteDbId: string; domain: string }` | `mentionsTitle` | T6 |
| `src/components/visibility/AiShareOfVoice.tsx` | `{ siteDbId: string; domain: string }` | `aiSovTitle` | T7 |
| `src/components/visibility/CitedDomains.tsx` | `{ siteDbId: string; domain: string }` | `aiCitedTitle` | T7 |

## 4. Хаб «Видимость» — `src/components/VisibilityHub.tsx` (твой файл до конца волны)
```tsx
export default function VisibilityHub({ siteDbId, domain }: { siteDbId: string; domain: string })
```
- Строка подвкладок (стиль как у вкладок сайта, `.pill`-кнопки) в порядке:
  `ai` → `visTabAi`, `sov` → `visTabSov`, `mentions` → `visTabMentions`, `llm` → `visTabLlm`.
- Под строкой — `visHubHint` мелким текстом.
- Содержимое:
  - `ai` → `<AeoTracker siteDbId domain />`;
  - `sov` → `<AiShareOfVoice …/>`, под ним `<CitedDomains …/>`;
  - `mentions` → `<MentionsPanel …/>`;
  - `llm` → `<BrandVisibility siteDbId />`.
- Активная подвкладка хранится в URL-параметре `vis` (`?tab=aeo&vis=sov`), чтобы на неё можно
  было дать ссылку. Читай и пиши так же, как `page.tsx` работает с `tab`: смотри
  `src/lib/urlParam.ts`. Неизвестное значение → `ai`.
- В read-only share view (как там определяется гость — смотри `page.tsx`, `GUEST_TABS`) хаб
  показывает только `ai` и `sov`.

## 5. Три вставки в `src/app/site/[id]/page.tsx`
Только эти три правки и импорты к ним. Больше ничего в этом файле не меняй.
1. `{activeTab === "aeo" && <AeoTracker … />}` → `{activeTab === "aeo" && <VisibilityHub siteDbId={siteDbId} domain={domain} />}`.
   Импорт `AeoTracker` из этого файла убери, если он больше нигде в нём не используется.
2. В начале JSX, который возвращает функция `IndexingTab`, первым дочерним элементом:
   `<IndexAutoPanel siteDbId={siteDbId} domain={domain} />`. Если внутри `IndexingTab` эти
   значения называются иначе, возьми их локальные имена.
3. `{activeTab === "health" && <SiteHealthPanel siteDbId={siteDbId} />}` →
   `{activeTab === "health" && <><UptimePanel siteDbId={siteDbId} /><SiteHealthPanel siteDbId={siteDbId} /></>}`.

## 6. Settings — одна вставка в `src/app/settings/page.tsx`
Сразу **после** карточки Slack (найди по `reloadSlack` / разметке блока Slack) вставь:
```tsx
<NotifyChannelsCard />
<UptimeSettingsCard />
```
плюс импорты. Дальше файлом владеет T3, строку `<UptimeSettingsCard />` он сохраняет.

## 7. `src/lib/notify.ts` — только сигнатура
Функции `notifyUser` добавь необязательный третий параметр
`opts?: import("@/lib/notify/types").NotifyOptions` (с `// eslint-disable-next-line
@typescript-eslint/no-unused-vars`, если линт ругается). Тело не меняй. Экспортируй заглушку
`notifyUserDetailed` с сигнатурой из контракта: она вызывает старый `notifyUser` и возвращает
`[]`. Дальше файлом владеет T3.

## 8. Планировщики — `src/instrumentation.ts`
После блока `startAuditScheduler()`:
```ts
    // Uptime monitor: HTTP checks every few minutes, alerts on up→down→up transitions only.
    const { startUptimeScheduler } = await import('@/lib/uptime/scheduler');
    startUptimeScheduler();
    // Automatic URL Inspection inside Google's free per-property quota (resets at midnight PT).
    const { startIndexScheduler } = await import('@/lib/indexing/scheduler');
    startIndexScheduler();
    // Brand mentions: Google News RSS + Wikipedia/Wikidata once a day per opted-in site.
    const { startMentionsScheduler } = await import('@/lib/mentions/scheduler');
    startMentionsScheduler();
```

## 9. MCP — `src/lib/mcp/tools.ts`
Импорты пяти массивов из §5 контракта и добавление их в конец `MCP_TOOLS`. Больше ничего.

## 10. `package.json`
- Глобы из `CONTRACT.md` §6 — в конец `test:unit`. Проверь, что `npm run test:unit` запускает
  новые `types.test.ts` (число тестов в выводе выросло).
- `npm i nodemailer && npm i -D @types/nodemailer`. Запиши версии в отчёт.

## 11. Локали и шаблоны уведомлений
- Все ключи из `CONTRACT.md` §7 во все семь файлов `src/locales/*.json`. Значение `tabAeo`
  меняется. `npm run check:i18n` должен быть зелёным.
- Динамические ключи (`uptimeStatus_*`, `uptimeCause_*`, `metaFitMethod_*`, `notifyEv_*`,
  `notifyChErr_*`, `idxAutoPri_*`, `mentionsSource_*`, `mentionsKind_*`, `mentionsLink_*`,
  `mentionsState_*`) вызываются как ``t(`prefix_${code}`)``. Проверь, как `scripts/check-keys.js`
  относится к ключам без литерального использования. Если он считает их неиспользуемыми, не меняй
  скрипт — напиши в отчёте, как он устроен (у SERP Monitor была такая же ситуация с `serpmonProblem_*`).
- `src/lib/notifyI18n.ts`: поля из §8 в `Tpl` и во все семь языков; экспорт
  `formatDuration(ms: number, lang: NotifyLang): string` («45 s / 12 min / 2 h 5 min / 3 d 4 h»
  и аналоги на остальных языках) с тестом в `src/lib/uptime/types.test.ts`.

## 12. Документация
`docs/tasks/wave-oct/` уже в ветке. Больше ничего не пиши: доки модулей пишут задачи.

## Проверка
```bash
npx prisma validate && npx prisma generate
npm run check
npx eslint src/lib/{uptime,notify,indexing,mentions,visibility} src/lib/seo/metaLimits.ts src/lib/seo/metaFit.ts \
  src/components/uptime src/components/visibility src/components/VisibilityHub.tsx src/components/IndexAutoPanel.tsx \
  src/components/NotifyChannelsCard.tsx src/lib/mcp/tools*.ts src/instrumentation.ts src/lib/notifyI18n.ts
npx tsc -p tsconfig.json --noEmit     # не больше базы
```
Открой `npm run dev`: вкладка сайта называется «Видимость», подвкладки переключаются, «Ответы ИИ»
показывают прежний трекер, на вкладке Health сверху заглушка «Аптайм», в Indexing — заглушка
«Автопроверка индексации», в Settings — две новые карточки-заглушки. Консоль без ошибок.

## Коммит
Один коммит в `feat/wave-oct`:
`feat(wave-oct): foundation — schema, shared types, stubs, visibility hub, i18n, notify templates`
Сообщи хеш: от него стартуют T1…T7.

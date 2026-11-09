# R — ревью волны «Расширение» (уже в `main`)

Задачи приземляются в `main` сами (README §3.2). Твоя работа — убедиться, что то, что там
лежит, цельное, и сшить хвосты. Работаешь прямо в основном клоне на `main`; коммиты — тоже в
`main`, без веток. `git push` не делать.

## 1. Сначала — владение файлами

```bash
git log --oneline <коммит E0>~1..main
for c in $(git rev-list <коммит E0>..main); do echo "== $(git log -1 --format=%s $c)"; git show --stat --format= $c; done
```

У каждого коммита сверь список файлов с таблицей README §4. Файл вне колонки задачи —
первое, что надо разобрать, прежде чем читать логику. Если правка нужная, оставь её и запиши
в CHANGELOG-заметку для Руслана. Если нет — откати её отдельным коммитом.

## 2. Хвосты из отчётов

Собери из отчётов E1–E5 разделы «правки в чужих файлах» и «дополнительные ключи», примени.
Ключи: приложение — во все 7 локалей (`npm run check:i18n`); расширение — в `en` и `ru`, и
проверь, что набор ключей одинаковый.

Известные места, где задачи зависят друг от друга, — проверь их явно:

- E3 использует `ExtensionAudit.registrableOf`, `linkArea`, `TEXT_BLOCK_MIN` (E1). Нет
  временных копий с `TODO(R)`? Если есть — заменить вызовами.
- E2 и E3 ставят вкладки в реестр E1: `applies` взаимоисключающие (портфель → OpenGSC, чужое →
  Донор), обе работают без настроенного сервера (Донор — локально, OpenGSC — скрыта).
- E4 и E5: формы `HostsResponse`, `CaptureRequest`, `CloakResponse` совпадают с `types.ts`
  буквально (поля, null/[]).
- `CAPTURE_FEATURES` в `types.ts` и в `serpParse.js` совпадают (тест E4).
- Маркеры WayForge: тест E3 сверяет с `pbn/clean.ts`.

## 3. Проверки

```bash
npx prisma generate && npm run check
npx tsc -p tsconfig.json --noEmit           # не больше ошибок, чем до E0
npx eslint src/lib/ext src/app/api/ext src/app/api/serpmon/captures src/components/serpmon/CapturesTab.tsx src/lib/mcp/toolsSerpCaptures.ts
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json'))"
grep -rn "fetch(" extension/serp extension/lib/serpParse.js extension/lib/donor.js extension/content.js   # должно быть пусто: content-скрипты не ходят в сеть
grep -rn "setAttribute\|classList\|\.style\." extension/serp extension/lib/highlight.js | grep -v shadow   # следов на чужой странице быть не должно
```

Безопасность — прочитай глазами:

- каждый новый `/api/ext/*` начинается с `extAuth` с правом из контракта; `meta-fit` с LLM
  требует `spend` и `confirm`;
- `cloak` идёт через `assertSafeTarget` и имеет свой лимитер;
- прокси `ext:api` в `background.js` пускает только пути из whitelist и только от
  `sender.id === chrome.runtime.id`;
- в фикстурах `src/lib/ext/__fixtures__/serp/` нет имени, e-mail и cookie-подобных строк.

## 4. Руками — пройди чеклист README §8 сам

Перед Русланом. Что не работает — чинишь или возвращаешь задаче (опиши, что и где).

## 5. CHANGELOG и README

`CHANGELOG.md` — раздел новой версии: панель вместо попапа, слой OpenGSC (главный запрос,
футпринт, мета), режим донора, оверлей выдачи, снимки из браузера в SERP Monitor, MCP
`serpmon_captures`. Отдельной строкой: **после обновления перезагрузить расширение в
`chrome://extensions`** и **`npx prisma db push`** (новая таблица `SerpCapture`).
В README (раздел про расширение) — новые возможности одним абзацем со ссылкой на
`docs/EXTENSION.md`. Версию в `package.json` не трогай: релиз делает Руслан.

## 6. Отчёт

Хеши коммитов волны, что исправил сам, что вернул задачам, результаты проверок в числах,
что осталось на следующую волну (например, выдача Bing/Яндекса, объёмы запросов по кнопке).

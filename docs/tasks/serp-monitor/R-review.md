# R — Ревью и сборка

Отдельная сессия после того, как T1…T6 сдали отчёты.

## 1. Перед слиянием каждой ветки
1. `git diff --stat feat/serp-monitor...feat/serpmon-tN` — **каждый** файл есть в колонке
   этой задачи в `README.md`. Чужой файл — первым делом разобраться, почему.
2. Отчёт задачи: пункты «правки в чужих файлах», «доп. ключи», «решения не по контракту».
3. `git log feat/serp-monitor..feat/serpmon-tN` — нет коммитов с правкой локалей, схемы,
   `package.json` (кроме T0).
4. Сверить сигнатуры с `CONTRACT.md` §3 — заглушки T0 должны быть заменены полностью
   (`grep -rn "not implemented (T" src/lib/serpmon src/lib/seo` после сборки → пусто).

## 2. Порядок и команды
В worktree ветки интеграции (`.worktrees/serpmon-t0`), из терминала Мака:
```bash
git merge --no-ff feat/serpmon-t2   # движок
git merge --no-ff feat/serpmon-t1   # A-Parser (коммит Rank Tracker — отдельно, см. ниже)
git merge --no-ff feat/serpmon-t4   # домены
git merge --no-ff feat/serpmon-t3   # сборщик
git merge --no-ff feat/serpmon-t5   # UI
git merge --no-ff feat/serpmon-t6   # алерты, MCP, доки
```
После каждого: `npm run check && npx tsc -p tsconfig.json --noEmit`.
Конфликтов быть не должно (владение файлами не пересекается). Конфликт — значит кто-то
вышел за свои файлы; не разрешать вслепую.

**Коммит Rank Tracker из T1** — решение Руслана. Если брать не сейчас:
`git revert <hash>` после слияния T1 и пометка в CHANGELOG.

## 3. Доработки после сборки
- Применить «правки в чужих файлах» из отчётов (и только их).
- Собрать «дополнительные ключи» всех задач и добавить в 7 локалей одним коммитом.
- Если T1 оставил `UNVERIFIED` id опций — прогнать `scripts/aparser-serp-probe.ts` (Руслан,
  на живом A-Parser) и поправить `APARSER_SERP_OPTION_IDS`.
- Версия: `check:release` — поднять версию, если так требует процесс (см. `docs/RELEASE-CHECKLIST.md`).

## 4. Проверка целиком
- `grep -rn "resultString" src/lib/serpmon src/lib/seo/aparserSerp.ts` — только в комментариях.
- `grep -rn 'includes("x.com")\|includes(".com")' src/lib/serpmon` — пусто.
- Прогнать `npm run check`, полный `tsc`, `eslint` по всем новым путям.
- Пройти чеклист «Как тестировать» из `README.md` вместе с Руслановой копией базы.

## 5. Отчёт Руслану
Что влито (хеши), что отложено, какие решения принимали задачи вне контракта, результаты
проверок числами, что осталось проверить на живом A-Parser.

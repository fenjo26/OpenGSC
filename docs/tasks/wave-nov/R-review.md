# R — Ревью и сборка волны «Ноябрь»

Отдельная сессия в `.worktrees/nov-n0` после отчётов N1…N11. Тот же порядок проверок, что в
`docs/tasks/wave-oct/R-review.md` §1: диф каждой ветки только по своим файлам, никаких правок
схемы, локалей, `notifyI18n.ts`, `package*.json` вне N0.

## Порядок слияния
```bash
for n in n1 n2 n5 n6 n7 n3 n4 n10 n8 n9 n11; do
  git merge --no-ff feat/wave-nov-$n || break
  npm run check && npx tsc -p tsconfig.json --noEmit || break
done
```

## Правки руками после слияния
- Доп. i18n-ключи из отчётов — во все 7 локалей.
- Раздел N3 «Локальные позиции» → `docs/LOCAL-SEO.md`.
- Ссылка «Проверить на плагиат» в `SeoTextDetail.tsx` (место опишет N6).
- Правка `sendEmail` для вложений PDF, если о ней попросил N8 (файл N10 — после его слияния).
- `CHANGELOG.md`, `README.md` / `README.ru.md` (число MCP-инструментов), `docs/MCP-SETUP.md`.

## Точечные проверки
- **node_modules:** в основной папке есть `web-push`; ни в одном worktree `node_modules` не
  стал обычной папкой (`find .worktrees -maxdepth 2 -name node_modules -not -type l`).
- **N2:** на гемблинг-сайте с `ownNiche: ["gambling"]` казино-доноры не `toxic`; disavow не
  ставится автоматически.
- **N3:** старые ключи (без `location`) проверяются как раньше; `position` ни в одном месте не
  получает значение из local pack (`grep -n "localPack" src/lib/rank.ts`).
- **N4:** существующий вход через Google не изменён (`git diff feat/wave-oct -- src/lib/auth.ts` пуст);
  без одобрения API — `gbp_access_required`, а не 500.
- **N6:** без `confirm` нет ни одного SERP-запроса (журнал провайдеров пуст после `estimate`).
- **N7:** автооценка тональности по умолчанию выключена.
- **N8:** в HTML снимка нет `<script>`; клиентская ссылка отчёта не открывает дашборд сайта.
- **N9:** в публичных маршрутах `safeFetch` только с `allowPrivate: false`
  (`grep -rn "safeFetch(" src/app/api/public src/lib/leads`); аудит `http://127.0.0.1:9091`
  через виджет → отказ; 6-й аудит с одного IP за час → 429.
- **N10:** на `http://` кнопка push не показывается, а объясняет почему.
- **N11:** в `extension/manifest.json` нет `<all_urls>`; без токена `/api/ext/page` → 401.
- `npx prisma db push` на копии прод-базы проходит без `--accept-data-loss`.

## Сдача
Чеклист `README.md` §8 на копии базы — что прошло, что нет. Merge в `main` делает Руслан.

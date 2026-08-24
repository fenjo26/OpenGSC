# T6 — Ссылки в дайджесте и алерты

Ветка: `feat/backlinks-t6-digest`
Код пиши сразу; запустить получится после T0.

## Задача

Инструмент, который надо открывать и смотреть руками, проигрывает тому, который сам
сообщает. Владелец продукта формулирует так: показывать в дайджесте экстремальное
количество пропавших и появившихся ссылок.

## Что прочитать

- `docs/tasks/CONTRACT.md`, разделы 0, 1, 2, 4
- `src/lib/digest.ts` — `DigestData`, `buildDigestData`, `renderDigestMarkdown`,
  константы «сколько элементов держим в секции»
- `src/lib/alertScheduler.ts` — как устроены существующие правила
- `src/lib/notifyI18n.ts` — тексты уведомлений
- `prisma/schema.prisma`, модель `BacklinkSnapshot` — суточные срезы, уже копятся

## Файлы, которыми ты владеешь

`src/lib/digest.ts`, `src/lib/alertScheduler.ts`, `src/lib/notifyI18n.ts`.

## Задача 1 — секция «Ссылки» в дайджесте

Добавь в `DigestData` секцию и отрисуй её в `renderDigestMarkdown` в стиле соседних
секций (не изобретай новый формат).

Содержимое за период:

- `+N` появившихся, `−M` потерянных — считай по `SiteBacklinkEvent`
  (`appeared` / `lost` / `returned`) за окно дайджеста
- **избранные — отдельной строкой и поимённо**, всегда, даже если потеряна одна.
  Дорогая ссылка не должна утонуть в агрегате
- `rel_downgraded` отдельной строкой: переход dofollow → nofollow/sponsored/ugc.
  По общей цифре «всего ссылок» эта порча не видна вообще, а вес теряется
- топ доменов-доноров, где были потери

## Задача 2 — аномалия считается от базовой линии

Не фиксированный порог. `BacklinkSnapshot` уже копит суточные срезы — есть с чем
сравнивать.

Правило: потеря считается аномальной, если она **больше обычной за сопоставимый
период втрое, или больше 5% профиля — что жёстче**. Если истории меньше двух недель,
базовой линии нет: не считай аномалией ничего, просто покажи числа.

Вынеси само правило в чистую функцию с юнит-тестом. Пороги — именованные константы
с комментарием, откуда они, а не числа в середине выражения.

## Задача 3 — молчать, пока данных нет

Жёсткое требование, см. раздел 4 контракта.

Пока в БД нет **ни одного** `SiteBacklinkSync` со `status = "completed"` и
`complete = true`, дайджест обязан **молчать о потерях**. Иначе первая полная
выгрузка отрапортует «потеряно 8000 ссылок», которых никто не терял, и доверие
к инструменту кончится на первом же письме.

То же самое для частичных прогонов: события, порождённые прогоном с `complete = false`,
в подсчёт потерь не идут. Появления — идут, они безопасны.

Когда базовой линии ещё нет, покажи `dglBaselineBuilding` вместо цифр потерь.

## Задача 4 — алерты

Два новых правила в `alertScheduler.ts`, в стиле существующих:

1. **Аномальная потеря ссылок** — по правилу из задачи 2
2. **Порча избранной ссылки** — любое из `lost`, `rel_downgraded`, `target_changed`
   по строке с `favorite = true`. Здесь порога нет: одна такая ссылка это уже повод

Тексты — в `notifyI18n.ts`, рядом с существующими, на тех же языках, что там уже есть.

Дедупликация: одно и то же событие не должно уходить дважды. Посмотри, как это решено
у существующих правил, и повтори — не изобретай свой механизм.

## Критерии приёмки

- юнит-тест на детектор аномалии: ровная история → тихо; всплеск втрое → срабатывает;
  история короче двух недель → тихо; потеря 6% профиля при ровной истории → срабатывает
- юнит-тест: при отсутствии завершённой полной выгрузки секция потерь пуста,
  а секция появлений — нет
- юнит-тест: потеря одной избранной ссылки попадает в дайджест поимённо
- `npm run check:i18n` проходит (ключи уже созданы T0 — ты их только используешь)
- `npm run check` проходит

## Не делай

- не трогай `prisma/**`, локали, `src/app/site/[id]/page.tsx`, `src/lib/seo/**`
- не читай `SiteBacklink` напрямую ради подсчёта «сколько сейчас потеряно» —
  считай по событиям за период, иначе дайджест будет повторять одно и то же
  каждую неделю
- не добавляй новые каналы уведомлений, работай через существующие

## i18n-ключи (создаёт T0, ты только используешь)

```
dglSectionTitle       Links
dglNew                new links
dglLost               lost links
dglNet                net change
dglFavoriteLost       Favourite links lost
dglFavoriteDowngraded Favourite links downgraded to nofollow
dglRelDowngrade       links became nofollow / sponsored / ugc
dglTopLossDomains     Most losses by donor domain
dglAnomaly            Unusual link loss
dglAnomalyHint        {n} links lost — {x}× the usual rate for this period.
dglBaselineBuilding   Not enough history yet to judge link losses — collecting a baseline.
dglNoFullExport       No complete backlink export yet, so losses are not reported.
dglNoChange           No link changes this period.
alertBacklinkLossTitle    Unusual backlink loss on {site}
alertBacklinkLossBody     {n} backlinks lost since the last check — {x}× the usual rate.
alertFavoriteLinkTitle    A favourite link changed on {site}
alertFavoriteLinkBody     {url} — {what}
```

## Дополнительные ключи (понадобились по ходу T6)

`alertFavoriteLinkBody` — это `{url} — {what}`, а `{what}` надо переводить. Три варианта:

```
dglWhatLost            the link is gone
dglWhatDowngraded      downgraded to nofollow / sponsored / ugc
dglWhatTargetChanged   now points somewhere else
```

В `src/lib/notifyI18n.ts` они уже добавлены на всех семи языках (этот файл принадлежит T6).
В `src/locales/*.json` их должен добавить T0 или ревьюер — для in-app страницы дайджеста.

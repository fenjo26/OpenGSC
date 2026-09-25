# N4 — Local SEO: карточка бизнеса, NAP, каталоги, схема, Google Business Profile

**Ветка:** `feat/wave-nov-n4`. **Владение:** `README.md` §4, строка N4. Дока — `docs/LOCAL-SEO.md`
(раздел про локальные позиции пришлёт N3, оставь заголовок `## Локальные позиции`).

## Зачем
Для трансферов (Thessaloniki airport → Halkidiki) и massagethess.gr локальная выдача важнее
органической. Сейчас в OpenGSC для этого нет ничего. Страница `/local` с выбором сайта
(селектор, как на других общих страницах) и вкладками ниже.

## 1. Карточка бизнеса — `LocalProfile`
Форма: название, тип schema.org (список: `LocalBusiness`, `TaxiService`, `DaySpa`,
`HealthAndBeautyBusiness`, `MassageTherapist`? — **проверь, есть ли такой тип в schema.org;
если нет — не добавляй**, `TravelAgency`, `Restaurant`, `Hotel`, `Dentist`, `LegalService`,
`Plumber`, `AutoRepair`), адрес по полям, страна, телефон (нормализация в E.164 по стране),
e-mail, координаты (ввод руками или «взять из адреса» — **без** платного геокодера: только если
у сайта в JSON-LD уже есть `geo`), часы работы по дням, `priceRange`, `sameAs`, зоны обслуживания.
Кнопка «Заполнить с сайта»: разобрать JSON-LD главной страницы (`safeFetch`) и подставить то,
что найдено, — пользователь подтверждает.

## 2. NAP-проверка сайта — `src/lib/local/nap.ts`
- Страницы: главная, страницы контактов (ссылки, чей путь или текст содержит `contact`,
  `kontakt`, `επικοινωνία`, `контакты`, `about`, `impressum`; до 10), плюс футер главной.
- Извлечение (чистые функции): телефоны (регэксп + нормализация к E.164 со страной профиля;
  `tel:`-ссылки в приоритете), адрес (`PostalAddress` в JSON-LD, микроразметка, иначе поиск
  улицы и индекса из профиля в тексте), название (JSON-LD `name`, `og:site_name`).
- Сравнение с профилем → `NapDiff[]`: `{ field: "name"|"phone"|"address", expected, found, url }`.
  Телефоны — по цифрам E.164; адрес — fold + Jaccard слов ≥ 0,7; название — fold, без
  юр. форм (`IKE`, `ΙΚΕ`, `OE`, `LLC`, `Ltd`, `GmbH`).
- Результат — отчёт на экране (не хранится): страница × поле × «совпадает / отличается /
  не найдено».

## 3. Каталоги (citations) — `LocalCitation`
- Список URL карточек в каталогах вводит пользователь. Подсказка «где ещё можно разместиться»
  по стране профиля — встроенный список (для `gr`: Google Business Profile, Facebook, Apple
  Business Connect, Bing Places, xo.gr, vrisko.gr, 11888.gr, TripAdvisor, Foursquare; для прочих
  стран — общемировые). Только ссылки на регистрацию, без автопостинга.
- Проверка карточки: `safeFetch` → те же экстракторы → `status` и `diffs`. Каталог, отдающий
  403/капчу, → `unreachable` с пояснением (многие каталоги режут ботов, это не «ошибка NAP»).
- Планировщик раз в неделю перепроверяет все карточки; сводка изменений — в UI.

## 4. Генератор LocalBusiness-разметки — `src/lib/local/schema.ts`
Из профиля → JSON-LD выбранного типа: `name`, `url`, `telephone`, `email`, `address`
(`PostalAddress`), `geo`, `openingHoursSpecification`, `priceRange`, `sameAs`, `areaServed`
(из зон), `image` (если есть логотип сайта в аудите). Валидация по требованиям Google к
LocalBusiness: обязательные `name`, `address`; рекомендуемые — список предупреждений.
Кнопка «Сравнить с сайтом»: JSON-LD главной страницы против сгенерированного — diff по полям.
Кнопка «Копировать» и «Скачать .json».

## 5. Страницы для зон обслуживания
Для каждой зоны из профиля — кнопка «Создать страницу», которая открывает
`/seo-tools/outline` с предзаполненным ключом `<услуга> <город>` и заметкой
«локальная посадочная, NAP и карта обязательны» (через query-параметры, которые страница
аутлайна уже принимает — проверь, какие; если никаких — открой с ключом в буфере обмена и
напиши в отчёте, что нужно добавить на странице аутлайна). Сама генерация — существующий
платный пайплайн, здесь ничего не генерируется.

## 6. Google Business Profile — `src/lib/local/gbp.ts`
**Доступ.** Business Profile API выдаётся по заявке. До одобрения квота 0 и любой вызов
возвращает 429/403 с сообщением о квоте. Это состояние `gbp_access_required`: карточка с
объяснением и ссылкой на форму заявки (найди актуальную ссылку в документации Google
Business Profile APIs, раздел «Prerequisites»), а не ошибка.

**Авторизация.** Отдельный OAuth-поток со scope `https://www.googleapis.com/auth/business.manage`,
те же `GOOGLE_CLIENT_ID/SECRET`: `GET /api/local/gbp/connect` → Google → `/api/local/gbp/callback`
→ токены в `User.gbpToken` (только сервер, в UI — «подключено как …»). Существующий вход через
Google (`src/lib/auth.ts`) **не трогать**. В доку — какой redirect URI добавить в Google Cloud.

**Функции** (endpoint'ы — по актуальной документации Business Profile APIs; сверь версии,
часть методов живёт в v1 Business Information / Account Management, отзывы и посты — в v4):
- выбор аккаунта и локации → `LocalProfile.gbpAccount/gbpLocation`;
- **отзывы:** загрузка в `GbpReview` раз в 6 часов; ответ на отзыв из UI; новые отзывы →
  уведомление `gbpReviewTitle/Msg` (событие `local`), первый импорт не уведомляет;
- **посты:** черновик → запланировать (`GbpPost`) → планировщик публикует в `scheduledAt`
  (CTA, картинка по публичному https-URL); статус и ошибка видны в списке;
- **фото:** загрузка по публичному URL в media локации; список текущих фото.
- Все вызовы — через журнал провайдеров (`gbp`, стоимость 0).

**Не делаем:** агрегатор отзывов Yelp/TripAdvisor/Trustpilot/Facebook (закрытые или платные
API), «Geo-IP тест» (то, как выдача выглядит из другого города, — это локальные позиции N3).

## 7. Планировщик — `src/lib/local/scheduler.ts`
Тик раз в 10 минут: посты к публикации; отзывы (если прошло 6 ч); каталоги (если прошло 7 дней).
Без подключённого GBP — только каталоги.

## 8. MCP — `get_local_profile` (local), `check_nap` (net).

## Тесты — `src/lib/local/*.test.ts`
Нормализация телефонов (`+30 2310 123456`, `2310-123456`, `00302310123456` → одно E.164);
извлечение адреса из JSON-LD и из текста; сравнение названий без юр. форм; генерация JSON-LD
(часы работы, geo, areaServed) — снапшот; валидация обязательных полей; разбор ответа GBP
отзывов и постов из фикстур; `gbp_access_required` по ответу с нулевой квотой.

## i18n (N0 создаёт)
| ключ | en | ru |
|---|---|---|
| `locNavTitle` | Local | Local |
| `locTitle` | Local SEO | Local SEO |
| `locTabProfile` | Business profile | Карточка бизнеса |
| `locTabNap` | NAP check | Проверка NAP |
| `locTabCitations` | Directories | Каталоги |
| `locTabSchema` | Schema | Разметка |
| `locTabGbp` | Google Business Profile | Google Business Profile |
| `locName` | Business name | Название |
| `locType` | Business type | Тип бизнеса |
| `locAddress` | Address | Адрес |
| `locPhone` | Phone | Телефон |
| `locHours` | Opening hours | Часы работы |
| `locAreas` | Service areas | Зоны обслуживания |
| `locFillFromSite` | Fill from the site | Заполнить с сайта |
| `locNapRun` | Check the site | Проверить сайт |
| `locNap_match` | Matches | Совпадает |
| `locNap_differs` | Differs | Отличается |
| `locNap_missing` | Not found | Не найдено |
| `locCitAdd` | Add listing URL | Добавить ссылку на карточку |
| `locCitSuggest` | Where else to be listed | Где ещё разместиться |
| `locCit_unchecked` | Not checked | Не проверено |
| `locCit_consistent` | Consistent | Совпадает |
| `locCit_mismatch` | Mismatch | Расхождения |
| `locCit_missing` | NAP not found | NAP не найден |
| `locCit_unreachable` | Directory blocks bots | Каталог не пускает ботов |
| `locSchemaCompare` | Compare with the site | Сравнить с сайтом |
| `locSchemaRequired` | Required field missing: {field} | Нет обязательного поля: {field} |
| `locCreatePage` | Create page | Создать страницу |
| `locGbpConnect` | Connect Google Business Profile | Подключить Google Business Profile |
| `locGbpAccessRequired` | Google grants Business Profile API access on request. Until approved the quota is 0. | Google открывает Business Profile API по заявке. До одобрения квота равна 0. |
| `locGbpApply` | Request API access | Подать заявку на доступ |
| `locGbpReviews` | Reviews | Отзывы |
| `locGbpReply` | Reply | Ответить |
| `locGbpPosts` | Posts | Посты |
| `locGbpSchedule` | Schedule | Запланировать |
| `locGbpPhotos` | Photos | Фото |
| `locGbpPost_draft` | Draft | Черновик |
| `locGbpPost_scheduled` | Scheduled | Запланирован |
| `locGbpPost_published` | Published | Опубликован |
| `locGbpPost_failed` | Failed | Ошибка |

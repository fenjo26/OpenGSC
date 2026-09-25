// N9 — server- and client-side strings for the lead widget contour, in all seven app
// languages. The locale JSON files are owned by N0 and R, so the texts that only this
// module needs (finding titles/fixes/consequences, report e-mail, proposal skeleton, first
// letter) live HERE instead. Locale keys from the N9 brief stay in the locales and win:
// `t2()` below reads the locale dictionary first and falls back to this module, so an
// additional key works today and keeps working after R migrates it into the locales.

import type { FindingCategory, FindingCode, LeadLang } from "./types";
import en from "@/locales/en.json";
import ru from "@/locales/ru.json";
import uk from "@/locales/uk.json";
import fr from "@/locales/fr.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";
import zh from "@/locales/zh.json";

export interface FindingStrings {
  title: string;
  fix: string;
  /** Plain-language consequence for proposals: what it costs the business, no numbers promised. */
  consequence: string;
}

export interface LeadStrings {
  findings: Record<FindingCode, FindingStrings>;
  consent: string;
  email: {
    subject: (domain: string, score: number) => string;
    header: (domain: string, score: number) => string;
    intro: string;
    footer: string;
  };
  letter: {
    subject: (domain: string) => string;
    greeting: (name: string) => string;
    intro: (domain: string, score: number) => string;
    offer: string;
    closing: string;
  };
  proposal: {
    docTitle: (domain: string) => string;
    about: string;
    aboutPlaceholder: string;
    found: string;
    scope: string;
    pricing: string;
    priceNote: string;
    timeline: string;
    timelinePlaceholder: string;
    nextStep: string;
    nextStepText: string;
    noPromises: string;
    categories: Record<FindingCategory, string>;
  };
  widget: {
    checking: string;
    error: string;
    nameField: string;
    messageField: string;
    consentLabel: string;
    needEmail: string;
    sending: string;
    again: string;
  };
  ui: Record<string, string>;
}

// ─── English ───────────────────────────────────────────────────────────────────

const EN: LeadStrings = {
  findings: {
    https_unavailable: {
      title: "The site does not work over HTTPS",
      fix: "Install an SSL/TLS certificate and redirect all http:// URLs to https://.",
      consequence: "Browsers mark the site “Not secure”, visitors leave, and Google ranks secure competitors above it.",
    },
    http_error: {
      title: "The server returns an error",
      fix: "Fix the HTTP status of the listed pages — they must answer 200.",
      consequence: "Search engines drop error pages from the index, and visitors see a failure instead of the site.",
    },
    fetch_failed: {
      title: "Pages could not be loaded",
      fix: "Check that the server answers reliably and does not block crawlers.",
      consequence: "If our checker could not load these pages, search engine robots likely cannot either.",
    },
    redirect: {
      title: "The main page redirects elsewhere",
      fix: "Point the canonical address directly; a homepage should answer 200, not a redirect.",
      consequence: "Every redirect spends crawl budget and dilutes the signals that decide rankings.",
    },
    redirect_chain: {
      title: "Long redirect chain",
      fix: "Link and redirect straight to the final URL, one hop at most.",
      consequence: "Each extra hop slows the site down and can drop the page from search results.",
    },
    title_missing: {
      title: "Pages have no <title>",
      fix: "Write a unique 50–60 character title for each listed page.",
      consequence: "Without a title the search result has nothing to show — such pages barely get clicks.",
    },
    title_too_long: {
      title: "Titles are too long",
      fix: "Shorten the titles to 50–60 characters; put the main keyword first.",
      consequence: "Overlong titles are cut off in search results, and the message loses its ending.",
    },
    title_too_short: {
      title: "Titles are too short",
      fix: "Expand the titles to 50–60 characters with real search words, not just the brand.",
      consequence: "A one-word title does not tell the searcher what the page is about, so fewer people click.",
    },
    description_missing: {
      title: "Pages have no meta description",
      fix: "Write a 150–160 character description for each listed page.",
      consequence: "Google assembles the snippet from random page text, and the result reads worse than it could.",
    },
    description_too_long: {
      title: "Meta descriptions are too long",
      fix: "Trim the descriptions to 150–160 characters.",
      consequence: "The description is cut off mid-sentence exactly where the call to action usually sits.",
    },
    description_too_short: {
      title: "Meta descriptions are too short",
      fix: "Expand the descriptions to 150–160 characters with a concrete offer.",
      consequence: "A short snippet wastes the space that convinces the searcher to choose you.",
    },
    h1_missing: {
      title: "Pages have no H1 heading",
      fix: "Add exactly one H1 per page describing its subject.",
      consequence: "Without the main heading neither people nor search engines see what the page is about.",
    },
    h1_multiple: {
      title: "More than one H1 on a page",
      fix: "Keep a single H1; demote the rest to H2.",
      consequence: "Several H1s blur the page's topic and weaken its relevance signals.",
    },
    noindex: {
      title: "Pages are closed from indexing (noindex)",
      fix: "Remove the noindex directive from the listed pages if they must be in search.",
      consequence: "These pages are invisible to Google — no impressions, no visitors, no sales.",
    },
    canonical_missing: {
      title: "No canonical URL",
      fix: "Add <link rel=\"canonical\"> pointing at each page's own final URL.",
      consequence: "Without a canonical, duplicates of the page can split its ranking signals.",
    },
    viewport_missing: {
      title: "No mobile viewport",
      fix: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">.",
      consequence: "On phones the page renders as a shrunken desktop layout — most mobile visitors leave.",
    },
    viewport_not_responsive: {
      title: "Viewport blocks mobile zoom",
      fix: "Remove user-scalable=no and maximum-scale below 2 from the viewport meta.",
      consequence: "Low-vision users cannot zoom the text — an accessibility failure that carries legal risk in some markets.",
    },
    lang_missing: {
      title: "Page language is not declared",
      fix: "Add the lang attribute to <html>, e.g. lang=\"en\".",
      consequence: "Screen readers pick the wrong voice and search engines guess the language — both badly.",
    },
    jsonld_invalid: {
      title: "Broken structured data (JSON-LD)",
      fix: "Fix the JSON syntax in the structured data blocks.",
      consequence: "Invalid markup is ignored, so the site loses rich results in search.",
    },
    open_graph_incomplete: {
      title: "Incomplete Open Graph tags",
      fix: "Add og:title, og:description and og:image so links preview correctly.",
      consequence: "Links shared in messengers and social networks show a bare URL instead of a card.",
    },
    security_headers_missing: {
      title: "Security headers are missing",
      fix: "Add Content-Security-Policy, X-Content-Type-Options, Referrer-Policy and frame protection.",
      consequence: "The site is easier to attack with injected scripts and clickjacking.",
    },
    slow_response: {
      title: "The server responds slowly",
      fix: "Add caching and a CDN; aim for a server response under 1 second.",
      consequence: "Visitors wait, leave earlier, and search engines note the slow experience.",
    },
    broken_links: {
      title: "Broken links on the main page",
      fix: "Fix or remove the dead links listed in the report.",
      consequence: "Visitors and crawlers hit dead ends, and the site looks abandoned to both.",
    },
    mixed_content: {
      title: "Mixed content (http:// resources on an https:// page)",
      fix: "Load every image, script and stylesheet over https://.",
      consequence: "Browsers block the insecure parts, which breaks the page's look and features.",
    },
    thin_content: {
      title: "Very little text on the pages",
      fix: "Expand the listed pages with useful content — at least 150 words.",
      consequence: "Thin pages rank for nothing and simply consume the crawl budget.",
    },
    images_no_alt: {
      title: "Images without alt text",
      fix: "Describe every meaningful image in its alt attribute.",
      consequence: "Screen reader users hear a filename, and image search cannot classify the pictures.",
    },
  },
  consent: "I agree that my e-mail may be used to send me the audit report and be contacted about it.",
  email: {
    subject: (domain, score) => `SEO audit of ${domain} — score ${score}/100`,
    header: (domain, score) => `SEO audit of ${domain}: ${score}/100`,
    intro: "Here is what the automated check of your website found. Each item includes how to fix it.",
    footer: "This report was generated automatically by a site audit tool. It reflects a crawl of up to 5 pages at the time of checking.",
  },
  letter: {
    subject: domain => `A quick look at ${domain}`,
    greeting: name => (name ? `Hello ${name},` : "Hello,"),
    intro: (domain, score) => `We ran a quick automated check of ${domain} — it scored ${score} out of 100. Three things stood out:`,
    offer: "These are all fixable. Would a short 15-minute call this week work to go through them?",
    closing: "Best regards,",
  },
  proposal: {
    docTitle: domain => `SEO proposal for ${domain}`,
    about: "About us",
    aboutPlaceholder: "_Tell the client who you are: experience, team, results in their market. Two or three sentences are enough._",
    found: "What we found",
    scope: "Scope of work",
    pricing: "Pricing",
    priceNote: "Each item is priced separately; a package discount is possible when everything is taken at once.",
    timeline: "Timeline",
    timelinePlaceholder: "_Set the terms: for example, technical fixes — 1 week, content — 2–3 weeks._",
    nextStep: "Next step",
    nextStepText: "Reply to this proposal or book a call, and we start with the technical fixes — they usually bring the fastest visible change.",
    noPromises: "This proposal promises no traffic, ranking or revenue numbers: a crawl of up to 5 pages cannot support them.",
    categories: {
      crawlability: "Crawlability and indexing",
      metadata: "Meta tags and structured data",
      content: "Content",
      links: "Links",
      performance: "Speed",
      rendering: "Mobile rendering",
      security: "Security",
    },
  },
  widget: {
    checking: "Checking…",
    error: "Could not check this site. Check the domain and try again.",
    nameField: "Your name (optional)",
    messageField: "Message (optional)",
    consentLabel: "I agree to the processing of my e-mail",
    needEmail: "Please enter your e-mail",
    sending: "Sending…",
    again: "Check another site",
  },
  ui: {
    leadSearch: "Search domain or e-mail",
    leadEmpty: "No leads yet. Embed the widget on your site and they will appear here.",
    leadFilterAll: "All",
    leadDate: "Date",
    leadSource: "Source",
    leadStatus: "Status",
    leadSave: "Save",
    leadSaved: "Saved",
    leadDownload: "Download HTML",
    leadPrint: "Open & print",
    leadMakeClient: "Make client",
    leadInclude: "Include in the proposal",
    leadWidgetOn: "Widget enabled",
    leadWidgetAccent: "Accent colour",
    leadWidgetLogo: "Logo URL (shown in the widget)",
    leadWidgetNotify: "Extra e-mail for lead notifications",
    leadWidgetTpl: "First-letter template ({name}, {domain}, {email}, {score}, {issues})",
    leadWidgetOriginsAny: "Empty = any site can embed the widget (not recommended)",
    leadWidgetRegenConfirm: "Regenerate the key? The old widget stops working immediately.",
    leadCopied: "Copied",
    leadLoadError: "Could not load leads",
  },
};

// ─── Русский ───────────────────────────────────────────────────────────────────

const RU: LeadStrings = {
  findings: {
    https_unavailable: {
      title: "Сайт не работает по HTTPS",
      fix: "Установите SSL-сертификат и настройте редирект всех http://-адресов на https://.",
      consequence: "Браузер помечает сайт как «небезопасный», посетители уходят, а Google ставит выше защищённые сайты конкурентов.",
    },
    http_error: {
      title: "Сервер отдаёт ошибку",
      fix: "Исправьте HTTP-статус перечисленных страниц — они должны отвечать 200.",
      consequence: "Поисковики убирают страницы с ошибками из индекса, а посетитель видит сбой вместо сайта.",
    },
    fetch_failed: {
      title: "Страницы не удалось загрузить",
      fix: "Проверьте, что сервер отвечает стабильно и не блокирует роботов.",
      consequence: "Если наш проверочник не смог загрузить эти страницы, роботы поисковых систем, скорее всего, тоже не смогут.",
    },
    redirect: {
      title: "Главная страница редиректит на другой адрес",
      fix: "Укажите канонический адрес напрямую: главная должна отвечать 200, а не редиректом.",
      consequence: "Каждый редирект тратит краулинговый бюджет и размывает сигналы, которые определяют позиции.",
    },
    redirect_chain: {
      title: "Длинная цепочка редиректов",
      fix: "Ссылайтесь и редиректьте сразу на конечный URL, максимум один переход.",
      consequence: "Каждый лишний переход замедляет сайт и может выкинуть страницу из выдачи.",
    },
    title_missing: {
      title: "На страницах нет тега <title>",
      fix: "Напишите уникальный title длиной 50–60 символов для каждой страницы из списка.",
      consequence: "Без title сниппет в поиске пустой — такие страницы почти не получают кликов.",
    },
    title_too_long: {
      title: "Title слишком длинные",
      fix: "Сократите title до 50–60 символов, главное слово — в начало.",
      consequence: "Длинный title обрезается в выдаче, и самое важное — в конце — не видно.",
    },
    title_too_short: {
      title: "Title слишком короткие",
      fix: "Расширьте title до 50–60 символов реальными поисковыми словами, а не только брендом.",
      consequence: "Из одного слова непонятно, о чём страница, поэтому кликают реже.",
    },
    description_missing: {
      title: "На страницах нет meta description",
      fix: "Напишите описание 150–160 символов для каждой страницы из списка.",
      consequence: "Google собирает сниппет из случайного текста страницы, и результат выглядит хуже, чем мог бы.",
    },
    description_too_long: {
      title: "Meta description слишком длинные",
      fix: "Сократите описания до 150–160 символов.",
      consequence: "Описание обрезается на середине фразы — обычно ровно там, где призыв к действию.",
    },
    description_too_short: {
      title: "Meta description слишком короткие",
      fix: "Расширьте описания до 150–160 символов с конкретным предложением.",
      consequence: "Короткий сниппет тратит впустую место, которое убеждает выбрать именно вас.",
    },
    h1_missing: {
      title: "На страницах нет заголовка H1",
      fix: "Добавьте ровно один H1, описывающий тему страницы.",
      consequence: "Без главного заголовка ни люди, ни поисковик не понимают, о чём страница.",
    },
    h1_multiple: {
      title: "На странице больше одного H1",
      fix: "Оставьте один H1, остальные понизьте до H2.",
      consequence: "Несколько H1 размывают тему страницы и ослабляют её релевантность.",
    },
    noindex: {
      title: "Страницы закрыты от индексации (noindex)",
      fix: "Уберите директиву noindex с перечисленных страниц, если они должны быть в поиске.",
      consequence: "Эти страницы невидимы для Google: ни показов, ни посетителей, ни продаж.",
    },
    canonical_missing: {
      title: "Нет канонического адреса (canonical)",
      fix: "Добавьте <link rel=\"canonical\"> с конечным адресом каждой страницы.",
      consequence: "Без canonical копии страницы могут делить между собой её ссылки и позиции.",
    },
    viewport_missing: {
      title: "Нет мобильного viewport",
      fix: "Добавьте <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">.",
      consequence: "На телефоне сайт показывается уменьшенной версией десктопа — большинство мобильных посетителей уходит.",
    },
    viewport_not_responsive: {
      title: "Viewport запрещает масштабирование на мобильных",
      fix: "Уберите user-scalable=no и maximum-scale меньше 2 из meta viewport.",
      consequence: "Пользователи со слабым зрением не могут увеличить текст — нарушение доступности с юридическими рисками на некоторых рынках.",
    },
    lang_missing: {
      title: "Не указан язык страницы",
      fix: "Добавьте атрибут lang в <html>, например lang=\"ru\".",
      consequence: "Скринридеры выбирают не тот голос, а поисковики угадывают язык — и плохо.",
    },
    jsonld_invalid: {
      title: "Битые структурированные данные (JSON-LD)",
      fix: "Исправьте синтаксис JSON в блоках разметки schema.org.",
      consequence: "Невалидная разметка игнорируется, и сайт теряет расширенные сниппеты в выдаче.",
    },
    open_graph_incomplete: {
      title: "Неполные теги Open Graph",
      fix: "Добавьте og:title, og:description и og:image, чтобы ссылки красиво разворачивались.",
      consequence: "Ссылка в мессенджерах и соцсетях показывается голым URL вместо карточки.",
    },
    security_headers_missing: {
      title: "Не заданы заголовки безопасности",
      fix: "Добавьте Content-Security-Policy, X-Content-Type-Options, Referrer-Policy и защиту от фреймов.",
      consequence: "Сайт проще атаковать внедрением скриптов и кликджекингом.",
    },
    slow_response: {
      title: "Сервер отвечает медленно",
      fix: "Включите кэширование и CDN; цель — ответ сервера меньше 1 секунды.",
      consequence: "Посетители ждут и уходят раньше, а поисковики запоминают медленный опыт.",
    },
    broken_links: {
      title: "Битые ссылки на главной",
      fix: "Исправьте или уберите мёртвые ссылки из отчёта.",
      consequence: "И посетители, и роботы упираются в тупики — сайт выглядит заброшенным для тех и других.",
    },
    mixed_content: {
      title: "Смешанный контент (http://-ресурсы на https://-странице)",
      fix: "Загружайте все картинки, скрипты и стили по https://.",
      consequence: "Браузер блокирует незащищённые части, и страница ломается внешне и функционально.",
    },
    thin_content: {
      title: "Очень мало текста на страницах",
      fix: "Наполните страницы полезным содержимым — минимум 150 слов.",
      consequence: "«Тонкие» страницы не ранжируются ни по каким запросам и только тратят краулинговый бюджет.",
    },
    images_no_alt: {
      title: "Картинки без alt-текста",
      fix: "Опишите каждую значимую картинку в атрибуте alt.",
      consequence: "Скринридер читает имя файла, а поиск по картинкам не понимает, что на них.",
    },
  },
  consent: "Я согласен на обработку моего e-mail для отправки отчёта об аудите и связи по его результатам.",
  email: {
    subject: (domain, score) => `SEO-аудит ${domain} — оценка ${score}/100`,
    header: (domain, score) => `SEO-аудит сайта ${domain}: ${score}/100`,
    intro: "Вот что нашла автоматическая проверка вашего сайта. К каждой проблеме приложено, как её исправить.",
    footer: "Отчёт создан автоматически инструментом аудита сайтов и отражает обход до 5 страниц на момент проверки.",
  },
  letter: {
    subject: domain => `Короткий разбор ${domain}`,
    greeting: name => (name ? `Здравствуйте, ${name}!` : "Здравствуйте!"),
    intro: (domain, score) => `Мы прогнали быстрый автоматический аудит ${domain} — оценка ${score} из 100. Бросаются в глаза три вещи:`,
    offer: "Всё это исправимо. Найдётся 15 минут на созвон на этой неделе, чтобы пройтись по списку?",
    closing: "С уважением,",
  },
  proposal: {
    docTitle: domain => `Коммерческое предложение: SEO для ${domain}`,
    about: "О нас",
    aboutPlaceholder: "_Расскажите клиенту, кто вы: опыт, команда, результаты на его рынке. Достаточно двух-трёх предложений._",
    found: "Что мы нашли",
    scope: "Объём работ",
    pricing: "Стоимость",
    priceNote: "Каждый пункт оценивается отдельно; при заказе всего списка возможна пакетная скидка.",
    timeline: "Сроки",
    timelinePlaceholder: "_Укажите сроки: например, технические правки — 1 неделя, контент — 2–3 недели._",
    nextStep: "Следующий шаг",
    nextStepText: "Ответьте на это письмо или запишитесь на созвон — начнём с технических правок: они обычно дают самый быстрый видимый эффект.",
    noPromises: "В этом КП нет обещаний по трафику, позициям и выручке: краулинг до 5 страниц не может их обосновать.",
    categories: {
      crawlability: "Доступность и индексация",
      metadata: "Мета-теги и структурированные данные",
      content: "Контент",
      links: "Ссылки",
      performance: "Скорость",
      rendering: "Мобильная адаптация",
      security: "Безопасность",
    },
  },
  widget: {
    checking: "Проверяем…",
    error: "Не удалось проверить этот сайт. Проверьте домен и попробуйте ещё раз.",
    nameField: "Ваше имя (необязательно)",
    messageField: "Сообщение (необязательно)",
    consentLabel: "Согласен на обработку моего e-mail",
    needEmail: "Пожалуйста, введите e-mail",
    sending: "Отправляем…",
    again: "Проверить другой сайт",
  },
  ui: {
    leadSearch: "Поиск по домену или e-mail",
    leadEmpty: "Лидов пока нет. Установите виджет на свой сайт — и они появятся здесь.",
    leadFilterAll: "Все",
    leadDate: "Дата",
    leadSource: "Источник",
    leadStatus: "Статус",
    leadSave: "Сохранить",
    leadSaved: "Сохранено",
    leadDownload: "Скачать HTML",
    leadPrint: "Открыть и распечатать",
    leadMakeClient: "Сделать клиентом",
    leadInclude: "Включить в КП",
    leadWidgetOn: "Виджет включён",
    leadWidgetAccent: "Цвет акцента",
    leadWidgetLogo: "URL логотипа (показывается в виджете)",
    leadWidgetNotify: "Дополнительный e-mail для уведомлений о лидах",
    leadWidgetTpl: "Шаблон первого письма ({name}, {domain}, {email}, {score}, {issues})",
    leadWidgetOriginsAny: "Пусто = виджет можно вставить на любой сайт (не рекомендуется)",
    leadWidgetRegenConfirm: "Перевыпустить ключ? Старый виджет перестанет работать сразу.",
    leadCopied: "Скопировано",
    leadLoadError: "Не удалось загрузить лиды",
  },
};

// ─── Українська ────────────────────────────────────────────────────────────────

const UK: LeadStrings = {
  findings: {
    https_unavailable: { title: "Сайт не працює по HTTPS", fix: "Встановіть SSL-сертифікат і налаштуйте редирект усіх http://-адрес на https://.", consequence: "Браузер позначає сайт як «небезпечний», відвідувачі йдуть, а Google ставить вище захищені сайти конкурентів." },
    http_error: { title: "Сервер повертає помилку", fix: "Виправте HTTP-статус перелічених сторінок — вони мають відповідати 200.", consequence: "Пошуковики викидають сторінки з помилками з індексу, а відвідувач бачить збій замість сайту." },
    fetch_failed: { title: "Сторінки не вдалося завантажити", fix: "Перевірте, що сервер відповідає стабільно і не блокує роботів.", consequence: "Якщо наш перевірник не зміг завантажити ці сторінки, роботи пошукових систем, найімовірніше, теж не зможуть." },
    redirect: { title: "Головна сторінка редиректить на іншу адресу", fix: "Вкажіть канонічну адресу напряму: головна має відповідати 200, а не редиректом.", consequence: "Кожен редирект витрачає краулінговий бюджет і розмиває сигнали, які визначають позиції." },
    redirect_chain: { title: "Довгий ланцюг редиректів", fix: "Зсилайтеся і редиректьте одразу на кінцевий URL, максимум один перехід.", consequence: "Кожен зайвий перехід сповільнює сайт і може викинути сторінку з видачі." },
    title_missing: { title: "На сторінках немає тега <title>", fix: "Напишіть унікальний title довжиною 50–60 символів для кожної сторінки зі списку.", consequence: "Без title сніпет у пошуку порожній — такі сторінки майже не отримують кліків." },
    title_too_long: { title: "Title задовгі", fix: "Скоротіть title до 50–60 символів, головне слово — на початок.", consequence: "Довгий title обрізається у видачі, і найважливіше — в кінці — не видно." },
    title_too_short: { title: "Title закороткі", fix: "Розширте title до 50–60 символів реальними пошуковими словами, а не лише брендом.", consequence: "З одного слова незрозуміло, про що сторінка, тому клікають рідше." },
    description_missing: { title: "На сторінках немає meta description", fix: "Напишіть опис 150–160 символів для кожної сторінки зі списку.", consequence: "Google збирає сніпет із випадкового тексту сторінки, і результат виглядає гірше, ніж міг би." },
    description_too_long: { title: "Meta description задовгі", fix: "Скоротіть описи до 150–160 символів.", consequence: "Опис обрізається посеред фрази — зазвичай саме там, де заклик до дії." },
    description_too_short: { title: "Meta description закороткі", fix: "Розширте описи до 150–160 символів із конкретною пропозицією.", consequence: "Короткий сніпет витрачає марно місце, яке переконує обрати саме вас." },
    h1_missing: { title: "На сторінках немає заголовка H1", fix: "Додайте рівно один H1, що описує тему сторінки.", consequence: "Без головного заголовка ні люди, ні пошукова система не розуміють, про що сторінка." },
    h1_multiple: { title: "На сторінці більше одного H1", fix: "Залиште один H1, решту знизьте до H2.", consequence: "Кілька H1 розмивають тему сторінки і послаблюють її релевантність." },
    noindex: { title: "Сторінки закриті від індексування (noindex)", fix: "Приберіть директиву noindex з перелічених сторінок, якщо вони мають бути в пошуку.", consequence: "Ці сторінки невидимі для Google: ні показів, ні відвідувачів, ні продажів." },
    canonical_missing: { title: "Немає канонічної адреси (canonical)", fix: "Додайте <link rel=\"canonical\"> із кінцевою адресою кожної сторінки.", consequence: "Без canonical копії сторінки можуть ділити між собою її посилання і позиції." },
    viewport_missing: { title: "Немає мобільного viewport", fix: "Додайте <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">.", consequence: "На телефоні сайт показується зменшеною версією десктопу — більшість мобільних відвідувачів іде." },
    viewport_not_responsive: { title: "Viewport забороняє масштабування на мобільних", fix: "Приберіть user-scalable=no і maximum-scale менше 2 із meta viewport.", consequence: "Користувачі зі слабким зором не можуть збільшити текст — порушення доступності." },
    lang_missing: { title: "Не вказано мову сторінки", fix: "Додайте атрибут lang до <html>, наприклад lang=\"uk\".", consequence: "Скрінрідери обирають не той голос, а пошуковики вгадують мову — і погано." },
    jsonld_invalid: { title: "Пошкоджені структуровані дані (JSON-LD)", fix: "Виправте синтаксис JSON у блоках розмітки schema.org.", consequence: "Невалідна розмітка ігнорується, і сайт втрачає розширені сніпети у видачі." },
    open_graph_incomplete: { title: "Неповні теги Open Graph", fix: "Додайте og:title, og:description і og:image, щоб посилання красиво розгорталися.", consequence: "Посилання в месенджерах і соцмережах показується голим URL замість картки." },
    security_headers_missing: { title: "Не задані заголовки безпеки", fix: "Додайте Content-Security-Policy, X-Content-Type-Options, Referrer-Policy і захист від фреймів.", consequence: "Сайт простіше атакувати впровадженням скриптів і клікджекінгом." },
    slow_response: { title: "Сервер відповідає повільно", fix: "Увімкніть кешування і CDN; мета — відповідь сервера менше 1 секунди.", consequence: "Відвідувачі чекають і йдуть раніше, а пошуковики запам'ятовують повільний досвід." },
    broken_links: { title: "Биті посилання на головній", fix: "Виправте або приберіть мертві посилання зі звіту.", consequence: "І відвідувачі, і роботи впираються в тупики — сайт виглядає покинутим." },
    mixed_content: { title: "Змішаний контент (http://-ресурси на https://-сторінці)", fix: "Завантажуйте всі картинки, скрипти і стилі по https://.", consequence: "Браузер блокує незахищені частини, і сторінка ламається." },
    thin_content: { title: "Дуже мало тексту на сторінках", fix: "Наповніть сторінки корисним змістом — щонайменше 150 слів.", consequence: "«Тонкі» сторінки не ранжуються ні за якими запитами і лише витрачають бюджет обходу." },
    images_no_alt: { title: "Зображення без alt-тексту", fix: "Опишіть кожне значуще зображення в атрибуті alt.", consequence: "Скрінрідер читає ім'я файлу, а пошук по картинкам не розуміє, що на них." },
  },
  consent: "Я погоджуюся на обробку мого e-mail для надсилання звіту про аудит і зв'язку за його результатами.",
  email: {
    subject: (domain, score) => `SEO-аудит ${domain} — оцінка ${score}/100`,
    header: (domain, score) => `SEO-аудит сайту ${domain}: ${score}/100`,
    intro: "Ось що знайшла автоматична перевірка вашого сайту. До кожної проблеми додано, як її виправити.",
    footer: "Звіт створено автоматично інструментом аудиту сайтів і відображає обхід до 5 сторінок на момент перевірки.",
  },
  letter: {
    subject: domain => `Короткий розбір ${domain}`,
    greeting: name => (name ? `Вітаю, ${name}!` : "Вітаю!"),
    intro: (domain, score) => `Ми прогнали швидкий автоматичний аудит ${domain} — оцінка ${score} зі 100. Впадають в око три речі:`,
    offer: "Усе це виправно. Знайдеться 15 хвилин на звонон цього тижня, щоб пройтися списком?",
    closing: "З повагою,",
  },
  proposal: {
    docTitle: domain => `Комерційна пропозиція: SEO для ${domain}`,
    about: "Про нас",
    aboutPlaceholder: "_Розкажіть клієнту, хто ви: досвід, команда, результати на його ринку. Достатньо двох-трьох речень._",
    found: "Що ми знайшли",
    scope: "Обсяг робіт",
    pricing: "Вартість",
    priceNote: "Кожен пункт оцінюється окремо; при замовленні всього списку можлива пакетна знижка.",
    timeline: "Терміни",
    timelinePlaceholder: "_Вкажіть терміни: наприклад, технічні правки — 1 тиждень, контент — 2–3 тижні._",
    nextStep: "Наступний крок",
    nextStepText: "Відповідайте на цей лист або запишіться на дзвінок — почнемо з технічних правок: вони зазвичай дають найшвидший видимий ефект.",
    noPromises: "У цій пропозиції немає обіцянок щодо трафіку, позицій і виручки: обхід до 5 сторінок не може їх обґрунтувати.",
    categories: { crawlability: "Доступність і індексування", metadata: "Мета-теги і структуровані дані", content: "Контент", links: "Посилання", performance: "Швидкість", rendering: "Мобільна адаптація", security: "Безпека" },
  },
  widget: {
    checking: "Перевіряємо…",
    error: "Не вдалося перевірити цей сайт. Перевірте домен і спробуйте ще раз.",
    nameField: "Ваше ім'я (необов'язково)",
    messageField: "Повідомлення (необов'язково)",
    consentLabel: "Погоджуюся на обробку мого e-mail",
    needEmail: "Будь ласка, введіть e-mail",
    sending: "Надсилаємо…",
    again: "Перевірити інший сайт",
  },
  ui: {
    leadSearch: "Пошук за доменом або e-mail",
    leadEmpty: "Лідів поки немає. Встановіть віджет на свій сайт — і вони з'являться тут.",
    leadFilterAll: "Усі",
    leadDate: "Дата",
    leadSource: "Джерело",
    leadStatus: "Статус",
    leadSave: "Зберегти",
    leadSaved: "Збережено",
    leadDownload: "Завантажити HTML",
    leadPrint: "Відкрити і роздрукувати",
    leadMakeClient: "Зробити клієнтом",
    leadInclude: "Включити до пропозиції",
    leadWidgetOn: "Віджет увімкнено",
    leadWidgetAccent: "Колір акценту",
    leadWidgetLogo: "URL логотипа (показується у віджеті)",
    leadWidgetNotify: "Додатковий e-mail для повідомлень про лідів",
    leadWidgetTpl: "Шаблон першого листа ({name}, {domain}, {email}, {score}, {issues})",
    leadWidgetOriginsAny: "Порожньо = віджет можна вставити на будь-який сайт (не рекомендується)",
    leadWidgetRegenConfirm: "Перевипустити ключ? Старий віджет перестане працювати одразу.",
    leadCopied: "Скопійовано",
    leadLoadError: "Не вдалося завантажити лідів",
  },
};

// ─── Français ──────────────────────────────────────────────────────────────────

const FR: LeadStrings = {
  findings: {
    https_unavailable: { title: "Le site ne fonctionne pas en HTTPS", fix: "Installez un certificat SSL/TLS et redirigez toutes les URL http:// vers https://.", consequence: "Le navigateur marque le site « non sécurisé », les visiteurs partent et Google classe les concurrents sécurisés devant." },
    http_error: { title: "Le serveur renvoie une erreur", fix: "Corrigez le statut HTTP des pages listées — elles doivent répondre 200.", consequence: "Les moteurs de recherche retirent les pages en erreur de l'index et le visiteur voit un échec au lieu du site." },
    fetch_failed: { title: "Pages impossibles à charger", fix: "Vérifiez que le serveur répond de façon stable et ne bloque pas les robots.", consequence: "Si notre vérificateur n'a pas pu charger ces pages, les robots des moteurs n'y arriveront probablement pas non plus." },
    redirect: { title: "La page d'accueil redirige ailleurs", fix: "Pointez directement l'adresse canonique : l'accueil doit répondre 200, pas une redirection.", consequence: "Chaque redirection gaspille le budget d'exploration et dilue les signaux qui décident du classement." },
    redirect_chain: { title: "Chaîne de redirections trop longue", fix: "Pointez directement vers l'URL finale, un seul saut au maximum.", consequence: "Chaque saut supplémentaire ralentit le site et peut faire sortir la page des résultats." },
    title_missing: { title: "Pages sans balise <title>", fix: "Rédigez un title unique de 50–60 caractères pour chaque page listée.", consequence: "Sans titre, le résultat de recherche n'a rien à afficher — ces pages ne reçoivent presque aucun clic." },
    title_too_long: { title: "Titres trop longs", fix: "Raccourcissez les titres à 50–60 caractères, mot-clé principal en premier.", consequence: "Les titres trop longs sont coupés dans les résultats et le message perd sa fin." },
    title_too_short: { title: "Titres trop courts", fix: "Étoffez les titres jusqu'à 50–60 caractères avec de vrais mots recherchés.", consequence: "Un titre d'un mot n'explique pas la page, donc moins de clics." },
    description_missing: { title: "Pages sans meta description", fix: "Rédigez une description de 150–160 caractères pour chaque page listée.", consequence: "Google assemble l'extrait depuis un texte quelconque de la page, moins convaincant qu'une vraie description." },
    description_too_long: { title: "Meta descriptions trop longues", fix: "Raccourcissez les descriptions à 150–160 caractères.", consequence: "La description est coupée en plein milieu, juste là où se trouve l'appel à l'action." },
    description_too_short: { title: "Meta descriptions trop courtes", fix: "Étoffez les descriptions jusqu'à 150–160 caractères avec une offre concrète.", consequence: "Un extrait court gaspille l'espace qui convainc l'internaute de vous choisir." },
    h1_missing: { title: "Pages sans titre H1", fix: "Ajoutez exactement un H1 décrivant le sujet de la page.", consequence: "Sans titre principal, ni les gens ni les moteurs ne voient de quoi parle la page." },
    h1_multiple: { title: "Plusieurs H1 sur une page", fix: "Gardez un seul H1 et descendez les autres en H2.", consequence: "Plusieurs H1 brouillent le sujet de la page et affaiblissent sa pertinence." },
    noindex: { title: "Pages exclues de l'indexation (noindex)", fix: "Retirez la directive noindex des pages listées si elles doivent être dans la recherche.", consequence: "Ces pages sont invisibles pour Google : ni impressions, ni visiteurs, ni ventes." },
    canonical_missing: { title: "Pas d'URL canonique", fix: "Ajoutez <link rel=\"canonical\"> pointant vers l'URL finale de chaque page.", consequence: "Sans canonique, des copies de la page peuvent se partager ses signaux de classement." },
    viewport_missing: { title: "Pas de viewport mobile", fix: "Ajoutez <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">.", consequence: "Sur mobile, la page s'affiche en version bureau rétrécie — la plupart des visiteurs partent." },
    viewport_not_responsive: { title: "Le viewport bloque le zoom mobile", fix: "Retirez user-scalable=no et maximum-scale inférieur à 2 du meta viewport.", consequence: "Les malvoyants ne peuvent pas agrandir le texte — un échec d'accessibilité." },
    lang_missing: { title: "Langue de la page non déclarée", fix: "Ajoutez l'attribut lang à <html>, par exemple lang=\"fr\".", consequence: "Les lecteurs d'écran choisissent la mauvaise voix et les moteurs devinent mal la langue." },
    jsonld_invalid: { title: "Données structurées invalides (JSON-LD)", fix: "Corrigez la syntaxe JSON des blocs schema.org.", consequence: "Le balisage invalide est ignoré et le site perd ses résultats enrichis." },
    open_graph_incomplete: { title: "Balises Open Graph incomplètes", fix: "Ajoutez og:title, og:description et og:image pour de beaux aperçus de liens.", consequence: "Les liens partagés dans les messageries montrent une URL nue au lieu d'une carte." },
    security_headers_missing: { title: "En-têtes de sécurité absents", fix: "Ajoutez Content-Security-Policy, X-Content-Type-Options, Referrer-Policy et la protection contre l'encadrement.", consequence: "Le site est plus vulnérable aux scripts injectés et au clickjacking." },
    slow_response: { title: "Le serveur répond lentement", fix: "Activez le cache et un CDN ; visez une réponse serveur sous la seconde.", consequence: "Les visiteurs attendent, partent plus tôt, et les moteurs notent la lenteur." },
    broken_links: { title: "Liens cassés sur la page d'accueil", fix: "Corrigez ou supprimez les liens morts listés dans le rapport.", consequence: "Visiteurs et robots se heurtent à des impasses — le site paraît abandonné." },
    mixed_content: { title: "Contenu mixte (ressources http:// sur une page https://)", fix: "Chargez toutes les images, scripts et styles en https://.", consequence: "Le navigateur bloque les parties non sécurisées et la page se casse." },
    thin_content: { title: "Très peu de texte sur les pages", fix: "Étoffez les pages listées d'un contenu utile — au moins 150 mots.", consequence: "Les pages maigres ne se classent sur aucune requête et consument le budget d'exploration." },
    images_no_alt: { title: "Images sans texte alternatif", fix: "Décrivez chaque image significative dans son attribut alt.", consequence: "Les lecteurs d'écran lisent un nom de fichier et la recherche d'images ne comprend rien." },
  },
  consent: "J'accepte que mon e-mail soit utilisé pour m'envoyer le rapport d'audit et être contacté à ce sujet.",
  email: {
    subject: (domain, score) => `Audit SEO de ${domain} — note ${score}/100`,
    header: (domain, score) => `Audit SEO de ${domain} : ${score}/100`,
    intro: "Voici ce que le contrôle automatique de votre site a trouvé. Chaque point inclut comment le corriger.",
    footer: "Rapport généré automatiquement par un outil d'audit de sites ; il reflète l'exploration de 5 pages au moment du contrôle.",
  },
  letter: {
    subject: domain => `Un regard rapide sur ${domain}`,
    greeting: name => (name ? `Bonjour ${name},` : "Bonjour,"),
    intro: (domain, score) => `Nous avons passé ${domain} au contrôle automatique — note ${score} sur 100. Trois points ressortent :`,
    offer: "Tout cela se corrige. Auriez-vous 15 minutes cette semaine pour en parler au téléphone ?",
    closing: "Cordialement,",
  },
  proposal: {
    docTitle: domain => `Proposition SEO pour ${domain}`,
    about: "À propos de nous",
    aboutPlaceholder: "_Présentez-vous au client : expérience, équipe, résultats sur son marché. Deux ou trois phrases suffisent._",
    found: "Ce que nous avons trouvé",
    scope: "Périmètre des travaux",
    pricing: "Tarifs",
    priceNote: "Chaque poste est facturé séparément ; une remise forfaitaire est possible si tout est pris d'un coup.",
    timeline: "Délais",
    timelinePlaceholder: "_Fixez les délais : par exemple, correctifs techniques — 1 semaine, contenu — 2–3 semaines._",
    nextStep: "Prochaine étape",
    nextStepText: "Répondez à cette proposition ou réservez un appel : nous commençons par les correctifs techniques, aux effets les plus rapides.",
    noPromises: "Cette proposition ne promet aucun chiffre de trafic, de position ou de revenus : l'exploration de 5 pages ne peut pas les justifier.",
    categories: { crawlability: "Explorabilité et indexation", metadata: "Métadonnées et données structurées", content: "Contenu", links: "Liens", performance: "Vitesse", rendering: "Rendu mobile", security: "Sécurité" },
  },
  widget: {
    checking: "Vérification…",
    error: "Impossible de vérifier ce site. Vérifiez le domaine et réessayez.",
    nameField: "Votre nom (facultatif)",
    messageField: "Message (facultatif)",
    consentLabel: "J'accepte le traitement de mon e-mail",
    needEmail: "Merci de saisir votre e-mail",
    sending: "Envoi…",
    again: "Vérifier un autre site",
  },
  ui: {
    leadSearch: "Rechercher domaine ou e-mail",
    leadEmpty: "Aucun lead pour l'instant. Installez le widget sur votre site et ils apparaîtront ici.",
    leadFilterAll: "Tous",
    leadDate: "Date",
    leadSource: "Source",
    leadStatus: "Statut",
    leadSave: "Enregistrer",
    leadSaved: "Enregistré",
    leadDownload: "Télécharger HTML",
    leadPrint: "Ouvrir et imprimer",
    leadMakeClient: "Convertir en client",
    leadInclude: "Inclure dans la proposition",
    leadWidgetOn: "Widget activé",
    leadWidgetAccent: "Couleur d'accent",
    leadWidgetLogo: "URL du logo (affiché dans le widget)",
    leadWidgetNotify: "E-mail supplémentaire pour les notifications",
    leadWidgetTpl: "Modèle de première lettre ({name}, {domain}, {email}, {score}, {issues})",
    leadWidgetOriginsAny: "Vide = n'importe quel site peut intégrer le widget (déconseillé)",
    leadWidgetRegenConfirm: "Régénérer la clé ? L'ancien widget cessera immédiatement de fonctionner.",
    leadCopied: "Copié",
    leadLoadError: "Impossible de charger les leads",
  },
};

// ─── Español ───────────────────────────────────────────────────────────────────

const ES: LeadStrings = {
  findings: {
    https_unavailable: { title: "El sitio no funciona con HTTPS", fix: "Instala un certificado SSL/TLS y redirige todas las URL http:// a https://.", consequence: "El navegador marca el sitio como «no seguro», los visitantes se van y Google posiciona antes a la competencia segura." },
    http_error: { title: "El servidor devuelve un error", fix: "Corrige el estado HTTP de las páginas indicadas: deben responder 200.", consequence: "Los buscadores sacan de su índice las páginas con error y el visitante ve un fallo en lugar del sitio." },
    fetch_failed: { title: "No se pudieron cargar páginas", fix: "Comprueba que el servidor responde de forma estable y no bloquea rastreadores.", consequence: "Si nuestro comprobador no pudo cargar estas páginas, los robots de los buscadores probablemente tampoco." },
    redirect: { title: "La página principal redirige a otra dirección", fix: "Apunta directamente a la dirección canónica: la home debe responder 200, no una redirección.", consequence: "Cada redirección gasta presupuesto de rastreo y diluye las señales que deciden la posición." },
    redirect_chain: { title: "Cadena de redirecciones demasiado larga", fix: "Enlaza y redirige directo a la URL final, un solo salto como máximo.", consequence: "Cada salto extra ralentiza el sitio y puede sacar la página de los resultados." },
    title_missing: { title: "Páginas sin etiqueta <title>", fix: "Escribe un title único de 50–60 caracteres para cada página indicada.", consequence: "Sin título, el resultado de búsqueda no tiene nada que mostrar: esas páginas apenas reciben clics." },
    title_too_long: { title: "Títulos demasiado largos", fix: "Acorta los títulos a 50–60 caracteres, con la palabra clave al principio.", consequence: "Los títulos largos se cortan en los resultados y el mensaje pierde su final." },
    title_too_short: { title: "Títulos demasiado cortos", fix: "Amplía los títulos a 50–60 caracteres con palabras reales de búsqueda.", consequence: "Un título de una palabra no explica la página y recibe menos clics." },
    description_missing: { title: "Páginas sin meta description", fix: "Escribe una descripción de 150–160 caracteres para cada página indicada.", consequence: "Google monta el snippet con texto cualquiera de la página y queda peor de lo que podría." },
    description_too_long: { title: "Meta descriptions demasiado largas", fix: "Recorta las descripciones a 150–160 caracteres.", consequence: "La descripción se corta a mitad de frase, justo donde suele estar la llamada a la acción." },
    description_too_short: { title: "Meta descriptions demasiado cortas", fix: "Amplía las descripciones a 150–160 caracteres con una oferta concreta.", consequence: "Un snippet corto desperdicia el espacio que convence de elegirte." },
    h1_missing: { title: "Páginas sin encabezado H1", fix: "Añade exactamente un H1 que describa el tema de la página.", consequence: "Sin encabezado principal, ni las personas ni los buscadores ven de qué va la página." },
    h1_multiple: { title: "Más de un H1 en una página", fix: "Deja un solo H1 y baja los demás a H2.", consequence: "Varios H1 difuminan el tema de la página y debilitan su relevancia." },
    noindex: { title: "Páginas bloqueadas para indexación (noindex)", fix: "Quita la directiva noindex de las páginas indicadas si deben aparecer en el buscador.", consequence: "Estas páginas son invisibles para Google: sin impresiones, sin visitas, sin ventas." },
    canonical_missing: { title: "Sin URL canónica", fix: "Añade <link rel=\"canonical\"> con la URL final de cada página.", consequence: "Sin canonical, copias de la página pueden repartirse sus señales de posicionamiento." },
    viewport_missing: { title: "Sin viewport móvil", fix: "Añade <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">.", consequence: "En el móvil la página se ve como el escritorio encogido: la mayoría de visitas se van." },
    viewport_not_responsive: { title: "El viewport bloquea el zoom en móvil", fix: "Quita user-scalable=no y maximum-scale menor que 2 del meta viewport.", consequence: "Los usuarios con poca visión no pueden ampliar el texto: un fallo de accesibilidad." },
    lang_missing: { title: "Idioma de la página sin declarar", fix: "Añade el atributo lang al <html>, por ejemplo lang=\"es\".", consequence: "Los lectores de pantalla eligen la voz equivocada y los buscadores adivinan mal el idioma." },
    jsonld_invalid: { title: "Datos estructurados rotos (JSON-LD)", fix: "Corrige la sintaxis JSON de los bloques schema.org.", consequence: "El marcado inválido se ignora y el sitio pierde los resultados enriquecidos." },
    open_graph_incomplete: { title: "Etiquetas Open Graph incompletas", fix: "Añade og:title, og:description y og:image para vistas previas correctas.", consequence: "Los enlaces compartidos en mensajería muestran una URL desnuda en vez de una tarjeta." },
    security_headers_missing: { title: "Faltan cabeceras de seguridad", fix: "Añade Content-Security-Policy, X-Content-Type-Options, Referrer-Policy y protección contra marcos.", consequence: "El sitio es más fácil de atacar con scripts inyectados y clickjacking." },
    slow_response: { title: "El servidor responde lento", fix: "Activa caché y un CDN; apunta a una respuesta de servidor inferior a 1 segundo.", consequence: "Los visitantes esperan, se van antes y los buscadores anotan la lentitud." },
    broken_links: { title: "Enlaces rotos en la página principal", fix: "Corrige o elimina los enlaces muertos del informe.", consequence: "Visitantes y robots se chocan con callejones sin salida: el sitio parece abandonado." },
    mixed_content: { title: "Contenido mixto (recursos http:// en una página https://)", fix: "Carga todas las imágenes, scripts y estilos por https://.", consequence: "El navegador bloquea las partes inseguras y la página se rompe." },
    thin_content: { title: "Muy poco texto en las páginas", fix: "Amplía las páginas indicadas con contenido útil: al menos 150 palabras.", consequence: "Las páginas finas no posicionan para nada y solo consumen presupuesto de rastreo." },
    images_no_alt: { title: "Imágenes sin texto alt", fix: "Describe cada imagen significativa en su atributo alt.", consequence: "Los lectores de pantalla leen un nombre de archivo y la búsqueda de imágenes no entiende nada." },
  },
  consent: "Acepto que mi e-mail se use para enviarme el informe de auditoría y para contactarme al respecto.",
  email: {
    subject: (domain, score) => `Auditoría SEO de ${domain} — puntuación ${score}/100`,
    header: (domain, score) => `Auditoría SEO de ${domain}: ${score}/100`,
    intro: "Esto es lo que encontró la comprobación automática de tu web. Cada punto incluye cómo arreglarlo.",
    footer: "Informe generado automáticamente por una herramienta de auditoría web; refleja el rastreo de hasta 5 páginas en el momento de la comprobación.",
  },
  letter: {
    subject: domain => `Un vistazo rápido a ${domain}`,
    greeting: name => (name ? `Hola, ${name}:` : "Hola:"),
    intro: (domain, score) => `Pasamos ${domain} por una comprobación automática — puntuación ${score} de 100. Destacan tres cosas:`,
    offer: "Todo tiene arreglo. ¿Tienes 15 minutos esta semana para una llamada y repasarlas?",
    closing: "Un saludo,",
  },
  proposal: {
    docTitle: domain => `Propuesta SEO para ${domain}`,
    about: "Sobre nosotros",
    aboutPlaceholder: "_Cuéntale al cliente quién sois: experiencia, equipo, resultados en su mercado. Dos o tres frases bastan._",
    found: "Lo que encontramos",
    scope: "Alcance del trabajo",
    pricing: "Precios",
    priceNote: "Cada punto se presupuesta aparte; si se contrata todo junto, es posible un descuento por paquete.",
    timeline: "Plazos",
    timelinePlaceholder: "_Fija los plazos: por ejemplo, arreglos técnicos — 1 semana, contenido — 2–3 semanas._",
    nextStep: "Siguiente paso",
    nextStepText: "Responde a esta propuesta o reserva una llamada: empezamos por los arreglos técnicos, que suelen dar el cambio visible más rápido.",
    noPromises: "Esta propuesta no promete cifras de tráfico, posiciones ni ingresos: el rastreo de 5 páginas no puede sustentarlas.",
    categories: { crawlability: "Rastreabilidad e indexación", metadata: "Metadatos y datos estructurados", content: "Contenido", links: "Enlaces", performance: "Velocidad", rendering: "Adaptación móvil", security: "Seguridad" },
  },
  widget: {
    checking: "Comprobando…",
    error: "No se pudo comprobar este sitio. Revisa el dominio e inténtalo de nuevo.",
    nameField: "Tu nombre (opcional)",
    messageField: "Mensaje (opcional)",
    consentLabel: "Acepto el tratamiento de mi e-mail",
    needEmail: "Introduce tu e-mail",
    sending: "Enviando…",
    again: "Comprobar otro sitio",
  },
  ui: {
    leadSearch: "Buscar dominio o e-mail",
    leadEmpty: "Aún no hay leads. Instala el widget en tu web y aparecerán aquí.",
    leadFilterAll: "Todos",
    leadDate: "Fecha",
    leadSource: "Origen",
    leadStatus: "Estado",
    leadSave: "Guardar",
    leadSaved: "Guardado",
    leadDownload: "Descargar HTML",
    leadPrint: "Abrir e imprimir",
    leadMakeClient: "Convertir en cliente",
    leadInclude: "Incluir en la propuesta",
    leadWidgetOn: "Widget activado",
    leadWidgetAccent: "Color de acento",
    leadWidgetLogo: "URL del logotipo (se muestra en el widget)",
    leadWidgetNotify: "E-mail adicional para avisos de leads",
    leadWidgetTpl: "Plantilla de primera carta ({name}, {domain}, {email}, {score}, {issues})",
    leadWidgetOriginsAny: "Vacío = el widget se puede incrustar en cualquier sitio (no recomendado)",
    leadWidgetRegenConfirm: "¿Regenerar la clave? El widget antiguo dejará de funcionar al instante.",
    leadCopied: "Copiado",
    leadLoadError: "No se pudieron cargar los leads",
  },
};

// ─── Deutsch ───────────────────────────────────────────────────────────────────

const DE: LeadStrings = {
  findings: {
    https_unavailable: { title: "Die Seite funktioniert nicht über HTTPS", fix: "Installieren Sie ein SSL/TLS-Zertifikat und leiten Sie alle http://-URLs auf https:// weiter.", consequence: "Der Browser kennzeichnet die Seite als „nicht sicher“, Besucher gehen, und Google rangiert die sicheren Konkurrenten davor." },
    http_error: { title: "Der Server liefert einen Fehler", fix: "Korrigieren Sie den HTTP-Status der gelisteten Seiten — sie müssen mit 200 antworten.", consequence: "Suchmaschinen werfen Fehlerseiten aus dem Index, und der Besucher sieht einen Absturz statt der Seite." },
    fetch_failed: { title: "Seiten konnten nicht geladen werden", fix: "Prüfen Sie, dass der Server stabil antwortet und Crawler nicht blockiert.", consequence: "Wenn unser Prüfer diese Seiten nicht laden konnte, können es die Suchmaschinen-Roboter vermutlich auch nicht." },
    redirect: { title: "Die Startseite leitet woanders hin", fix: "Zielen Sie direkt auf die kanonische Adresse: Die Startseite soll mit 200 antworten, nicht mit einer Weiterleitung.", consequence: "Jede Weiterleitung verbraucht Crawling-Budget und verwässert die Signale, die über Rankings entscheiden." },
    redirect_chain: { title: "Zu lange Weiterleitungskette", fix: "Verlinken und leiten Sie direkt auf die finale URL, höchstens ein Sprung.", consequence: "Jeder zusätzliche Sprung verlangsamt die Seite und kann sie aus den Ergebnissen werfen." },
    title_missing: { title: "Seiten ohne <title>-Tag", fix: "Schreiben Sie für jede gelistete Seite einen eindeutigen Title mit 50–60 Zeichen.", consequence: "Ohne Title hat das Suchergebnis nichts zu zeigen — solche Seiten bekommen kaum Klicks." },
    title_too_long: { title: "Titles sind zu lang", fix: "Kürzen Sie die Titles auf 50–60 Zeichen, Hauptkeyword nach vorn.", consequence: "Zu lange Titles werden abgeschnitten, und die Botschaft verliert ihr Ende." },
    title_too_short: { title: "Titles sind zu kurz", fix: "Erweitern Sie die Titles auf 50–60 Zeichen mit echten Suchbegriffen.", consequence: "Ein Ein-Wort-Title erklärt die Seite nicht, also wird seltener geklickt." },
    description_missing: { title: "Seiten ohne Meta-Description", fix: "Schreiben Sie für jede gelistete Seite eine Description mit 150–160 Zeichen.", consequence: "Google baut den Snippet aus beliebigem Seitentext, und das liest sich schlechter als nötig." },
    description_too_long: { title: "Meta-Descriptions sind zu lang", fix: "Kürzen Sie die Descriptions auf 150–160 Zeichen.", consequence: "Die Description wird mitten im Satz abgeschnitten — genau dort, wo sonst der Call-to-Action steht." },
    description_too_short: { title: "Meta-Descriptions sind zu kurz", fix: "Erweitern Sie die Descriptions auf 150–160 Zeichen mit einem konkreten Angebot.", consequence: "Ein kurzer Snippet verschenkt den Platz, der den Suchenden von Ihnen überzeugt." },
    h1_missing: { title: "Seiten ohne H1-Überschrift", fix: "Fügen Sie genau ein H1 hinzu, das das Thema der Seite beschreibt.", consequence: "Ohne Hauptüberschrift verstehen weder Menschen noch Suchmaschinen, worum es geht." },
    h1_multiple: { title: "Mehr als ein H1 auf einer Seite", fix: "Behalten Sie ein H1, die restlichen als H2 abstufen.", consequence: "Mehrere H1 verwischen das Thema und schwächen die Relevanzsignale." },
    noindex: { title: "Seiten sind von der Indexierung ausgeschlossen (noindex)", fix: "Entfernen Sie die noindex-Anweisung auf den gelisteten Seiten, wenn sie in die Suche sollen.", consequence: "Diese Seiten sind für Google unsichtbar: keine Impressionen, keine Besucher, keine Verkäufe." },
    canonical_missing: { title: "Keine Canonical-URL", fix: "Fügen Sie <link rel=\"canonical\"> mit der finalen URL jeder Seite hinzu.", consequence: "Ohne Canonical können Kopien der Seite ihre Ranking-Signale aufteilen." },
    viewport_missing: { title: "Kein mobiler Viewport", fix: "Fügen Sie <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> hinzu.", consequence: "Auf dem Handy erscheint die geschrumpfte Desktop-Ansicht — die meisten mobilen Besucher gehen." },
    viewport_not_responsive: { title: "Der Viewport blockiert den Mobilen Zoom", fix: "Entfernen Sie user-scalable=no und maximum-scale unter 2 aus dem Meta-Viewport.", consequence: "Sehbehinderte können den Text nicht vergrößern — ein Barrierefreiheitsmangel." },
    lang_missing: { title: "Sprache der Seite ist nicht angegeben", fix: "Fügen Sie das lang-Attribut in <html> ein, z. B. lang=\"de\".", consequence: "Screenreader wählen die falsche Stimme, und Suchmaschinen raten die Sprache — schlecht." },
    jsonld_invalid: { title: "Defekte strukturierte Daten (JSON-LD)", fix: "Korrigieren Sie die JSON-Syntax der schema.org-Blöcke.", consequence: "Ungültiges Markup wird ignoriert, und die Seite verliert Rich Results." },
    open_graph_incomplete: { title: "Unvollständige Open-Graph-Tags", fix: "Ergänzen Sie og:title, og:description und og:image für korrekte Linkvorschauen.", consequence: "Geteilte Links in Messengern zeigen eine nackte URL statt einer Karte." },
    security_headers_missing: { title: "Sicherheits-Header fehlen", fix: "Fügen Sie Content-Security-Policy, X-Content-Type-Options, Referrer-Policy und Frame-Schutz hinzu.", consequence: "Die Seite ist leichter per eingeschleuster Skripte und Clickjacking anzugreifen." },
    slow_response: { title: "Der Server antwortet langsam", fix: "Aktivieren Sie Caching und ein CDN; Ziel ist eine Serverantwort unter 1 Sekunde.", consequence: "Besucher warten, gehen früher, und Suchmaschinen merken sich die Langsamkeit." },
    broken_links: { title: "Tote Links auf der Startseite", fix: "Korrigieren oder entfernen Sie die toten Links aus dem Bericht.", consequence: "Besucher und Crawler laufen gegen Sackgassen — die Seite wirkt verlassen." },
    mixed_content: { title: "Gemischte Inhalte (http://-Ressourcen auf einer https://-Seite)", fix: "Laden Sie alle Bilder, Skripte und Styles über https://.", consequence: "Der Browser blockiert die unsicheren Teile, und die Seite bricht." },
    thin_content: { title: "Sehr wenig Text auf den Seiten", fix: "Bauen Sie die gelisteten Seiten mit nützlichem Inhalt aus — mindestens 150 Wörter.", consequence: "Dünne Seiten ranken für nichts und verbrauchen nur Crawling-Budget." },
    images_no_alt: { title: "Bilder ohne Alt-Text", fix: "Beschreiben Sie jedes bedeutende Bild im alt-Attribut.", consequence: "Screenreader lesen einen Dateinamen, und die Bildersuche versteht die Bilder nicht." },
  },
  consent: "Ich bin damit einverstanden, dass meine E-Mail-Adresse für den Versand des Auditberichts und die Kontaktaufnahme dazu verwendet wird.",
  email: {
    subject: (domain, score) => `SEO-Audit von ${domain} — Score ${score}/100`,
    header: (domain, score) => `SEO-Audit von ${domain}: ${score}/100`,
    intro: "Das hat die automatische Prüfung Ihrer Website gefunden. Zu jedem Punkt steht, wie man ihn behebt.",
    footer: "Dieser Bericht wurde automatisch von einem Website-Audit-Tool erzeugt; er bildet einen Abruf von bis zu 5 Seiten zum Prüfzeitpunkt ab.",
  },
  letter: {
    subject: domain => `Ein kurzer Blick auf ${domain}`,
    greeting: name => (name ? `Hallo ${name},` : "Hallo,"),
    intro: (domain, score) => `Wir haben ${domain} automatisch geprüft — Score ${score} von 100. Drei Dinge stechen hervor:`,
    offer: "All das ist behebbar. Hätten Sie diese Woche 15 Minuten für einen kurzen Anruf?",
    closing: "Beste Grüße,",
  },
  proposal: {
    docTitle: domain => `SEO-Angebot für ${domain}`,
    about: "Über uns",
    aboutPlaceholder: "_Stellen Sie sich dem Kunden vor: Erfahrung, Team, Ergebnisse in seinem Markt. Zwei, drei Sätze genügen._",
    found: "Was wir gefunden haben",
    scope: "Leistungsumfang",
    pricing: "Preise",
    priceNote: "Jeder Punkt wird separat kalkuliert; bei Abnahme des gesamten Pakets ist ein Rabatt möglich.",
    timeline: "Zeitplan",
    timelinePlaceholder: "_Setzen Sie die Termine: z. B. technische Korrekturen — 1 Woche, Inhalte — 2–3 Wochen._",
    nextStep: "Nächster Schritt",
    nextStepText: "Antworten Sie auf dieses Angebot oder buchen Sie ein Gespräch — wir starten mit den technischen Korrekturen, die meist den schnellsten sichtbaren Effekt bringen.",
    noPromises: "Dieses Angebot verspricht keine Zahlen zu Traffic, Rankings oder Umsatz: ein Abruf von bis zu 5 Seiten kann sie nicht begründen.",
    categories: { crawlability: "Crawlbarkeit und Indexierung", metadata: "Meta-Tags und strukturierte Daten", content: "Inhalte", links: "Links", performance: "Geschwindigkeit", rendering: "Mobile Darstellung", security: "Sicherheit" },
  },
  widget: {
    checking: "Prüfen…",
    error: "Diese Website konnte nicht geprüft werden. Domain prüfen und erneut versuchen.",
    nameField: "Ihr Name (optional)",
    messageField: "Nachricht (optional)",
    consentLabel: "Ich stimme der Verarbeitung meiner E-Mail zu",
    needEmail: "Bitte geben Sie Ihre E-Mail-Adresse ein",
    sending: "Senden…",
    again: "Andere Website prüfen",
  },
  ui: {
    leadSearch: "Domain oder E-Mail suchen",
    leadEmpty: "Noch keine Leads. Bauen Sie das Widget in Ihre Website ein, dann erscheinen sie hier.",
    leadFilterAll: "Alle",
    leadDate: "Datum",
    leadSource: "Quelle",
    leadStatus: "Status",
    leadSave: "Speichern",
    leadSaved: "Gespeichert",
    leadDownload: "HTML herunterladen",
    leadPrint: "Öffnen und drucken",
    leadMakeClient: "Zum Kunden machen",
    leadInclude: "Ins Angebot aufnehmen",
    leadWidgetOn: "Widget aktiviert",
    leadWidgetAccent: "Akzentfarbe",
    leadWidgetLogo: "Logo-URL (im Widget sichtbar)",
    leadWidgetNotify: "Zusätzliche E-Mail für Lead-Benachrichtigungen",
    leadWidgetTpl: "Vorlage des ersten Briefs ({name}, {domain}, {email}, {score}, {issues})",
    leadWidgetOriginsAny: "Leer = das Widget kann überall eingebettet werden (nicht empfohlen)",
    leadWidgetRegenConfirm: "Schlüssel neu erzeugen? Das alte Widget hört sofort auf zu funktionieren.",
    leadCopied: "Kopiert",
    leadLoadError: "Leads konnten nicht geladen werden",
  },
};

// ─── 中文 ──────────────────────────────────────────────────────────────────────

const ZH: LeadStrings = {
  findings: {
    https_unavailable: { title: "网站不支持 HTTPS", fix: "安装 SSL/TLS 证书，并把所有 http:// 地址跳转到 https://。", consequence: "浏览器会把网站标记为“不安全”，访客流失，Google 也会把启用加密的竞争对手排在前面。" },
    http_error: { title: "服务器返回错误", fix: "修复所列页面的 HTTP 状态码——它们应返回 200。", consequence: "搜索引擎会把报错页面移出索引，访客看到的也是错误而不是网站。" },
    fetch_failed: { title: "页面无法加载", fix: "检查服务器是否稳定响应、是否屏蔽了爬虫。", consequence: "如果我们的检测器加载不了这些页面，搜索引擎的爬虫多半也不行。" },
    redirect: { title: "首页跳转到其他地址", fix: "直接指向规范地址：首页应返回 200，而不是跳转。", consequence: "每一次跳转都消耗抓取预算，并稀释决定排名的信号。" },
    redirect_chain: { title: "跳转链过长", fix: "链接和跳转都直接指向最终 URL，最多一跳。", consequence: "每多一跳都拖慢网站，还可能让页面掉出搜索结果。" },
    title_missing: { title: "页面缺少 <title> 标签", fix: "为所列每个页面写一个 50–60 字符的唯一标题。", consequence: "没有标题，搜索结果就没有可展示的内容——这类页面几乎得不到点击。" },
    title_too_long: { title: "标题过长", fix: "把标题缩短到 50–60 字符，主要关键词放在最前面。", consequence: "过长的标题在搜索结果中被截断，重要信息恰好在看不见的后半段。" },
    title_too_short: { title: "标题过短", fix: "把标题扩充到 50–60 字符，使用真实的搜索词。", consequence: "一个词的标题说不清页面内容，点击率自然低。" },
    description_missing: { title: "页面缺少 meta description", fix: "为所列每个页面写 150–160 字符的描述。", consequence: "Google 会从页面任意文字拼凑摘要，效果不如一段像样的描述。" },
    description_too_long: { title: "meta description 过长", fix: "把描述缩短到 150–160 字符。", consequence: "描述在句子中间被截断——通常正好是行动号召所在的位置。" },
    description_too_short: { title: "meta description 过短", fix: "把描述扩充到 150–160 字符，写明具体卖点。", consequence: "过短的摘要浪费了说服搜索者选择你的空间。" },
    h1_missing: { title: "页面缺少 H1 标题", fix: "为每个页面添加唯一一个描述主题的 H1。", consequence: "没有主标题，用户和搜索引擎都看不出页面在讲什么。" },
    h1_multiple: { title: "一个页面有多个 H1", fix: "保留一个 H1，其余降为 H2。", consequence: "多个 H1 会模糊页面主题，削弱相关性信号。" },
    noindex: { title: "页面被禁止收录（noindex）", fix: "如果这些页面应出现在搜索中，请移除其 noindex 指令。", consequence: "这些页面在 Google 眼里不存在：没有展示、没有访客、没有销售。" },
    canonical_missing: { title: "缺少 canonical 地址", fix: "为每个页面添加指向其最终 URL 的 <link rel=\"canonical\">。", consequence: "没有 canonical，页面的副本可能瓜分它的排名信号。" },
    viewport_missing: { title: "缺少移动端 viewport", fix: "添加 <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">。", consequence: "手机上显示的是缩小版桌面布局——多数移动访客直接离开。" },
    viewport_not_responsive: { title: "viewport 禁止移动端缩放", fix: "从 viewport 标签中移除 user-scalable=no 和小于 2 的 maximum-scale。", consequence: "视力不佳的用户无法放大文字——这是无障碍缺陷。" },
    lang_missing: { title: "未声明页面语言", fix: "给 <html> 加上 lang 属性，例如 lang=\"zh\"。", consequence: "屏幕阅读器选错语音，搜索引擎也只能瞎猜语言。" },
    jsonld_invalid: { title: "结构化数据（JSON-LD）损坏", fix: "修复 schema.org 代码块的 JSON 语法。", consequence: "无效的标记会被忽略，网站因此失去搜索结果中的富摘要。" },
    open_graph_incomplete: { title: "Open Graph 标签不完整", fix: "补齐 og:title、og:description 和 og:image，让链接能正确预览。", consequence: "在聊天工具和社交平台分享时只显示光秃秃的 URL，而不是卡片。" },
    security_headers_missing: { title: "缺少安全响应头", fix: "添加 Content-Security-Policy、X-Content-Type-Options、Referrer-Policy 和防嵌入保护。", consequence: "网站更容易被脚本注入和点击劫持攻击。" },
    slow_response: { title: "服务器响应缓慢", fix: "启用缓存和 CDN；目标是服务器响应低于 1 秒。", consequence: "访客等待后提前离开，搜索引擎也会记住这种慢体验。" },
    broken_links: { title: "首页存在死链", fix: "修复或删除报告中列出的失效链接。", consequence: "访客和爬虫都会撞上死胡同——网站看起来无人维护。" },
    mixed_content: { title: "混合内容（https:// 页面引用 http:// 资源）", fix: "所有图片、脚本和样式都通过 https:// 加载。", consequence: "浏览器会拦截不安全的部分，页面外观和功能随之破损。" },
    thin_content: { title: "页面文字太少", fix: "为所列页面补充有价值的内容——至少 150 词。", consequence: "单薄的页面在任何关键词下都没有排名，只是白白消耗抓取预算。" },
    images_no_alt: { title: "图片缺少 alt 文本", fix: "为每张有意义的图片填写 alt 属性。", consequence: "屏幕阅读器只能读出文件名，图片搜索也无法理解图片内容。" },
  },
  consent: "我同意使用我的电子邮箱接收审计报告，并就此与我联系。",
  email: {
    subject: (domain, score) => `${domain} 的 SEO 审计 — 得分 ${score}/100`,
    header: (domain, score) => `${domain} 的 SEO 审计：${score}/100`,
    intro: "以下是自动检查您的网站发现的问题，每一条都附带了修复方法。",
    footer: "本报告由网站审计工具自动生成，反映检查时对最多 5 个页面的抓取结果。",
  },
  letter: {
    subject: domain => `对 ${domain} 的快速体检`,
    greeting: name => (name ? `${name}，您好：` : "您好："),
    intro: (domain, score) => `我们对 ${domain} 做了一次快速自动检查——得分 ${score}/100。有三个问题比较突出：`,
    offer: "这些问题都可以修复。本周是否方便安排 15 分钟通话，一起过一遍这份清单？",
    closing: "顺祝商祺，",
  },
  proposal: {
    docTitle: domain => `${domain} 的 SEO 服务提案`,
    about: "关于我们",
    aboutPlaceholder: "_向客户介绍你自己：经验、团队、在其市场的成果。两三句话即可。_",
    found: "我们发现的问题",
    scope: "工作范围",
    pricing: "报价",
    priceNote: "每项单独计价；整体打包委托可享优惠。",
    timeline: "时间安排",
    timelinePlaceholder: "_填写周期：例如技术修复——1 周，内容——2–3 周。_",
    nextStep: "下一步",
    nextStepText: "回复本提案或预约通话即可。我们会从技术修复开始——它们通常带来最快的可见变化。",
    noPromises: "本提案不承诺任何流量、排名或收入数字：最多 5 个页面的抓取无法支撑这类承诺。",
    categories: { crawlability: "抓取与收录", metadata: "元标签与结构化数据", content: "内容", links: "链接", performance: "速度", rendering: "移动端适配", security: "安全" },
  },
  widget: {
    checking: "检查中…",
    error: "无法检查该网站。请核对域名后重试。",
    nameField: "您的称呼（选填）",
    messageField: "留言（选填）",
    consentLabel: "我同意处理我的电子邮箱",
    needEmail: "请输入您的电子邮箱",
    sending: "发送中…",
    again: "检查另一个网站",
  },
  ui: {
    leadSearch: "搜索域名或邮箱",
    leadEmpty: "暂时没有销售线索。把小组件嵌入你的网站后，线索会出现在这里。",
    leadFilterAll: "全部",
    leadDate: "日期",
    leadSource: "来源",
    leadStatus: "状态",
    leadSave: "保存",
    leadSaved: "已保存",
    leadDownload: "下载 HTML",
    leadPrint: "打开并打印",
    leadMakeClient: "转为客户",
    leadInclude: "纳入提案",
    leadWidgetOn: "小组件已启用",
    leadWidgetAccent: "强调色",
    leadWidgetLogo: "Logo 地址（显示在小组件中）",
    leadWidgetNotify: "接收线索通知的额外邮箱",
    leadWidgetTpl: "首封邮件模板（{name}、{domain}、{email}、{score}、{issues}）",
    leadWidgetOriginsAny: "留空 = 任何网站都能嵌入该小组件（不推荐）",
    leadWidgetRegenConfirm: "重新生成密钥？旧的小组件会立即失效。",
    leadCopied: "已复制",
    leadLoadError: "无法加载销售线索",
  },
};

export const LEAD_STRINGS: Record<LeadLang, LeadStrings> = { en: EN, ru: RU, uk: UK, fr: FR, es: ES, de: DE, zh: ZH };

import type { LeadFinding, RawFinding } from "./types";

/** Attach the widget language's title/fix to raw findings (consequence stays in the dictionary). */
export function localizeFindings(raw: RawFinding[], lang: LeadLang): LeadFinding[] {
  const dict = LEAD_STRINGS[lang].findings;
  const en = EN.findings;
  return raw.map(f => ({
    ...f,
    title: dict[f.code]?.title ?? en[f.code]?.title ?? f.code,
    fix: dict[f.code]?.fix ?? en[f.code]?.fix ?? "",
  }));
}

/** A finding's plain-language consequence, used by the proposal builder. */
export function consequenceOf(code: string, lang: LeadLang): string {
  const dict = LEAD_STRINGS[lang].findings;
  return dict[code as keyof typeof dict]?.consequence ?? EN.findings[code as keyof typeof EN.findings]?.consequence ?? "";
}

// ─── locale-first lookup for UI keys ──────────────────────────────────────────

const LOCALE_DICTS: Record<LeadLang, Record<string, string>> = { en, ru, uk, fr, es, de, zh };

/**
 * Look up a UI key: the locale JSON wins (the N9-brief keys live there), this module's
 * dictionary is the fallback for additional keys, English is the last resort before the
 * key itself. Used by the /embed page, the /leads page and the settings card so nothing
 * renders as a raw `leadX` key while R's locale pass is pending.
 */
export function t2(lang: LeadLang, key: string): string {
  const locale = LOCALE_DICTS[lang];
  return locale[key] ?? LEAD_STRINGS[lang].ui[key] ?? LOCALE_DICTS.en[key] ?? EN.ui[key] ?? key;
}

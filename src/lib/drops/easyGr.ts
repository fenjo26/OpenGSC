// easy.gr — источник доступности для зон, у которых нет публичного реестра.
//
// Почему это вообще существует. У `.gr` нет ни RDAP, ни WHOIS, и это теперь доказано с двух
// сторон, а не выведено из молчащего порта:
//   • IANA в записи зоны `gr` публикует ПУСТЫЕ поля `whois:` и `refer:` — сервера, которому
//     можно задать вопрос, не существует. Вывод `whois cyclorama.gr` на машине пользователя
//     упирается ровно в эту запись и дальше не идёт;
//   • в bootstrap-файле RDAP (data.iana.org/rdap/dns.json, 438 сервисов на 2026-09-09) `gr`
//     не значится, поэтому `rdap.org` для неё маршрута не имеет и его 404 не значит ничего.
// Единственный оставшийся источник — API регистратора.
//
// ВАЖНО: easy.gr закрывает доступ по списку IP, объявленному в панели. Значит запросы отсюда
// идут С АДРЕСА СЕРВЕРА и НИКОГДА через пул прокси. Это не упущение, а требование: у API
// регистратора нет анонимных лимитов реестра, ротировать адреса тут нечего, а прокси-адрес
// просто не пройдёт проверку.

import { safeFetch } from "@/lib/security/safeFetch";
import { sanitiseForUrl } from "./availability";
import type { RegistryProfile } from "./registries";

const BASE = "https://api.easy.gr/";
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 128 * 1024;

export interface EasyGrCreds {
  username: string;
  password: string;
}

/**
 * Ключи живут в окружении сервера, а не в базе и не в localStorage.
 *
 * Интеграция привязана к IP конкретной машины — она серверная по своей природе, и хранить её
 * пароль там же, где хранятся пользовательские настройки, значит размазать секрет по местам,
 * которые для секрета не предназначены.
 */
export function easyGrCreds(): EasyGrCreds | null {
  const username = (process.env.EASY_GR_USERNAME ?? "").trim();
  const password = (process.env.EASY_GR_PASSWORD ?? "").trim();
  return username && password ? { username, password } : null;
}

/** Четырёхзначный вердикт — тот же контракт, что у `parseWhoisAvailability`. */
export type EasyGrVerdict = "available" | "registered" | "refused" | "empty";

export interface EasyGrOutcome {
  verdict: EasyGrVerdict;
  /** Причина отказа, как её назвал сам сервис. Пароль сюда попасть не может — его нет в ответе. */
  reason?: string;
  /** Что удалось прочитать из записи занятого домена. Дата окончания — это дата будущего дропа. */
  record?: {
    expiresAt?: Date;
    createdAt?: Date;
    nameServers?: string[];
    registryStatus?: string[];
  };
}

/**
 * Маркеры «домен свободен». Снято с живого ответа 2026-09-10: свободный `.gr` возвращает
 * ровно строку `Domain Does not exist`. Для gTLD, которые easy.gr перепродаёт, документирован
 * `No match for`.
 */
const FREE_MARKERS = ["not exist", "no match for", "no match", "not found"];

/**
 * Признаки настоящей записи о занятом домене.
 *
 * Отдельный список, а не «раз не свободен, значит занят»: пустой ответ, страница-заглушка и
 * текст об ошибке тоже «не содержат маркера свободы», и превращать их в вердикт «занят» —
 * это тихо выбрасывать хорошего кандидата.
 *
 * Половина списка греческая, и это не украшение. Занятый `.gr` приходит не текстом whois, а
 * HTML-таблицей реестра на греческом: `Όνομα χώρου`, `Ημερομηνία λήξης`, `ΣΤΟΙΧΕΙΑ ΚΑΤΑΧΩΡΗΤΗ`.
 * Английские слова в ней не встречаются вообще, так что список только из них молча читал бы
 * каждый занятый греческий домен как «ответ непонятен». Английская половина остаётся для
 * gTLD, которые приходят классическим текстом.
 */
const REGISTERED_MARKERS = [
  // .gr — шаблон реестра, как его отдаёт easy.gr
  "domain-wrap", "όνομα χώρου", "ημερομηνία δημιουργίας", "ημερομηνία λήξης",
  "εξυπηρετητής ονοματοδοσίας", "στοιχεία καταχωρητή", "αριθμός πρωτοκόλλου",
  // gTLD — обычный whois
  "registrar", "registrant", "creation date", "created on", "expiration",
  "expires", "domain status", "nameserver", "name server",
];

/** `<td>Метка</td><th…> Значение</th>` — форма, в которой реестр отдаёт каждую строку таблицы. */
const ROW_RE = /<td[^>]*>([\s\S]*?)<\/td>\s*(?:<br\s*\/?>\s*)*<th[^>]*>([\s\S]*?)<\/th>/gi;

const stripTags = (v: string) => v.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();

/** `30-11-2026` → Date. Формат реестра — день-месяц-год, и перепутать его с ISO нельзя. */
function parseGrDate(value: string): Date | undefined {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  if (!m) return undefined;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Поля из HTML-таблицы реестра.
 *
 * Достаются потому, что они бесплатны и в этом модуле дороги: дата окончания у занятого `.gr`
 * — это дата будущего дропа, а вся затея как раз про то, чтобы оказаться рядом вовремя.
 */
export function parseEasyGrRecord(body: string): {
  expiresAt?: Date;
  createdAt?: Date;
  nameServers?: string[];
  registryStatus?: string[];
} {
  const rows: [label: string, value: string][] = [];
  for (const m of body.matchAll(ROW_RE)) rows.push([stripTags(m[1]).toLowerCase(), stripTags(m[2])]);
  if (!rows.length) return {};

  const pick = (needle: string) => rows.find(r => r[0].includes(needle))?.[1];
  const nameServers = rows.filter(r => r[0].includes("εξυπηρετητής")).map(r => r[1]).filter(Boolean);
  const status = pick("κατάταση") ?? pick("κατάσταση");

  const out: ReturnType<typeof parseEasyGrRecord> = {};
  const expires = pick("ημερομηνία λήξης");
  const created = pick("ημερομηνία δημιουργίας");
  if (expires) { const d = parseGrDate(expires); if (d) out.expiresAt = d; }
  if (created) { const d = parseGrDate(created); if (d) out.createdAt = d; }
  if (nameServers.length) out.nameServers = nameServers;
  if (status) out.registryStatus = [status];
  return out;
}

/**
 * Разбор ответа. Вынесен из сети, чтобы контракт можно было закрепить тестами, не имея ни
 * ключей, ни разрешённого IP.
 */
export function parseEasyGrBody(raw: string): EasyGrOutcome {
  const body = (raw ?? "").trim();
  if (!body) return { verdict: "empty" };

  // Служебный JSON приходит и на успех, и на отказ. `done: 0` — это отказ, а не ответ про
  // домен: неверный пароль, неразрешённый IP, кончившиеся кредиты выглядят именно так, и
  // прочитать такое как «свободен» означало бы посоветовать купить чужой домен.
  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      const json = JSON.parse(body) as Record<string, unknown>;
      const done = json.done;
      if (done === 0 || done === "0" || done === false) {
        const errors = json.errors;
        const reason = errors && typeof errors === "object"
          ? Object.entries(errors as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`).join("; ")
          : String(json.error ?? json.message ?? "refused");
        return { verdict: "refused", reason: reason.slice(0, 200) };
      }
      const flat = JSON.stringify(json).toLowerCase();
      if (FREE_MARKERS.some(m => flat.includes(m))) return { verdict: "available" };
      if (REGISTERED_MARKERS.some(m => flat.includes(m))) {
        return { verdict: "registered", record: parseEasyGrRecord(body) };
      }
      return { verdict: "empty" };
    } catch {
      return { verdict: "empty" };
    }
  }

  const lower = body.toLowerCase();
  if (FREE_MARKERS.some(m => lower.includes(m))) return { verdict: "available" };
  if (REGISTERED_MARKERS.some(m => lower.includes(m))) {
    return { verdict: "registered", record: parseEasyGrRecord(body) };
  }
  return { verdict: "empty" };
}

/**
 * Один запрос о доступности.
 *
 * Плоская форма `?action=0`, та самая, что задокументирована у них для конфига WHMCS: её
 * контракт написан у них же явным образом, включая маркер по зонам. Живой JSON-эндпоинт
 * (`POST /whois`) устроен богаче, но его схема на момент написания не подтверждена образцом
 * ответа, а подбирать имена полей на глаз — это ровно та ошибка, ради которой в этом модуле
 * заведён `registries.ts`. Разбор уже умеет и JSON-отказ, так что переезд будет узким.
 */
export async function easyGrAvailability(domain: string, creds: EasyGrCreds): Promise<EasyGrOutcome> {
  const url = `${BASE}?action=0&username=${encodeURIComponent(creds.username)}`
    + `&password=${encodeURIComponent(creds.password)}&domain=${sanitiseForUrl(domain)}`;
  try {
    const res = await safeFetch(url, {
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      allowPrivate: false,
      // Никакого `proxy` — и это принципиально: доступ у них по белому списку IP.
    });
    if (!res.ok) return { verdict: "refused", reason: `http ${res.status}` };
    return parseEasyGrBody(await res.text());
  } catch (e) {
    // Сеть отказала — это отсутствие ответа, а не ответ. Строка останется на месте и вернётся.
    return { verdict: "refused", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Зоны, за которые отвечает этот регистратор. */
export function easyGrHandles(profile: RegistryProfile): boolean {
  return profile.registrarSource === "easy.gr";
}

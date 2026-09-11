// Пул прокси для проверки свободности.
//
// Без прокси единица троттлинга — пара (зона, наш единственный IP), и `.com` на 30 000 доменов
// это недели вежливого ожидания. С пулом единицей становится пара (зона, прокси): N живых
// адресов дают почти N-кратную пропускную способность, при этом каждый отдельный реестр видит
// ту же частоту запросов с одного адреса, что и раньше. Интервалы зон отсюда НЕ отменяются.
//
// Два разных транспорта, и это не деталь реализации, а то, что пользователь обязан знать:
// RDAP — обычный HTTPS, ему годится и HTTP-прокси; WHOIS — сырой TCP на порт 43, и через
// HTTP-прокси он не пойдёт, потому что публичные HTTP-прокси не дают CONNECT на нестандартный
// порт. Для WHOIS нужен SOCKS5.

export type ProxyKind = "http" | "socks5";

export interface ProxyEndpoint {
  kind: ProxyKind;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export type ProxyParseError = "empty" | "no_port" | "bad_port" | "bad_host" | "bad_scheme";

/** Пароль наружу не выходит никогда: ни в UI, ни в логи, ни в текст ошибки. */
export function redactProxy(p: ProxyEndpoint): string {
  const auth = p.username ? `${p.username}:***@` : "";
  return `${p.kind}://${auth}${p.host}:${p.port}`;
}

/** Стабильный идентификатор эндпоинта без секрета — годится как ключ и как строка в логе. */
export function proxyKey(p: ProxyEndpoint): string {
  return `${p.kind}://${p.username ? `${p.username}@` : ""}${p.host}:${p.port}`;
}

/**
 * Адрес без протокола — единица, по которой реестр считает частоту.
 *
 * Отличается от `proxyKey` намеренно. Один и тот же прокси часто говорит и по HTTP, и по SOCKS5
 * на том же порту, и добавить его обоими способами разумно: HTTP повезёт RDAP, SOCKS5 — WHOIS.
 * Но для реестра это ОДИН адрес. Считай мы вежливость по `proxyKey`, две записи одной машины
 * стали бы двумя независимыми полосами и вдвое превысили интервал зоны — ровно то, ради
 * предотвращения чего интервал и существует.
 */
export function proxyAddress(p: ProxyEndpoint): string {
  return `${p.host}:${p.port}`;
}

const isPort = (n: number) => Number.isInteger(n) && n > 0 && n < 65536;

/** `1.2.3.4:1080` or `proxy.example.com:8080` — an address with a port, and nothing else. */
function looksLikeHostPort(value: string): boolean {
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  return isHost(parts[0]) && isPort(Number(parts[1]));
}

/** The stronger claim: the host is a literal IPv4, not a name that merely contains a dot. */
function looksLikeIpHostPort(value: string): boolean {
  const parts = value.split(":");
  if (parts.length !== 2 || !isPort(Number(parts[1]))) return false;
  const octets = parts[0].split(".");
  return octets.length === 4 && octets.every(o => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}
// Хост: IPv4 или доменное имя. IPv6 в квадратных скобках сознательно не поддерживаем —
// провайдеры прокси их не выдают, а разбор `[::1]:8080` вперемешку с `ip:port:user:pass`
// превращает парсер в угадайку.
const isHost = (h: string) => /^[a-z0-9.-]+$/i.test(h) && h.includes(".") && !h.startsWith(".") && !h.endsWith(".");

/**
 * Одна строка списка → эндпоинт.
 *
 * Принимаем то, что реально выдают продавцы:
 *   user:pass@ip:port · http://user:pass@ip:port · socks5://user:pass@ip:port
 *   ip:port · ip:port:user:pass   (последний формат — самый распространённый в панелях)
 *
 * Схема по умолчанию — http: она годится для RDAP, а для WHOIS всё равно нужен явный socks5,
 * и молча объявлять чужой HTTP-прокси соксом значит обещать то, чего нет.
 */
export function parseProxyLine(line: string): { proxy: ProxyEndpoint } | { reason: ProxyParseError } {
  const raw = (line ?? "").trim().replace(/^["'<]+|["'>,;]+$/g, "").trim();
  if (!raw) return { reason: "empty" };

  let kind: ProxyKind = "http";
  let rest = raw;
  const scheme = /^([a-z0-9+.-]+):\/\//i.exec(rest);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === "http" || s === "https") kind = "http";
    else if (s === "socks5" || s === "socks" || s === "socks5h") kind = "socks5";
    else return { reason: "bad_scheme" };
    rest = rest.slice(scheme[0].length);
  }
  rest = rest.split(/[/?#]/)[0];
  if (!rest) return { reason: "empty" };

  let username: string | undefined;
  let password: string | undefined;
  let hostPart = rest;

  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    // Which side of the `@` is the address is NOT a given. The classic spelling is
    // `user:pass@host:port`, but plenty of panels hand out `host:port@user:pass` — same data,
    // mirrored — and assuming one ordering rejects every line of the other with "not a proxy",
    // which reads as "these proxies are broken" rather than "this field wants them differently".
    // So the side that actually looks like an address decides.
    const left = rest.slice(0, at);
    const right = rest.slice(at + 1);
    const leftIsAddress = looksLikeHostPort(left);
    const rightIsAddress = looksLikeHostPort(right);

    let creds: string;
    if (rightIsAddress && !leftIsAddress) {
      creds = left; hostPart = right;
    } else if (leftIsAddress && !rightIsAddress) {
      creds = right; hostPart = left;
    } else if (leftIsAddress && rightIsAddress) {
      // Both readable as an address — a username with a dot in it and a numeric password can do
      // that. An IP literal is the stronger claim; failing that, the classic ordering wins.
      const leftIsIp = looksLikeIpHostPort(left);
      const rightIsIp = looksLikeIpHostPort(right);
      if (leftIsIp && !rightIsIp) { creds = right; hostPart = left; }
      else { creds = left; hostPart = right; }
    } else {
      // Neither side is an address; fall through to the checks below, which name the reason.
      creds = left; hostPart = right;
    }

    const colon = creds.indexOf(":");
    username = colon >= 0 ? creds.slice(0, colon) : creds;
    password = colon >= 0 ? creds.slice(colon + 1) : undefined;
  }

  const parts = hostPart.split(":");
  // `ip:port:user:pass` — панели выдают именно так, и `@` в строке при этом нет.
  if (at < 0 && parts.length === 4) {
    username = parts[2];
    password = parts[3];
    hostPart = `${parts[0]}:${parts[1]}`;
  } else if (parts.length > 2) {
    return { reason: "bad_host" };
  }

  const [host, portRaw] = hostPart.split(":");
  if (!host) return { reason: "bad_host" };
  if (portRaw == null || portRaw === "") return { reason: "no_port" };
  const port = Number(portRaw);
  if (!isPort(port)) return { reason: "bad_port" };
  if (!isHost(host)) return { reason: "bad_host" };

  const proxy: ProxyEndpoint = { kind, host, port };
  if (username) proxy.username = username;
  if (password) proxy.password = password;
  return { proxy };
}

export interface ProxyListResult {
  proxies: ProxyEndpoint[];
  skipped: { value: string; reason: ProxyParseError }[];
}

/** Список из textarea. Дедуп по ключу без пароля: одна и та же пара host:port дважды не нужна. */
export function parseProxyList(raw: string): ProxyListResult {
  const proxies: ProxyEndpoint[] = [];
  const skipped: ProxyListResult["skipped"] = [];
  const seen = new Set<string>();

  for (const line of (raw ?? "").split(/[\r\n,]+/)) {
    if (!line.trim()) continue;
    const res = parseProxyLine(line);
    if ("reason" in res) {
      // Значение в отчёт идёт уже без пароля: отчёт попадает и на экран, и в лог.
      skipped.push({ value: line.trim().replace(/:[^:@]*@/, ":***@").slice(0, 120), reason: res.reason });
      continue;
    }
    const key = proxyKey(res.proxy);
    if (seen.has(key)) continue;
    seen.add(key);
    proxies.push(res.proxy);
  }
  return { proxies, skipped };
}

/** Состояние одного прокси в пуле, как его держит планировщик запросов. */
export interface ProxyHealth {
  key: string;
  /** Подряд идущие неудачи. Сбрасывается любым успехом. */
  failures: number;
  /** Когда прокси в последний раз брали в работу — для честной ротации. */
  lastUsedAt: number;
  /** До этого момента прокси не берут. 0 — доступен. */
  restingUntil: number;
}

/**
 * Сколько неудач подряд выводят прокси из строя и на сколько.
 *
 * Не «навсегда»: платный прокси падает на минуту чаще, чем умирает, и выбросить его из пула
 * после трёх таймаутов значит к концу большого прогона остаться без пула. Отдых, потом обратно.
 */
export const PROXY_FAIL_LIMIT = 3;
export const PROXY_REST_MS = 5 * 60 * 1000;

export function newHealth(key: string): ProxyHealth {
  return { key, failures: 0, lastUsedAt: 0, restingUntil: 0 };
}

/**
 * Следующий прокси: самый давно не использованный среди доступных.
 *
 * Least-recently-used, а не случайный: случайный выбор на пуле в 20 адресов регулярно бьёт в
 * один и тот же дважды подряд, а весь смысл пула в том, чтобы реестр видел разные адреса.
 */
export function pickProxy(health: ProxyHealth[], now = Date.now()): ProxyHealth | null {
  let best: ProxyHealth | null = null;
  for (const h of health) {
    if (h.restingUntil > now) continue;
    if (!best || h.lastUsedAt < best.lastUsedAt) best = h;
  }
  return best;
}

export function markProxyResult(h: ProxyHealth, ok: boolean, now = Date.now()): ProxyHealth {
  h.lastUsedAt = now;
  if (ok) {
    h.failures = 0;
    h.restingUntil = 0;
    return h;
  }
  h.failures += 1;
  if (h.failures >= PROXY_FAIL_LIMIT) {
    h.restingUntil = now + PROXY_REST_MS;
    h.failures = 0;
  }
  return h;
}

/** Есть ли в пуле хоть один SOCKS5 — от этого зависит, доступен ли WHOIS через пул вообще. */
export function hasSocks(proxies: ProxyEndpoint[]): boolean {
  return proxies.some(p => p.kind === "socks5");
}

// ─── Пул: кто следующий и когда ему можно ────────────────────────────────────

export interface ProxyLease {
  /** `null` — пула нет или все отдыхают: идём напрямую, как раньше. */
  endpoint: ProxyEndpoint | null;
  release(ok: boolean): void;
}

export interface ProxyPool {
  /** Сколько адресов в пуле. 0 — работаем напрямую. */
  readonly size: number;
  /** Есть ли SOCKS5: от этого зависит, доступен ли WHOIS через пул. */
  readonly hasSocks: boolean;
  /**
   * Взять прокси под запрос к зоне `zone`, дождавшись, пока для ПАРЫ (зона, прокси) истечёт
   * `minIntervalMs`. Вежливость к реестру считается по адресу, а не по нашему процессу: два
   * разных прокси могут спрашивать одну зону одновременно, один и тот же — нет.
   */
  lease(zone: string, minIntervalMs: number): Promise<ProxyLease>;
  /** Снимок здоровья — для отчёта в UI. */
  snapshot(): { key: string; resting: boolean }[];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Пустой пул: единый интерфейс для «прокси не настроены», без ветвлений у вызывающего. */
export const DIRECT_POOL: ProxyPool = {
  size: 0,
  hasSocks: false,
  async lease() { return { endpoint: null, release() {} }; },
  snapshot() { return []; },
};

export function createProxyPool(endpoints: ProxyEndpoint[]): ProxyPool {
  if (!endpoints.length) return DIRECT_POOL;

  const byKey = new Map(endpoints.map(p => [proxyKey(p), p]));
  const health = new Map([...byKey.keys()].map(k => [k, newHealth(k)]));
  /** Ключ здоровья → адрес. Здоровье живёт по записи, вежливость — по адресу. */
  const addressOf = new Map([...byKey.entries()].map(([k, p]) => [k, proxyAddress(p)]));
  /** Когда пара (зона, АДРЕС) последний раз ходила в реестр. */
  const zoneUse = new Map<string, number>();
  /** Адреса, занятые прямо сейчас: одно соединение на машину за раз. */
  const busy = new Set<string>();

  const pool: ProxyPool = {
    size: endpoints.length,
    hasSocks: hasSocks(endpoints),
    snapshot: () => [...health.values()].map(h => ({ key: h.key, resting: h.restingUntil > Date.now() })),
    async lease(zone, minIntervalMs) {
      for (;;) {
        const now = Date.now();
        const addr = (h: ProxyHealth) => addressOf.get(h.key) ?? h.key;
        const free = [...health.values()].filter(h => !busy.has(addr(h)) && h.restingUntil <= now);
        if (!free.length) {
          // Либо все заняты (ждём освобождения), либо все отдыхают (ждём конца отдыха). Если
          // отдыхают ВСЕ и надолго — идём напрямую: остановить проверку целиком хуже, чем
          // сходить со своего адреса.
          const resting = [...health.values()].every(h => h.restingUntil > now);
          if (resting && !busy.size) return { endpoint: null, release() {} };
          await sleep(50);
          continue;
        }
        // Дольше всех не ходивший в ЭТУ зону — так интервал зоны выжидается реже всего.
        free.sort((a, b) => (zoneUse.get(`${zone}|${addr(a)}`) ?? 0) - (zoneUse.get(`${zone}|${addr(b)}`) ?? 0));
        const chosen = free[0];
        const chosenAddr = addr(chosen);
        const zoneKey = `${zone}|${chosenAddr}`;
        const wait = (zoneUse.get(zoneKey) ?? 0) + minIntervalMs - now;
        if (wait > 0) {
          // Ждём, ПОМЕТИВ адрес занятым: иначе соседний воркер выберет его же и обгонит нас,
          // и интервал зоны для него не выждет никто.
          busy.add(chosenAddr);
          await sleep(Math.min(wait, minIntervalMs));
          busy.delete(chosenAddr);
          continue;
        }
        busy.add(chosenAddr);
        zoneUse.set(zoneKey, Date.now());
        chosen.lastUsedAt = Date.now();
        let released = false;
        return {
          endpoint: byKey.get(chosen.key) ?? null,
          release(ok: boolean) {
            if (released) return;
            released = true;
            busy.delete(chosenAddr);
            markProxyResult(chosen, ok);
          },
        };
      }
    },
  };
  return pool;
}

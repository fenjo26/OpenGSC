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

const isPort = (n: number) => Number.isInteger(n) && n > 0 && n < 65536;
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
    const creds = rest.slice(0, at);
    hostPart = rest.slice(at + 1);
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

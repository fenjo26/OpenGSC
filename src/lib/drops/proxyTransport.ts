// Как из описания прокси получается сокет: SOCKS5 и HTTP CONNECT.
//
// Разнесено с `proxies.ts` (там чистая логика — разбор, ротация, здоровье) ровно по той же
// причине, по которой `whois.ts` отделён от `availability.ts`: работа с сокетом и решения о
// том, кого и когда спрашивать, тестируются по-разному и ломаются по-разному.

import net from "node:net";
import { SocksClient } from "socks";
import type { ProxyConnect } from "@/lib/security/safeFetch";
import { redactProxy, type ProxyEndpoint } from "./proxies";

const CONNECT_TIMEOUT_MS = 10_000;

/** Ошибка соединения через прокси. Пароль в текст не попадает — только `redactProxy`. */
export class ProxyError extends Error {
  constructor(public readonly proxy: string, message: string) {
    super(`proxy ${proxy}: ${message}`);
    this.name = "ProxyError";
  }
}

/** SOCKS5 (RFC 1928 + 1929), через библиотеку — руками этот протокол писать незачем. */
async function socksConnect(p: ProxyEndpoint, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: p.host, port: p.port, type: 5,
        ...(p.username ? { userId: p.username } : {}),
        ...(p.password ? { password: p.password } : {}),
      },
      command: "connect",
      destination: { host, port },
      timeout: Math.max(1000, Math.min(timeoutMs, CONNECT_TIMEOUT_MS)),
    });
    return socket;
  } catch (e) {
    throw new ProxyError(redactProxy(p), e instanceof Error ? e.message : String(e));
  }
}

/**
 * HTTP CONNECT. Туннель, а не проксирование запроса: так один и тот же код обслуживает и http,
 * и https цели, и TLS остаётся сквозным до самого реестра — прокси видит только имя хоста.
 */
function httpConnect(p: ProxyEndpoint, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const label = redactProxy(p);
    const socket = net.createConnection({ host: p.host, port: p.port });
    let settled = false;
    let buffer = "";

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new ProxyError(label, message));
    };
    const timer = setTimeout(() => fail("connect timeout"), Math.max(1000, Math.min(timeoutMs, CONNECT_TIMEOUT_MS)));

    socket.once("error", err => fail(err instanceof Error ? err.message : String(err)));
    socket.once("close", () => fail("closed before the tunnel was up"));

    socket.once("connect", () => {
      const target = `${host}:${port}`;
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      if (p.username) {
        const token = Buffer.from(`${p.username}:${p.password ?? ""}`).toString("base64");
        lines.push(`Proxy-Authorization: Basic ${token}`);
      }
      lines.push("Proxy-Connection: keep-alive", "", "");
      socket.write(lines.join("\r\n"));
    });

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        // Заголовок ответа прокси не бывает длинным; всё сверх — не прокси на том конце.
        if (buffer.length > 16 * 1024) fail("no CONNECT response header");
        return;
      }
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buffer)?.[1] ?? 0);
      if (status !== 200) {
        // 407 здесь — самая частая настоящая причина: логин-пароль не доехали или не те.
        fail(status === 407 ? "authentication rejected (407)" : `CONNECT refused with ${status || "no status"}`);
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeAllListeners("close");
      socket.removeAllListeners("error");
      // Паузу — до всего остального. Пока висел наш `data`, сокет был в flowing-режиме, и байты
      // от цели, пришедшие между этим моментом и подпиской вызывающего, просто исчезли бы: поток
      // без единого слушателя данные не буферизует, а выбрасывает. `unshift` тоже требует паузы.
      socket.pause();
      // Всё, что прокси прислал в одном пакете с заголовком, принадлежит уже туннелю.
      const tail = buffer.slice(end + 4);
      if (tail) socket.unshift(Buffer.from(tail, "latin1"));
      resolve(socket);
    };
    socket.on("data", onData);
  });
}

/**
 * ВАЖНО про возвращаемый сокет: он ПРИОСТАНОВЛЕН.
 *
 * Иначе нельзя: пока мы вычитывали заголовок CONNECT, сокет был в flowing-режиме, и байты цели,
 * пришедшие до подписки вызывающего, были бы выброшены (поток без слушателя данные не копит).
 * Пауза нужна и для `unshift` хвоста, приехавшего в одном пакете с заголовком. Побочный эффект
 * от Node: после явной паузы подписка на `data` сама поток НЕ возобновляет, поэтому каждый
 * потребитель обязан вызвать `resume()` — так же ведёт себя и сокет из библиотеки `socks`.
 */

/** Коннектор для `safeFetch` — тот интерфейс, который знает слой безопасности. */
export function proxyConnector(p: ProxyEndpoint): ProxyConnect {
  return {
    label: redactProxy(p),
    connect: (host, port, timeoutMs) =>
      p.kind === "socks5" ? socksConnect(p, host, port, timeoutMs) : httpConnect(p, host, port, timeoutMs),
  };
}

/**
 * Сокет до WHOIS-сервера через прокси.
 *
 * `null` для HTTP-прокси, а не попытка «всё равно попробовать»: и публичные, и коммерческие
 * HTTP-прокси почти поголовно разрешают CONNECT только на 443, и десять секунд ожидания отказа
 * на каждый домен выглядят как зависший реестр. Вызывающий должен взять SOCKS5 или пойти
 * напрямую — и сказать об этом пользователю.
 */
export function whoisConnector(p: ProxyEndpoint, host: string): (() => Promise<net.Socket>) | null {
  if (p.kind !== "socks5") return null;
  return () => socksConnect(p, host, 43, CONNECT_TIMEOUT_MS);
}

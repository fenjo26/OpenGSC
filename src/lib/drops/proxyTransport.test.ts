import assert from "node:assert/strict";
import net from "node:net";
import { after, test } from "node:test";
import { proxyConnector } from "./proxyTransport";

// A real CONNECT handshake against a throwaway proxy on loopback. The tunnel is the one piece of
// this that cannot be reasoned about on paper: the 407, the header/body boundary, and the bytes
// the proxy sends immediately after the blank line are all places a hand-rolled client silently
// eats the first chunk of the real response.

/** A minimal CONNECT proxy. `requireAuth` makes it answer 407 unless credentials arrive. */
function fakeProxy(opts: { requireAuth?: boolean; trailer?: string } = {}) {
  const server = net.createServer(client => {
    client.unref();
    let head = "";
    client.on("data", function onData(chunk) {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      client.removeListener("data", onData);
      if (opts.requireAuth && !/proxy-authorization: basic /i.test(head)) {
        client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        return;
      }
      const target = /^CONNECT ([^:]+):(\d+)/.exec(head);
      const upstream = net.createConnection({ host: target![1], port: Number(target![2]) });
      upstream.unref();
      upstream.once("close", () => client.end());
      upstream.once("connect", () => {
        // The trailer rides in the SAME write as the header on purpose.
        client.write(`HTTP/1.1 200 Connection established\r\n\r\n${opts.trailer ?? ""}`);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => client.destroy());
    });
    client.on("error", () => {});
  });
  return server;
}

/** Says one line and closes — enough to prove bytes crossed the tunnel intact. */
function echoServer(banner: string) {
  return net.createServer(s => { s.unref(); s.end(banner); });
}

// Accepted sockets are unref'd (a paused tunnel outliving its assertion must not hold the
// process open), but the listeners are not — unref'ing those lets the runner exit before the
// tests have run at all.
const listen = (s: net.Server) =>
  new Promise<number>(res => s.listen(0, "127.0.0.1", () => res((s.address() as net.AddressInfo).port)));

const servers: net.Server[] = [];
after(() => { for (const s of servers) s.close(); });

const read = (socket: net.Socket) =>
  new Promise<string>((resolve, reject) => {
    let out = "";
    socket.setEncoding("utf8");
    socket.on("data", c => { out += c; });
    // The connector hands back a paused socket by contract — see proxyTransport.
    socket.resume();
    socket.on("end", () => { socket.destroy(); resolve(out); });
    socket.on("error", reject);
  });

test("HTTP CONNECT tunnels to the target and delivers its bytes", async () => {
  const target = echoServer("HELLO-FROM-TARGET");
  const proxy = fakeProxy();
  servers.push(target, proxy);
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);

  const socket = await proxyConnector({ kind: "http", host: "127.0.0.1", port: proxyPort })
    .connect("127.0.0.1", targetPort, 5000);
  assert.equal(await read(socket), "HELLO-FROM-TARGET");
});

test("bytes arriving in the same packet as the CONNECT header are not eaten", async () => {
  // A proxy that appends the first response bytes to its own header is normal, and a client that
  // drops its read buffer after the blank line loses them — silently, as a truncated answer.
  const target = echoServer("-REST");
  const proxy = fakeProxy({ trailer: "EARLY" });
  servers.push(target, proxy);
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);

  const socket = await proxyConnector({ kind: "http", host: "127.0.0.1", port: proxyPort })
    .connect("127.0.0.1", targetPort, 5000);
  assert.equal(await read(socket), "EARLY-REST");
});

test("a rejected login surfaces as 407, not as a timeout", async () => {
  const target = echoServer("x");
  const proxy = fakeProxy({ requireAuth: true });
  servers.push(target, proxy);
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);

  await assert.rejects(
    () => proxyConnector({ kind: "http", host: "127.0.0.1", port: proxyPort })
      .connect("127.0.0.1", targetPort, 5000),
    (e: Error) => e.message.includes("407"),
  );
});

test("credentials travel, and never appear in the connector label", async () => {
  const target = echoServer("AUTHED");
  const proxy = fakeProxy({ requireAuth: true });
  servers.push(target, proxy);
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);

  const connector = proxyConnector({
    kind: "http", host: "127.0.0.1", port: proxyPort, username: "bob", password: "hunter2",
  });
  assert.ok(!connector.label.includes("hunter2"), connector.label);
  const socket = await connector.connect("127.0.0.1", targetPort, 5000);
  assert.equal(await read(socket), "AUTHED");
});

test("a dead proxy fails fast with the endpoint named and the password hidden", async () => {
  const dead = net.createServer(s => s.destroy());
  servers.push(dead);
  const port = await listen(dead);
  await assert.rejects(
    () => proxyConnector({ kind: "http", host: "127.0.0.1", port, username: "bob", password: "hunter2" })
      .connect("example.com", 443, 2000),
    (e: Error) => e.message.includes("127.0.0.1") && !e.message.includes("hunter2"),
  );
});

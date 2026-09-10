/**
 * Что easy.gr отвечает на самом деле — снимок контракта, снятый там, где он вообще возможен.
 *
 * Запускать НА СЕРВЕРЕ, чей IP объявлен в панели easy.gr: доступ у них по белому списку, и с
 * любой другой машины ответ будет "unauthorized" независимо от правильности ключей.
 *
 *   EASY_GR_USERNAME=… EASY_GR_PASSWORD=… npx tsx scripts/easygr-probe.ts taken.gr free.gr
 *
 * Печатает сырое тело ответа и то, как его прочитал парсер. Нужен ровно для одного: заменить
 * догадку о формате на образец. Пароль в вывод не попадает — в URL он есть, но URL не печатается.
 */
import { easyGrCreds, parseEasyGrBody } from "../src/lib/drops/easyGr";

const BASE = "https://api.easy.gr/";

async function main() {
  const creds = easyGrCreds();
  if (!creds) {
    console.error("EASY_GR_USERNAME / EASY_GR_PASSWORD are not set.");
    process.exit(1);
  }
  const domains = process.argv.slice(2);
  if (!domains.length) {
    console.error("Usage: npx tsx scripts/easygr-probe.ts <domain> [domain…]");
    console.error("Pass one domain you know is taken and one you believe is free.");
    process.exit(1);
  }

  for (const domain of domains) {
    const url = `${BASE}?action=0&username=${encodeURIComponent(creds.username)}`
      + `&password=${encodeURIComponent(creds.password)}&domain=${encodeURIComponent(domain)}`;
    process.stdout.write(`\n=== ${domain} ===\n`);
    try {
      const res = await fetch(url);
      const body = await res.text();
      process.stdout.write(`HTTP ${res.status} ${res.headers.get("content-type") ?? ""}\n`);
      process.stdout.write("--- raw body ---\n");
      process.stdout.write(body.slice(0, 4000));
      process.stdout.write(`\n--- parsed: ${JSON.stringify(parseEasyGrBody(body))}\n`);
    } catch (e) {
      process.stdout.write(`request failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}

void main();

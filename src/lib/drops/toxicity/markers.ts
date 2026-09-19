import type { ScriptName } from "./types";

/* ------------------------------------------------------------------ */
/* Письменности                                                        */
/* ------------------------------------------------------------------ */

const RANGES: [ScriptName, RegExp][] = [
  ["cjk", /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g],
  ["hangul", /[\uac00-\ud7af\u1100-\u11ff]/g],
  ["thai", /[\u0e00-\u0e7f]/g],
  ["arabic", /[\u0600-\u06ff\u0750-\u077f]/g],
  ["hebrew", /[\u0590-\u05ff]/g],
  ["devanagari", /[\u0900-\u097f]/g],
  ["cyrillic", /[\u0400-\u04ff]/g],
  ["latin", /[a-zA-Z]/g],
];

/** Сколько символов каждой письменности в строке. */
export function countScripts(text: string): Partial<Record<ScriptName, number>> {
  const out: Partial<Record<ScriptName, number>> = {};
  for (const [name, re] of RANGES) {
    const n = (text.match(re) ?? []).length;
    if (n) out[name] = n;
  }
  return out;
}

/**
 * Письменности, присутствующие ЗНАЧИМО. Для неалфавитных систем порог
 * абсолютный и низкий: два иероглифа в титуле — уже факт, независимо от
 * того, сколько рядом латиницы.
 */
export function scriptsOf(text: string): ScriptName[] {
  const counts = countScripts(text);
  const out: ScriptName[] = [];
  for (const [name, n] of Object.entries(counts) as [ScriptName, number][]) {
    const threshold = name === "latin" || name === "cyrillic" ? 4 : 2;
    if (n >= threshold) out.push(name);
  }
  return out;
}

/** Зоны, для которых письменность родная и сама по себе ни о чём не говорит. */
const NATIVE_SCRIPT_ZONES: Partial<Record<ScriptName, string[]>> = {
  cjk: ["cn", "tw", "hk", "mo", "jp", "sg", "com.cn", "co.jp", "com.tw", "com.hk"],
  hangul: ["kr", "co.kr"],
  thai: ["th", "co.th", "in.th"],
  arabic: ["ae", "sa", "eg", "qa", "kw", "ir", "iq", "ma", "com.sa", "com.eg"],
  hebrew: ["il", "co.il"],
  devanagari: ["in", "co.in", "np"],
  cyrillic: ["ru", "ua", "by", "kz", "bg", "rs", "su", "рф", "com.ua", "com.ru"],
};

export function isNativeScriptForZone(script: ScriptName, domain: string): boolean {
  const zones = NATIVE_SCRIPT_ZONES[script];
  if (!zones) return true; // латиница и всё, чего нет в таблице
  const lower = domain.toLowerCase();
  return zones.some((z) => lower.endsWith(`.${z}`));
}

/* ------------------------------------------------------------------ */
/* Словари маркеров                                                     */
/* ------------------------------------------------------------------ */

export interface MarkerGroup {
  code: string;
  weight: number;
  /** подстроки без границ слова — для CJK и подобного */
  substrings?: string[];
  /** слова с границами — для латиницы */
  words?: string[];
}

export const MARKERS: MarkerGroup[] = [
  {
    code: "gambling_zh",
    weight: 60,
    substrings: [
      "娱乐城", "赌场", "百家乐", "老虎机", "彩票", "体育投注", "真人娱乐", "电子游戏",
      "博彩", "下注", "赌博", "六合彩", "棋牌", "老哥", "利来", "九游", "米乐", "凯发",
      "太阳城", "威尼斯人", "永利", "金沙", "新葡京",
    ],
    words: ["w66", "k8cn", "ag8", "bcbet", "hg0088"],
  },
  {
    code: "gambling_id",
    weight: 60,
    words: [
      "togel", "gacor", "judi", "situs", "maxwin", "bandar", "pkv", "olxtoto",
      "sbobet", "mposlot", "depo", "taruhan", "slotgacor", "linkalternatif",
    ],
  },
  {
    // Слова, которые встречаются и у легального бизнеса («Casino on Wheels»,
    // прокат, ивенты). Сами по себе — только повод присмотреться.
    code: "gambling_generic",
    weight: 25,
    words: ["casino", "kasino", "slot", "slots", "betting", "jackpot", "toto", "rtp", "pragmatic", "mahjong", "scatter"],
  },
  {
    code: "adult",
    weight: 60,
    words: ["porn", "porno", "xxx", "hentai", "bokep", "escort", "camgirl", "sexcam", "onlyfans", "nude"],
    substrings: ["成人视频", "色情"],
  },
  {
    code: "pharma",
    weight: 45,
    words: ["viagra", "cialis", "tadalafil", "sildenafil", "tramadol", "oxycodone", "xanax", "pharmacy", "pillstore"],
  },
  {
    code: "replica",
    weight: 35,
    words: ["replica", "fakewatch", "superclone"],
    substrings: ["高仿"],
  },
  {
    code: "essay_mill",
    weight: 25,
    words: ["essaywriting", "paperhelp", "writemyessay", "dissertationservice"],
  },
];

/** Титулы/тексты, означающие «сайта не было». Не токсичность, а пустота. */
export const PARKED_MARKERS: string[] = [
  "没有找到站点", "找不到站点", "未找到站点",
  "domain is for sale", "buy this domain", "this domain is for sale", "domain for sale",
  "under construction", "coming soon", "site not found", "no website found",
  "account suspended", "welcome to nginx", "apache2 ubuntu default page", "index of /",
  "default web site page", "parked", "сайт не найден", "домен продается", "domain parking",
  "test page for the apache", "it works!",
];

/** Нормализация для матчинга: нижний регистр, схлопнутые пробелы и разделители. */
export function normaliseText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

/** Поиск группы маркеров в тексте; возвращает найденные вхождения. */
export function matchMarkers(text: string): { group: MarkerGroup; hits: string[] }[] {
  const norm = normaliseText(text);
  const flat = norm.replace(/[^a-z0-9\u0400-\u04ff\u3000-\u9fff\uac00-\ud7af\u0e00-\u0e7f]+/g, " ");
  const out: { group: MarkerGroup; hits: string[] }[] = [];

  for (const group of MARKERS) {
    const hits: string[] = [];
    for (const sub of group.substrings ?? []) {
      if (norm.includes(sub)) hits.push(sub);
    }
    for (const word of group.words ?? []) {
      const re = new RegExp(`(^| )${escapeRe(word)}(s?)( |$)`, "i");
      if (re.test(flat)) hits.push(word);
    }
    if (hits.length) out.push({ group, hits });
  }
  return out;
}

export function isParked(text: string): boolean {
  const norm = normaliseText(text);
  if (!norm) return false;
  return PARKED_MARKERS.some((m) => norm.includes(m));
}

/**
 * Токены, которые в имени домена практически не встречаются у легального
 * бизнеса. Список отдельный и намеренно короткий: подстрочный матч по имени
 * даёт ложные срабатывания на ровном месте — `judi` находится в
 * `judith-meyer-design.de`, `depo` в `reliabledeposits.org`, `pharmacy` в
 * настоящей аптеке. Такие ловятся только проверкой снапшотов.
 */
export const NAME_TOKENS: { code: string; tokens: string[] }[] = [
  {
    code: "gambling_id",
    tokens: ["togel", "gacor", "maxwin", "olxtoto", "sbobet", "mposlot", "slotgacor", "linkalternatif", "situs", "taruhan"],
  },
  { code: "adult", tokens: ["porno", "bokep", "hentai", "camgirl", "sexcam"] },
  { code: "pharma", tokens: ["viagra", "cialis", "tadalafil", "sildenafil", "tramadol"] },
];

/**
 * Бесплатный предварительный скан по САМОМУ ИМЕНИ, без единого запроса.
 * Матчинг подстрочный, потому что имена слитные (`situsumatoto.com`).
 * Ловит только тех, кто даже не переименовался, поэтому это отметка
 * «смотреть в первую очередь», а не вердикт.
 */
export function scanDomainName(domain: string): { code: string; hits: string[] }[] {
  const name = domain.toLowerCase().split(".").slice(0, -1).join(".").replace(/[^a-z0-9]+/g, "");
  const out: { code: string; hits: string[] }[] = [];
  for (const group of NAME_TOKENS) {
    const hits = group.tokens.filter((t) => name.includes(t));
    if (hits.length) out.push({ code: group.code, hits });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

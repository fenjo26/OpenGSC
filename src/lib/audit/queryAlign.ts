// Title/H1 ↔ main-query alignment — pure helpers, no Prisma, no fetch.
//
// "Keyword density" is not something this audit will ever compute. The check that actually
// uses data only OpenGSC has: does the page's title or H1 contain the query it REALLY gets
// impressions for in Search Console? A page ranking for "casino en ligne" with a title about
// "jeux de hasard" is a rewrite target no density heuristic could ever find.
//
// The database side (one grouped DailyMetric query per audit) lives in crawler.ts; everything
// decidable from strings is here and covered by node:test.

/** A query needs at least this many impressions / 28 d before it says anything about the page. */
export const MAIN_QUERY_MIN_IMPRESSIONS = 20;

/** Prefix matches shorter than this are too loose; short tokens (rtp) must match a whole word. */
const PREFIX_MATCH_MIN = 4;

// Stop-words for every language the instance ships. One combined set: the audit does not know
// the query's language up front, and a word that is a stop-word in ANY supported language
// ("the", "les", "und", "и", "και"…) carries no alignment signal in any of them.
const STOP_WORD_LISTS: Record<string, string[]> = {
  en: ["a","an","the","and","or","of","to","in","on","for","with","at","by","from","up","about","into","over","after","is","are","was","were","be","been","being","it","its","this","that","these","those","as","but","if","then","than","so","such","no","not","only","own","same","too","very","can","will","just","should","now","what","which","who","whom","when","where","why","how","all","any","both","each","few","more","most","other","some","such","do","does","did","doing","have","has","had","having","you","your","we","our","they","their","he","she","his","her","i","me","my"],
  fr: ["le","la","les","un","une","des","du","de","et","ou","à","au","aux","en","dans","sur","pour","avec","par","chez","sans","sous","est","sont","était","être","ce","cet","cette","ces","que","qui","quoi","où","comment","pourquoi","ne","pas","plus","moins","toujours","jamais","aussi","comme","mais","donc","or","ni","car","il","elle","ils","elles","nous","vous","je","tu","on","me","te","se","lui","leur","y","en"],
  es: ["el","la","los","las","un","una","unos","unas","y","o","de","del","al","a","en","con","por","para","sin","sobre","entre","hacia","es","son","era","ser","este","esta","estos","estas","ese","esa","que","quien","qué","dónde","cómo","por","qué","cuándo","no","ni","más","menos","muy","mucho","también","como","pero","si","ya","todo","toda","todos","todas","yo","tú","él","ella","nosotros","vosotros","ellos","ellas","me","te","se","lo","le","les"],
  de: ["der","die","das","den","dem","des","ein","eine","einen","einem","einer","eines","und","oder","aber","doch","denn","sondern","ist","sind","war","waren","sein","haben","hat","hatte","wird","werden","wurde","zu","zum","zur","in","im","an","am","auf","für","mit","von","vom","beim","nach","über","unter","vor","bei","aus","durch","um","gegen","ohne","bis","als","wie","wenn","weil","dass","was","wer","wo","wann","warum","wie","nicht","kein","keine","auch","noch","nur","schon","sehr","hier","da","dort","dieser","diese","dieses","ich","du","er","sie","es","wir","ihr","man"],
  it: ["il","lo","la","i","gli","le","un","uno","una","di","del","della","dei","delle","dello","degli","della","a","al","alla","ai","alle","allo","agli","da","dal","dalla","dai","dalle","in","nel","nella","nei","nelle","con","su","sul","sulla","sui","sulle","per","tra","fra","e","o","ma","se","perché","come","quando","dove","che","chi","cui","non","più","meno","molto","poco","anche","solo","ancora","già","questo","questa","quello","quella","io","tu","lui","lei","noi","voi","loro","mi","ti","si","ci","vi","è","sono","era","essere"],
  pt: ["o","a","os","as","um","uma","uns","umas","de","do","da","dos","das","em","no","na","nos","nas","por","para","com","sem","sob","sobre","entre","até","desde","após","e","ou","mas","se","que","quem","qual","quais","como","quando","onde","por","que","não","mais","menos","muito","pouco","também","só","ainda","já","este","esta","esse","essa","eu","tu","ele","ela","nós","vós","eles","elas","me","te","se","lhe","lhes","é","são","era","ser"],
  ru: ["и","в","во","не","на","я","бы","он","с","со","как","а","то","все","она","так","его","но","да","ты","к","у","же","вы","за","бы","только","её","мне","было","вот","от","меня","ещё","нет","о","из","ему","теперь","когда","даже","ну","вдруг","ли","если","уже","или","ни","быть","был","него","до","вас","нибудь","опять","уж","вам","ведь","там","потом","себя","ничего","ей","они","тут","где","есть","надо","ней","для","мы","тебя","их","чем","была","сам","чтоб","без","будто","чего","раз","тоже","себе","под","будет","ж","тогда","кто","этот","того","потому","этого","какой","совсем","ним","здесь","этом","один","почти","мой","тем","чтобы","нее","сейчас","были","куда","зачем","всех","никогда","можно","при","наконец","два","об","другой","хоть","после","над","больше","тот","через","эти","нас","про","всего","них","какая","много","разве","три","эту","моя","впрочем","хорошо","свою","этой","перед","иногда","лучше","чуть","том","нельзя","такой","им","более","всегда","конечно","всю","между"],
  el: ["ο","η","το","οι","τα","του","της","των","τον","την","τους","τις","και","ή","εν","σε","με","για","από","ως","προς","αλλά","όμως","αν","που","τι","πώς","πού","πότε","γιατί","όχι","πολύ","λίγο","ακόμα","μόνο","ήδη","αυτό","αυτή","αυτοί","εγώ","εσύ","εμείς","εσείς","μου","σου","μας","σας","είναι","ήταν","να","θα","μια","ένα","ένας","μίας","ενός"],
  uk: ["і","в","не","на","я","би","він","з","як","а","то","всі","вона","так","його","але","да","ти","к","у","ж","ви","за","же","тільки","її","мені","було","ось","від","мене","ще","немає","о","з","йому","тепер","коли","навіть","ну","чи","якщо","вже","або","ні","бути","був","нього","до","вас","будь-який","знову","вам","бо","там","потім","себе","нічого","їй","вони","тут","де","є","треба","ній","для","ми","тебе","їх","ніж","була","сам","щоб","без","ніби","чого","раз","також","собі","під","буде","тоді","хто","цей","того","тому","цього","який","зовсім","ньому","тут","цьому","один","майже","мій","тим","щоб","нее","зараз","були","куди","навіщо","всіх","ніколи","можна","при","нарешті","два","про","весь","них","яка","багато","хіба","три","цю","моя","втім","добре","свою","цієї","перед","іноді","краще","трохи","том","не можна","такий","їм","більше","завжди","звісно","всю","між"],
};

/** Every stop-word, normalized, in one set — exported for tests. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  Object.values(STOP_WORD_LISTS).flat().map(word => normalizeToken(word)).filter(Boolean),
);

// ─── token normalization ───────────────────────────────────────────────────────

/** Lowercase, diacritics stripped (démo → demo, works for Greek tonos and Cyrillic marks too). */
export function normalizeToken(token: string): string {
  return token
    .normalize("NFD")
    .replace(/[\u0300-\u036f\u0483-\u0489\u064b-\u0652]/g, "")
    .toLowerCase();
}

/** Words of a text after normalization — comparison units for both sides. */
function words(text: string): string[] {
  return normalizeToken(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Comparable form of a URL for DailyMetric rows and audit pages: lowercase host without
 * `www.`, no hash, no trailing slash (except on the root), query kept. GSC strips hashes and
 * usually reports the canonical host, while the audit crawls what it found — both sides go
 * through this one function so `https://example.com/en/` and `https://www.example.com/en`
 * meet. Returns "" for values that are not absolute http(s) URLs.
 */
export function normalizeAuditUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return "";
  }
}

/** Normalized word-tokens of a query, ≥ 2 characters. */
export function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of words(query)) {
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** Query tokens that can carry alignment: normalized, ≥ 2 chars, not stop-words in any supported language. */
export function significantQueryTokens(query: string): string[] {
  return queryTokens(query).filter(token => !STOP_WORDS.has(token));
}

/**
 * Does the text contain this query token?
 * Tokens of ≥ 4 characters match by word prefix, so `casino` matches "casinos" and "casino en
 * ligne" survives French inflection. Shorter tokens (rtp, seo, vpn) must match a whole word —
 * a prefix match there would see "rtp" inside "rtprog" and call the page aligned.
 */
export function textHasQueryToken(text: string, token: string): boolean {
  const haystack = words(text);
  if (token.length >= PREFIX_MATCH_MIN) return haystack.some(word => word.startsWith(token));
  return haystack.includes(token);
}

/** Does the text contain ANY significant token of the query? */
export function textMatchesQuery(text: string, query: string): boolean {
  const tokens = significantQueryTokens(query);
  if (!tokens.length) return true; // nothing measurable left ("the best") — silence, not a finding
  return tokens.some(token => textHasQueryToken(text, token));
}

/** The rule fires when NEITHER the title NOR the H1 contains any significant token. */
export function pageMatchesQuery(title: string, h1: string, query: string): boolean {
  return textMatchesQuery(title, query) || textMatchesQuery(h1, query);
}

/**
 * The page's main query: the highest-impression query with at least MAIN_QUERY_MIN_IMPRESSIONS
 * impressions. Ties go to the first row (callers order by impressions desc, then stop caring).
 * Null when nothing clears the floor — the rule stays silent rather than guessing.
 */
export function pickMainQuery(rows: { query: string; impressions: number }[]): { query: string; impressions: number } | null {
  let best: { query: string; impressions: number } | null = null;
  for (const row of rows) {
    if (row.impressions < MAIN_QUERY_MIN_IMPRESSIONS) continue;
    if (!best || row.impressions > best.impressions) best = row;
  }
  return best;
}

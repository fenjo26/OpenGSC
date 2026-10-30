// What a GSC sync failure means to a person, and when to say so.
//
// `invalid_grant` used to be counted (`accountErrors=1`) and then shown as a finished
// sync: the button went green, or the banner said the run "completed with errors" and
// pointed at the server log. The refresh token was already dead, and the dashboard
// looked fine for days. This module is the vocabulary for that — no database, so the
// UI, the cron and the tests share one definition.

export type SyncFailureKind = "reauth" | "quota" | "network" | "other";

export type SyncHealthState = {
  consecutiveFailures: number;
  /** True after the streak alert was actually delivered. Stops a daily repeat. */
  alerted: boolean;
};

export type SyncErrorLike = {
  error?: string;
  needsReauth?: boolean;
  kind?: SyncFailureKind;
  site?: string;
};

/** 48 hours. Older than this — or never — is a warning. Equal to 48h is still fresh. */
export const GSC_SYNC_STALE_MS = 48 * 60 * 60 * 1000;

/** The badge is wall time in China (the deployment's clock), not the viewer's zone. */
export const GSC_SYNC_TIME_ZONE = "Asia/Shanghai";

const REAUTH_RE =
  /invalid_grant|invalid_rapt|token has been expired or revoked|token.*expired|token.*revoked|invalid.*token|unauthorized|insufficient.*(permission|scope)|access.?denied/i;
const QUOTA_RE = /quota|rate.?limit|too many requests|\b429\b/i;
const NETWORK_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up|\b502\b|\b503\b|\b504\b/i;

/**
 * One string from a Google client error.
 *
 * `googleapis` often puts `invalid_grant` on `response.data.error` while `message` is
 * only "Request failed with status code 400". Matching the message alone misses the
 * revoked refresh token and the UI falls through to "completed".
 */
export function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  const e = err as {
    message?: string;
    error?: string;
    error_description?: string;
    response?: { data?: { error?: unknown; error_description?: string } };
  };
  const data = e.response?.data;
  const nested = data?.error;
  const nestedText =
    typeof nested === "string"
      ? nested
      : nested && typeof nested === "object" && "message" in nested
        ? String((nested as { message?: unknown }).message ?? "")
        : "";
  return [e.message, e.error, e.error_description, nestedText, data?.error_description]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
}

export function classifySyncError(message: string): SyncFailureKind {
  if (REAUTH_RE.test(message)) return "reauth";
  if (QUOTA_RE.test(message)) return "quota";
  if (NETWORK_RE.test(message)) return "network";
  return "other";
}

/** A single line safe to store. Known failures become a fixed sentence, not the stack. */
export function sanitizeSyncError(message: string): string {
  const kind = classifySyncError(message);
  if (kind === "reauth") return "Google authorization expired or was revoked.";
  if (kind === "quota") return "Google Search Console quota was exceeded.";
  if (kind === "network") return "Network error while contacting Google.";
  const first = message
    .split("\n")
    .map(line => line.trim())
    .find(line => line.length > 0 && !/^at\s+/.test(line));
  const line = (first ?? "Sync failed.").replace(/\s+at\s+\S+:\d+:\d+.*$/, "");
  return line.slice(0, 160) || "Sync failed.";
}

export function summarizeSyncFailure(result: {
  accountErrors?: SyncErrorLike[] | null;
  siteErrors?: SyncErrorLike[] | null;
}): { needsReauth: boolean; failureKind: SyncFailureKind | null; sites: string[] } {
  const accounts = result.accountErrors ?? [];
  const sites = result.siteErrors ?? [];
  const kinds: SyncFailureKind[] = [
    ...accounts.map(e => e.kind ?? (e.needsReauth ? "reauth" : classifySyncError(e.error ?? ""))),
    ...sites.map(e => e.kind ?? classifySyncError(e.error ?? "")),
  ];
  const rank: Record<SyncFailureKind, number> = { reauth: 0, quota: 1, network: 2, other: 3 };
  kinds.sort((a, b) => rank[a] - rank[b]);
  const failureKind = kinds[0] ?? null;
  const needsReauth = failureKind === "reauth" || accounts.some(e => e.needsReauth);
  const names = sites.map(e => e.site).filter((s): s is string => !!s);
  return { needsReauth, failureKind, sites: names };
}

export function scheduledRunFailed(result: {
  accountErrors?: readonly unknown[] | null;
  siteErrors?: readonly unknown[] | null;
} | null | undefined): boolean {
  if (!result) return false;
  return (result.accountErrors?.length ?? 0) > 0 || (result.siteErrors?.length ?? 0) > 0;
}

/**
 * One alert per failure streak, on the second consecutive scheduled failure.
 * A later failure in the same streak does not send again. Success clears the streak
 * and, if an alert went out, asks for a single recovery note.
 */
export function nextSyncHealth(prev: SyncHealthState, failed: boolean): {
  health: SyncHealthState;
  sendAlert: boolean;
  sendRecovery: boolean;
} {
  if (!failed) {
    return {
      health: { consecutiveFailures: 0, alerted: false },
      sendAlert: false,
      sendRecovery: prev.alerted,
    };
  }
  const consecutiveFailures = prev.consecutiveFailures + 1;
  const sendAlert = consecutiveFailures >= 2 && !prev.alerted;
  return {
    health: { consecutiveFailures, alerted: prev.alerted },
    sendAlert,
    sendRecovery: false,
  };
}

export type LastSuccessState = "never" | "stale" | "fresh";

/**
 * `now` is epoch ms. Null, blank, and unparseable timestamps are "never", not a dash.
 *
 * `staleAfterMs` defaults to the 48h site-card window (`GSC_SYNC_STALE_MS`). Rank checks
 * pass their own constant — keywords run every other day, so their badge goes yellow at
 * 72h. Omitting the argument leaves the site card exactly as it is.
 */
export function lastSuccessState(
  at: Date | string | null | undefined,
  now = Date.now(),
  staleAfterMs = GSC_SYNC_STALE_MS,
): LastSuccessState {
  if (at == null || at === "") return "never";
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(t)) return "never";
  return now - t > staleAfterMs ? "stale" : "fresh";
}

/** `MM-DD HH:mm` in Asia/Shanghai. Hour "24" from some ICU builds is midnight. */
export function formatLastSuccessStamp(at: Date, timeZone = GSC_SYNC_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? "00";
  let hour = pick("hour");
  if (hour === "24") hour = "00";
  return `${pick("month")}-${pick("day")} ${hour}:${pick("minute")}`;
}

export type AlertLang = "en" | "ru" | "uk" | "fr" | "es" | "de" | "zh";

type AlertCopy = {
  failTitle: (n: number) => string;
  sites: (list: string) => string;
  noSites: string;
  reasonLabel: string;
  actionLabel: string;
  reason: Record<SyncFailureKind, string>;
  action: Record<SyncFailureKind, string>;
  recovered: string;
};

const ALERT: Record<AlertLang, AlertCopy> = {
  en: {
    failTitle: n => `*OpenGSC* scheduled sync failed ${n} times in a row.`,
    sites: list => `Sites: ${list}`,
    noSites: "Sites: none could be listed (account-level failure).",
    reasonLabel: "Cause",
    actionLabel: "What to do",
    reason: {
      reauth: "Google authorization has expired or the refresh token was revoked (invalid_grant).",
      quota: "Google Search Console quota was exceeded.",
      network: "The connection to Google failed.",
      other: "The sync did not finish.",
    },
    action: {
      reauth: "Open OpenGSC, choose Re-authorize, sign in with Google and grant the full Search Console scope, then sync again.",
      quota: "Wait and let the next scheduled sync retry. If it keeps failing, check the Google Cloud quota.",
      network: "Check this server's connection to Google, then retry the sync.",
      other: "Open OpenGSC and read the sync warning on the dashboard.",
    },
    recovered: "*OpenGSC* scheduled sync has recovered. Search Console data is syncing again.",
  },
  zh: {
    failTitle: n => `*OpenGSC* 定时同步已连续失败 ${n} 次。`,
    sites: list => `站点：${list}`,
    noSites: "站点：未能列出任何站点（账号级失败）。",
    reasonLabel: "原因",
    actionLabel: "建议",
    reason: {
      reauth: "Google 授权已失效，刷新令牌被撤销或过期（invalid_grant）。",
      quota: "Google Search Console 配额已用尽。",
      network: "连接 Google 时出现网络错误。",
      other: "同步未能完成。",
    },
    action: {
      reauth: "打开 OpenGSC，点击「重新授权」，用 Google 重新登录并授予完整权限，然后再次同步。",
      quota: "请稍后再试。若持续失败，请检查 Google Cloud 配额。",
      network: "请检查服务器到 Google 的网络，然后手动重试或等待下一次定时同步。",
      other: "请打开 OpenGSC，查看仪表盘上的同步失败提示。",
    },
    recovered: "*OpenGSC* 定时同步已恢复。Google Search Console 再次同步成功。",
  },
  ru: {
    failTitle: n => `*OpenGSC* плановая синхронизация не выполнилась ${n} раза подряд.`,
    sites: list => `Сайты: ${list}`,
    noSites: "Сайты: список получить не удалось (ошибка аккаунта).",
    reasonLabel: "Причина",
    actionLabel: "Что сделать",
    reason: {
      reauth: "Авторизация Google истекла или refresh-токен отозван (invalid_grant).",
      quota: "Исчерпана квота Google Search Console.",
      network: "Нет соединения с Google.",
      other: "Синхронизация не завершилась.",
    },
    action: {
      reauth: "Откройте OpenGSC, нажмите «Авторизовать снова», войдите через Google с полными правами и запустите синхронизацию ещё раз.",
      quota: "Подождите следующую попытку. Если повторяется — проверьте квоту в Google Cloud.",
      network: "Проверьте связь сервера с Google и повторите синхронизацию.",
      other: "Откройте OpenGSC и прочитайте предупреждение на панели.",
    },
    recovered: "*OpenGSC* плановая синхронизация снова проходит. Данные Search Console обновляются.",
  },
  uk: {
    failTitle: n => `*OpenGSC* запланована синхронізація не вдалася ${n} рази поспіль.`,
    sites: list => `Сайти: ${list}`,
    noSites: "Сайти: список отримати не вдалося (помилка акаунта).",
    reasonLabel: "Причина",
    actionLabel: "Що зробити",
    reason: {
      reauth: "Авторизація Google недійсна або refresh-токен відкликано (invalid_grant).",
      quota: "Вичерпано квоту Google Search Console.",
      network: "Немає з'єднання з Google.",
      other: "Синхронізація не завершилась.",
    },
    action: {
      reauth: "Відкрийте OpenGSC, натисніть «Авторизувати знову», увійдіть через Google з повними правами й синхронізуйте ще раз.",
      quota: "Зачекайте на наступну спробу. Якщо повторюється — перевірте квоту в Google Cloud.",
      network: "Перевірте зв'язок сервера з Google і повторіть синхронізацію.",
      other: "Відкрийте OpenGSC і прочитайте попередження на панелі.",
    },
    recovered: "*OpenGSC* запланована синхронізація знову проходить. Дані Search Console оновлюються.",
  },
  fr: {
    failTitle: n => `*OpenGSC* : la synchro planifiée a échoué ${n} fois de suite.`,
    sites: list => `Sites : ${list}`,
    noSites: "Sites : liste impossible (échec du compte).",
    reasonLabel: "Cause",
    actionLabel: "Quoi faire",
    reason: {
      reauth: "L'autorisation Google a expiré ou le refresh token a été révoqué (invalid_grant).",
      quota: "Quota Google Search Console dépassé.",
      network: "Connexion à Google impossible.",
      other: "La synchronisation ne s'est pas terminée.",
    },
    action: {
      reauth: "Ouvrez OpenGSC, choisissez Réautoriser, reconnectez Google avec tous les droits, puis relancez la synchro.",
      quota: "Attendez la prochaine tentative. Si cela continue, vérifiez le quota Google Cloud.",
      network: "Vérifiez la connexion du serveur vers Google, puis relancez la synchro.",
      other: "Ouvrez OpenGSC et lisez l'avertissement sur le tableau de bord.",
    },
    recovered: "*OpenGSC* : la synchro planifiée est rétablie. Les données Search Console se mettent à jour.",
  },
  es: {
    failTitle: n => `*OpenGSC*: la sincronización programada falló ${n} veces seguidas.`,
    sites: list => `Sitios: ${list}`,
    noSites: "Sitios: no se pudo obtener la lista (fallo de la cuenta).",
    reasonLabel: "Causa",
    actionLabel: "Qué hacer",
    reason: {
      reauth: "La autorización de Google caducó o se revocó el refresh token (invalid_grant).",
      quota: "Se agotó la cuota de Google Search Console.",
      network: "Falló la conexión con Google.",
      other: "La sincronización no terminó.",
    },
    action: {
      reauth: "Abre OpenGSC, pulsa Volver a autorizar, entra con Google y concede el acceso completo, luego sincroniza de nuevo.",
      quota: "Espera al siguiente intento. Si sigue fallando, revisa la cuota en Google Cloud.",
      network: "Comprueba la conexión del servidor con Google y vuelve a sincronizar.",
      other: "Abre OpenGSC y lee el aviso de sincronización en el panel.",
    },
    recovered: "*OpenGSC*: la sincronización programada se ha recuperado. Search Console vuelve a sincronizarse.",
  },
  de: {
    failTitle: n => `*OpenGSC*: der geplante Sync ist ${n}-mal hintereinander fehlgeschlagen.`,
    sites: list => `Websites: ${list}`,
    noSites: "Websites: Liste nicht abrufbar (Kontofehler).",
    reasonLabel: "Ursache",
    actionLabel: "Was tun",
    reason: {
      reauth: "Die Google-Autorisierung ist abgelaufen oder das Refresh-Token wurde widerrufen (invalid_grant).",
      quota: "Das Google-Search-Console-Kontingent ist aufgebraucht.",
      network: "Die Verbindung zu Google ist fehlgeschlagen.",
      other: "Der Sync wurde nicht abgeschlossen.",
    },
    action: {
      reauth: "OpenGSC öffnen, Erneut autorisieren wählen, mit Google und vollem Zugriff anmelden und danach erneut synchronisieren.",
      quota: "Auf den nächsten Versuch warten. Wenn es weiter fehlschlägt, das Google-Cloud-Kontingent prüfen.",
      network: "Die Verbindung des Servers zu Google prüfen und den Sync wiederholen.",
      other: "OpenGSC öffnen und die Sync-Warnung auf dem Dashboard lesen.",
    },
    recovered: "*OpenGSC*: der geplante Sync läuft wieder. Search-Console-Daten werden erneut synchronisiert.",
  },
};

export function normalizeAlertLang(v: unknown): AlertLang {
  return v === "ru" || v === "uk" || v === "fr" || v === "es" || v === "de" || v === "zh" ? v : "en";
}

function siteLine(copy: AlertCopy, sites: string[], lang: AlertLang): string {
  const unique = [...new Set(sites.map(s => s.trim()).filter(Boolean))];
  if (unique.length === 0) return copy.noSites;
  const sep = lang === "zh" ? "、" : ", ";
  const shown = unique.slice(0, 15);
  const extra = unique.length > shown.length ? (lang === "zh" ? ` 等 ${unique.length} 个` : ` (+${unique.length - shown.length})`) : "";
  return copy.sites(shown.join(sep) + extra);
}

export function formatSyncFailureAlert(
  lang: AlertLang,
  input: { sites: string[]; kind: SyncFailureKind; consecutive: number },
): string {
  const copy = ALERT[lang] ?? ALERT.en;
  const kind = input.kind;
  // Chinese labels use a full-width colon, the same mark as 「站点：」. A half-width
  // colon after 原因/建议 was the odd one out in the Telegram text.
  const label = (name: string, value: string) =>
    lang === "zh" ? `${name}：${value}` : `${name}: ${value}`;
  return [
    copy.failTitle(input.consecutive),
    "",
    siteLine(copy, input.sites, lang),
    label(copy.reasonLabel, copy.reason[kind]),
    label(copy.actionLabel, copy.action[kind]),
  ].join("\n");
}

export function formatSyncRecoveryAlert(lang: AlertLang): string {
  return (ALERT[lang] ?? ALERT.en).recovered;
}

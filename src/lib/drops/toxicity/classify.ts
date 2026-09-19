import type { DomainEvidence, ScriptName, Snapshot, SnapshotVerdict, ToxOptions, ToxReport, ToxSignal } from "./types";
import { isNativeScriptForZone, isParked, MARKERS, matchMarkers, normaliseText, scriptsOf } from "./markers";

/**
 * Every signal code the classifier can emit — marker groups over titles/texts and their
 * `anchor_` twins from classifyAnchors, plus the structural codes. The UI translates these
 * 1:1 as `dropsToxSignal_<code>` keys; tox-codes.test.ts pins the key set to this list in
 * both directions, the same contract KNOWN_GLUE_FINDINGS holds for the glue findings.
 */
export const KNOWN_TOX_SIGNALS: readonly string[] = [
  ...MARKERS.map(g => g.code),
  ...MARKERS.map(g => `anchor_${g.code}`),
  "alien_script",
  "anchor_alien_script",
  "redirect_offsite",
  "snapshot_error",
  "language_flip",
  "never_used",
  "no_snapshots",
];

const DEFAULT_TOXIC_AT = 60;
const DEFAULT_SUSPICIOUS_AT = 25;

/**
 * Свежесть важнее давности: гембл-флип 2015 года пережит доменом и
 * поисковиком, тот же флип в прошлом году — ещё нет.
 */
export function recencyFactor(timestamp: string, now: Date): number {
  const when = parseCdxTimestamp(timestamp);
  if (!when) return 0.6;
  const months = (now.getTime() - when.getTime()) / (30 * 24 * 3600 * 1000);
  if (months <= 24) return 1;
  if (months <= 60) return 0.6;
  return 0.35;
}

export function parseCdxTimestamp(ts: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec((ts ?? "").trim());
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function classifySnapshot(snap: Snapshot, domain: string): SnapshotVerdict {
  const signals: ToxSignal[] = [];
  const title = snap.title ?? "";
  const haystack = `${title} ${snap.text ?? ""}`.trim();
  const parked = isParked(haystack) || (!normaliseText(haystack) && !snap.redirectTo);

  const scripts = scriptsOf(haystack);

  for (const { group, hits } of matchMarkers(haystack)) {
    signals.push({
      code: group.code,
      weight: group.weight,
      detail: hits.slice(0, 4).join(", "),
      timestamp: snap.timestamp,
    });
  }

  for (const script of scripts) {
    if (script === "latin") continue;
    if (isNativeScriptForZone(script, domain)) continue;
    signals.push({
      code: "alien_script",
      weight: script === "cjk" ? 35 : 25,
      detail: `${script} в зоне ${zoneOf(domain)}`,
      timestamp: snap.timestamp,
    });
  }

  if (snap.redirectTo && !sameHost(snap.redirectTo, domain)) {
    signals.push({
      code: "redirect_offsite",
      weight: 20,
      detail: `снимок редиректит на ${snap.redirectTo}`,
      timestamp: snap.timestamp,
    });
  }

  if (typeof snap.status === "number" && snap.status >= 400) {
    signals.push({
      code: "snapshot_error",
      weight: 0,
      detail: `HTTP ${snap.status}`,
      timestamp: snap.timestamp,
    });
  }

  return { timestamp: snap.timestamp, scripts, parked, signals };
}

/**
 * Анкоры входящих ссылок. Свежести у них нет (это сегодняшний профиль),
 * поэтому множитель не применяется. Вес выше снапшотного: анкор пишет
 * донор, а не владелец домена, подделать его в свою пользу нельзя.
 */
export function classifyAnchors(anchors: string[], domain: string): ToxSignal[] {
  const signals: ToxSignal[] = [];
  const text = anchors.join(" \n ");
  if (!normaliseText(text)) return signals;

  for (const { group, hits } of matchMarkers(text)) {
    signals.push({
      code: `anchor_${group.code}`,
      weight: group.code === "gambling_generic" ? 20 : 50,
      detail: hits.slice(0, 4).join(", "),
    });
  }

  for (const script of scriptsOf(text)) {
    if (script === "latin") continue;
    if (isNativeScriptForZone(script, domain)) continue;
    signals.push({
      code: "anchor_alien_script",
      weight: 30,
      detail: `${script} в анкорах, зона ${zoneOf(domain)}`,
    });
  }

  return signals;
}

export function classifyDomain(evidence: DomainEvidence, opts: ToxOptions = {}): ToxReport {
  const now = opts.now ?? evidence.now ?? new Date();
  const toxicAt = opts.toxicAt ?? DEFAULT_TOXIC_AT;
  const suspiciousAt = opts.suspiciousAt ?? DEFAULT_SUSPICIOUS_AT;

  const perSnapshot = evidence.snapshots.map((s) => classifySnapshot(s, evidence.domain));
  const signals: ToxSignal[] = [];
  let score = 0;

  for (const snap of perSnapshot) {
    const factor = recencyFactor(snap.timestamp, now);
    for (const signal of snap.signals) {
      if (!signal.weight) {
        signals.push(signal);
        continue;
      }
      const weighted = Math.round(signal.weight * factor);
      score += weighted;
      signals.push({ ...signal, weight: weighted });
    }
  }

  for (const signal of classifyAnchors(evidence.anchors ?? [], evidence.domain)) {
    score += signal.weight;
    signals.push(signal);
  }

  // Смена письменности между снимками: домен переходил из рук в руки.
  const contentful = perSnapshot.filter((s) => !s.parked && s.scripts.length);
  const profiles = new Set(contentful.map((s) => nonLatin(s.scripts).join("+") || "latin"));
  if (profiles.size > 1) {
    const signal: ToxSignal = {
      code: "language_flip",
      weight: 20,
      detail: `язык главной менялся: ${[...profiles].join(" → ")}`,
    };
    score += signal.weight;
    signals.push(signal);
  }

  const neverUsed = perSnapshot.length > 0 && perSnapshot.every((s) => s.parked);
  if (neverUsed) {
    signals.push({ code: "never_used", weight: 0, detail: "во всех снимках паркинг или пустая страница" });
  }

  let verdict: ToxReport["verdict"];
  if (score >= toxicAt) {
    verdict = "toxic";
  } else if (!perSnapshot.length) {
    verdict = score >= suspiciousAt ? "suspicious" : "empty";
    signals.push({ code: "no_snapshots", weight: 0, detail: "вебархив не дал ни одного снимка" });
  } else if (score >= toxicAt) {
    verdict = "toxic";
  } else if (score >= suspiciousAt) {
    verdict = "suspicious";
  } else if (neverUsed) {
    verdict = "empty";
  } else {
    verdict = "clean";
  }

  return { domain: evidence.domain, verdict, score, signals, perSnapshot, neverUsed };
}

/** Домены, которые стоит доотправить в платный AI-проход: только спорные. */
export function needsDeepCheck(report: ToxReport): boolean {
  return report.verdict === "suspicious" || (report.verdict === "empty" && !report.neverUsed);
}

function nonLatin(scripts: ScriptName[]): ScriptName[] {
  return scripts.filter((s) => s !== "latin");
}

function zoneOf(domain: string): string {
  const parts = domain.toLowerCase().split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : parts.slice(-1)[0];
}

function sameHost(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === domain.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
}

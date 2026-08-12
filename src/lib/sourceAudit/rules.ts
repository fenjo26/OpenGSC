export type SourceAuditSeverity = "error" | "warning" | "info";
export type SourceAuditCategory = "seo" | "performance" | "correctness" | "security" | "architecture";
export type SourceFramework = "nextjs" | "generic";

export interface SourceFile {
  path: string;
  content: string;
  size: number;
}

export interface SourceFinding {
  ruleId: string;
  severity: SourceAuditSeverity;
  category: SourceAuditCategory;
  path: string | null;
  line: number | null;
  evidence: string;
  confidence: "high" | "medium";
}

export interface SourceAuditContext {
  framework: SourceFramework;
  files: SourceFile[];
  byPath: Map<string, SourceFile>;
}

export interface SourceAuditRule {
  id: string;
  severity: SourceAuditSeverity;
  category: SourceAuditCategory;
  frameworks: readonly SourceFramework[];
  evaluate(context: SourceAuditContext): SourceFinding[];
}

export interface SourceAuditReport {
  framework: SourceFramework;
  score: number;
  summary: {
    total: number;
    errors: number;
    warnings: number;
    info: number;
    categories: Record<SourceAuditCategory, number>;
  };
  findings: SourceFinding[];
}

const CODE = /\.(?:[cm]?[jt]sx?|mdx)$/i;
const JSX = /\.(?:jsx|tsx|mdx)$/i;
const ROUTE = /(?:^|\/)app\/(?:.*\/)?route\.[cm]?[jt]s$/i;
const MAX_FINDINGS = 200;

function lineAt(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split("\n").length;
}

function finding(rule: SourceAuditRule, path: string | null, line: number | null, evidence: string, confidence: "high" | "medium" = "high"): SourceFinding {
  return { ruleId: rule.id, severity: rule.severity, category: rule.category, path, line, evidence: evidence.slice(0, 240), confidence };
}

function matchingFiles(context: SourceAuditContext, pattern: RegExp): SourceFile[] {
  return context.files.filter(file => pattern.test(file.path));
}

function rootAppFile(context: SourceAuditContext, name: string): SourceFile | undefined {
  return context.files.find(file => new RegExp(`^(?:src/)?app/${name}\\.[cm]?[jt]sx?$`, "i").test(file.path));
}

function repositoryHas(context: SourceAuditContext, patterns: RegExp[]): boolean {
  return context.files.some(file => patterns.some(pattern => pattern.test(file.path)));
}

const metadataRule: SourceAuditRule = {
  id: "source.next.metadata_missing",
  severity: "warning",
  category: "seo",
  frameworks: ["nextjs"],
  evaluate(context) {
    const layout = rootAppFile(context, "layout");
    if (!layout || /export\s+(?:const\s+(?:metadata|generateMetadata)\b|(?:async\s+)?function\s+generateMetadata\b)/.test(layout.content)) return [];
    return [finding(this, layout.path, 1, "Root App Router layout exports neither metadata nor generateMetadata", "medium")];
  },
};

const sitemapRule: SourceAuditRule = {
  id: "source.next.sitemap_missing",
  severity: "info",
  category: "seo",
  frameworks: ["nextjs"],
  evaluate(context) {
    return repositoryHas(context, [/(?:^|\/)(?:src\/)?app\/sitemap\.[cm]?[jt]s$/i, /(?:^|\/)public\/sitemap\.xml$/i])
      ? [] : [finding(this, null, null, "No App Router sitemap file or public/sitemap.xml found")];
  },
};

const robotsRule: SourceAuditRule = {
  id: "source.next.robots_missing",
  severity: "info",
  category: "seo",
  frameworks: ["nextjs"],
  evaluate(context) {
    return repositoryHas(context, [/(?:^|\/)(?:src\/)?app\/robots\.[cm]?[jt]s$/i, /(?:^|\/)public\/robots\.txt$/i])
      ? [] : [finding(this, null, null, "No App Router robots file or public/robots.txt found")];
  },
};

const rawImageRule: SourceAuditRule = {
  id: "source.next.raw_img",
  severity: "warning",
  category: "performance",
  frameworks: ["nextjs"],
  evaluate(context) {
    const results: SourceFinding[] = [];
    for (const file of matchingFiles(context, JSX)) {
      const regex = /<img\b/gi;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(file.content)) && results.length < 30) {
        const line = file.content.slice(file.content.lastIndexOf("\n", match.index) + 1, file.content.indexOf("\n", match.index) < 0 ? undefined : file.content.indexOf("\n", match.index));
        if (/source-audit-ignore\s+source\.next\.raw_img/i.test(line)) continue;
        results.push(finding(this, file.path, lineAt(file.content, match.index), "Raw <img> bypasses Next.js image optimization", "medium"));
      }
    }
    return results;
  },
};

const imageAltRule: SourceAuditRule = {
  id: "source.next.image_alt_missing",
  severity: "warning",
  category: "seo",
  frameworks: ["nextjs"],
  evaluate(context) {
    const results: SourceFinding[] = [];
    for (const file of matchingFiles(context, JSX)) {
      const regex = /<(?:Image|img)\b([\s\S]{0,700}?)\/?\s*>/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(file.content)) && results.length < 30) {
        if (!/\balt\s*=/.test(match[1])) results.push(finding(this, file.path, lineAt(file.content, match.index), "Image element has no alt prop", "medium"));
      }
    }
    return results;
  },
};

const fontRule: SourceAuditRule = {
  id: "source.next.external_font",
  severity: "warning",
  category: "performance",
  frameworks: ["nextjs"],
  evaluate(context) {
    const results: SourceFinding[] = [];
    for (const file of context.files) {
      const match = file.content.match(/(?:@import\s+(?:url\()?|href\s*=\s*["'])https:\/\/fonts\.(?:googleapis|gstatic)\.com/i);
      if (match) results.push(finding(this, file.path, lineAt(file.content, match.index ?? 0), "Browser loads Google Fonts directly instead of next/font", "high"));
    }
    return results;
  },
};

const publicSecretRule: SourceAuditRule = {
  id: "source.security.public_secret_name",
  severity: "error",
  category: "security",
  frameworks: ["nextjs", "generic"],
  evaluate(context) {
    const results: SourceFinding[] = [];
    for (const file of matchingFiles(context, CODE)) {
      const regex = /\b(NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|PRIVATE|TOKEN)[A-Z0-9_]*)\b/g;
      const seen = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = regex.exec(file.content)) && results.length < 30) {
        if (seen.has(match[1])) continue;
        seen.add(match[1]);
        results.push(finding(this, file.path, lineAt(file.content, match.index), `Public environment variable name: ${match[1]}`));
      }
    }
    return results;
  },
};

const clientEnvRule: SourceAuditRule = {
  id: "source.next.server_env_in_client",
  severity: "warning",
  category: "correctness",
  frameworks: ["nextjs"],
  evaluate(context) {
    const results: SourceFinding[] = [];
    for (const file of matchingFiles(context, CODE)) {
      if (!/^\s*["']use client["'];?/m.test(file.content)) continue;
      const regex = /process\.env\.([A-Z][A-Z0-9_]*)/g;
      let match: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((match = regex.exec(file.content)) && results.length < 30) {
        if (match[1] === "NODE_ENV" || match[1].startsWith("NEXT_PUBLIC_") || seen.has(match[1])) continue;
        seen.add(match[1]);
        results.push(finding(this, file.path, lineAt(file.content, match.index), `Server-only environment variable referenced by a Client Component: ${match[1]}`));
      }
    }
    return results;
  },
};

const jsonLdRule: SourceAuditRule = {
  id: "source.next.jsonld_not_escaped",
  severity: "error",
  category: "security",
  frameworks: ["nextjs"],
  evaluate(context) {
    const results: SourceFinding[] = [];
    for (const file of matchingFiles(context, JSX)) {
      const type = file.content.search(/application\/ld\+json/i);
      if (type < 0 || !/JSON\.stringify\s*\(/.test(file.content)) continue;
      if (/\.replace\s*\(\s*\/</.test(file.content) || /serialize(?:JavaScript)?\s*\(/i.test(file.content)) continue;
      results.push(finding(this, file.path, lineAt(file.content, type), "JSON-LD serialization does not visibly escape '<'", "high"));
    }
    return results;
  },
};

const dangerousHtmlRule: SourceAuditRule = {
  id: "source.security.unsafe_html_review",
  severity: "warning",
  category: "security",
  frameworks: ["nextjs", "generic"],
  evaluate(context) {
    const results: SourceFinding[] = [];
    for (const file of matchingFiles(context, JSX)) {
      const regex = /dangerouslySetInnerHTML\s*=/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(file.content)) && results.length < 30) {
        const nearbyTag = file.content.slice(Math.max(0, file.content.lastIndexOf("<", match.index)), match.index + 200);
        if (/application\/ld\+json/i.test(nearbyTag)) continue;
        results.push(finding(this, file.path, lineAt(file.content, match.index), "Non-JSON-LD dangerouslySetInnerHTML requires a sanitization review", "medium"));
      }
    }
    return results;
  },
};

const rawFetchRule: SourceAuditRule = {
  id: "source.security.user_url_raw_fetch",
  severity: "error",
  category: "security",
  frameworks: ["nextjs"],
  evaluate(context) {
    const results: SourceFinding[] = [];
    for (const file of matchingFiles(context, ROUTE)) {
      if (/\bsafeFetch\b/.test(file.content) || !/(?:\.json\s*\(|searchParams|get\s*\(["'])/.test(file.content)) continue;
      const variable = file.content.match(/(?:const|let)\s+([A-Za-z_$][\w$]*(?:url|target|href)[\w$]*)\s*=\s*[^;\n]*(?:body|searchParams|params)/i)?.[1];
      if (!variable) continue;
      const fetchMatch = file.content.match(new RegExp(`\\bfetch\\s*\\(\\s*${variable.replace(/[$]/g, "\\$")}\\b`));
      if (fetchMatch?.index != null) results.push(finding(this, file.path, lineAt(file.content, fetchMatch.index), `User-derived ${variable} reaches fetch() without the shared safe fetch boundary`, "high"));
    }
    return results;
  },
};

const remoteImageRule: SourceAuditRule = {
  id: "source.next.remote_image_wildcard",
  severity: "error",
  category: "security",
  frameworks: ["nextjs"],
  evaluate(context) {
    const config = context.files.find(file => /(?:^|\/)next\.config\.[cm]?[jt]s$/i.test(file.path));
    if (!config || !/(?:hostname\s*:\s*["']\*{1,2}["']|domains\s*:\s*\[\s*["']\*["'])/.test(config.content)) return [];
    const index = config.content.search(/(?:hostname|domains)\s*:/);
    return [finding(this, config.path, lineAt(config.content, Math.max(0, index)), "Next Image remote allowlist contains a wildcard host")];
  },
};

const routeConflictRule: SourceAuditRule = {
  id: "source.next.page_route_conflict",
  severity: "error",
  category: "correctness",
  frameworks: ["nextjs"],
  evaluate(context) {
    const paths = new Set(context.files.map(file => file.path.toLowerCase().replace(/\.[cm]?[jt]sx?$/, "")));
    const results: SourceFinding[] = [];
    for (const file of context.files.filter(file => /(?:^|\/)route\.[cm]?[jt]s$/i.test(file.path))) {
      const base = file.path.toLowerCase().replace(/route\.[cm]?[jt]s$/, "page");
      if (paths.has(base)) results.push(finding(this, file.path, 1, "A page and Route Handler share the same route segment"));
    }
    return results;
  },
};

const clientSizeRule: SourceAuditRule = {
  id: "source.architecture.large_client_component",
  severity: "info",
  category: "architecture",
  frameworks: ["nextjs"],
  evaluate(context) {
    return matchingFiles(context, CODE)
      .filter(file => /^\s*["']use client["'];?/m.test(file.content) && (file.content.length > 50_000 || file.content.split("\n").length > 800))
      .slice(0, 20)
      .map(file => finding(this, file.path, 1, `${file.content.split("\n").length} lines in one Client Component`, "medium"));
  },
};

export const SOURCE_AUDIT_RULES: readonly SourceAuditRule[] = [
  metadataRule, sitemapRule, robotsRule, rawImageRule, imageAltRule, fontRule,
  publicSecretRule, clientEnvRule, jsonLdRule, dangerousHtmlRule, rawFetchRule,
  remoteImageRule, routeConflictRule, clientSizeRule,
];

export const SOURCE_AUDIT_RULE_BY_ID = new Map(SOURCE_AUDIT_RULES.map(rule => [rule.id, rule]));

export function detectFramework(files: SourceFile[]): SourceFramework {
  const pkg = files.find(file => file.path === "package.json");
  if (pkg) {
    try {
      const body = JSON.parse(pkg.content);
      if (body?.dependencies?.next || body?.devDependencies?.next) return "nextjs";
    } catch { /* malformed package.json gets handled by the build, not guessed here */ }
  }
  return files.some(file => /^(?:src\/)?app\/(?:layout|page)\.[cm]?[jt]sx?$/.test(file.path)) ? "nextjs" : "generic";
}

export function analyzeSource(files: SourceFile[]): SourceAuditReport {
  const framework = detectFramework(files);
  const context: SourceAuditContext = { framework, files, byPath: new Map(files.map(file => [file.path, file])) };
  const findings = SOURCE_AUDIT_RULES
    .filter(rule => rule.frameworks.includes(framework))
    .flatMap(rule => rule.evaluate(context))
    .slice(0, MAX_FINDINGS);
  const categories: Record<SourceAuditCategory, number> = { seo: 0, performance: 0, correctness: 0, security: 0, architecture: 0 };
  for (const item of findings) categories[item.category]++;
  const errors = findings.filter(item => item.severity === "error").length;
  const warnings = findings.filter(item => item.severity === "warning").length;
  const info = findings.filter(item => item.severity === "info").length;
  const scorePenalty = [...new Set(findings.map(item => item.ruleId))].reduce((total, ruleId) => {
    const sameRule = findings.filter(item => item.ruleId === ruleId);
    if (sameRule[0]?.severity === "error") return total + 12 + Math.min(9, Math.max(0, sameRule.length - 1) * 3);
    if (sameRule[0]?.severity === "warning") return total + 4 + Math.min(4, Math.max(0, sameRule.length - 1));
    return total;
  }, 0);
  return {
    framework,
    // Repeated occurrences remain visible, but one widespread pattern cannot zero the report.
    score: Math.max(0, Math.round(100 - scorePenalty)),
    summary: { total: findings.length, errors, warnings, info, categories },
    findings,
  };
}

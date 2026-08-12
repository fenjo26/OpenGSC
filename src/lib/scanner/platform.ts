/**
 * What a site is built with, read from what it already tells the world.
 *
 * Every detector here works on markup and headers that the server hands out voluntarily. Nothing
 * probes for vulnerabilities, nothing sends a payload, and nothing tries a credential — this is the
 * same information a browser receives, organised. The WordPress paths are the exception worth
 * naming: `/wp-json/wp/v2/users` is a public endpoint that many installs leave open, and it lists
 * author usernames. Reporting that a competitor exposes it is the point; it is a finding about
 * their configuration, not an attack on it.
 */

export interface PlatformReport {
  cms: string | null;
  generator: string | null;
  framework: string | null;
  server: string | null;
  poweredBy: string | null;
  hints: string[];
}

const CMS_MARKERS: Array<[RegExp, string]> = [
  [/wp-content\/|wp-includes\/|\/wp-json\b/i, "WordPress"],
  [/cdn\.shopify\.com|Shopify\.theme/i, "Shopify"],
  [/static\.tildacdn\.com|tilda/i, "Tilda"],
  [/bitrix\/js\/|BX\.message/i, "1C-Bitrix"],
  [/\/media\/jui\/|joomla/i, "Joomla"],
  [/sites\/default\/files|drupal-settings-json/i, "Drupal"],
  [/wixstatic\.com|wix-code/i, "Wix"],
  [/squarespace\.com|static1\.squarespace/i, "Squarespace"],
  [/webflow\.js|assets-global\.website-files\.com/i, "Webflow"],
  [/opencart|catalog\/view\/theme/i, "OpenCart"],
  [/_next\/static\//i, "Next.js"],
  [/\/_nuxt\//i, "Nuxt"],
  [/data-astro-|astro-island/i, "Astro"],
];

export function detectPlatform(html: string, headers: Record<string, string>): PlatformReport {
  const generator = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i)?.[1]?.trim() ?? null;
  const hits = CMS_MARKERS.filter(([pattern]) => pattern.test(html)).map(([, name]) => name);
  const framework = hits.find(name => ["Next.js", "Nuxt", "Astro"].includes(name)) ?? null;
  const cms = hits.find(name => !["Next.js", "Nuxt", "Astro"].includes(name))
    ?? (generator ? generator.split(" ")[0] : null);

  const hints: string[] = [];
  if (/cloudflare/i.test(headers["server"] ?? "") || headers["cf-ray"]) hints.push("Cloudflare");
  if (headers["x-vercel-id"] || /vercel/i.test(headers["server"] ?? "")) hints.push("Vercel");
  if (headers["x-nf-request-id"]) hints.push("Netlify");
  if (/litespeed/i.test(headers["server"] ?? "")) hints.push("LiteSpeed");
  if (headers["x-powered-by"]) hints.push(headers["x-powered-by"].slice(0, 60));
  if (/elementor/i.test(html)) hints.push("Elementor");
  if (/yoast|wp-seo/i.test(html)) hints.push("Yoast SEO");
  if (/rank-math/i.test(html)) hints.push("Rank Math");
  if (/woocommerce/i.test(html)) hints.push("WooCommerce");

  return {
    cms,
    generator,
    framework,
    server: headers["server"]?.slice(0, 80) ?? null,
    poweredBy: headers["x-powered-by"]?.slice(0, 80) ?? null,
    hints: [...new Set(hints)].slice(0, 10),
  };
}

/** WordPress theme and plugin slugs, straight out of the asset URLs the page already loads. */
export function wordpressAssets(html: string): { themes: string[]; plugins: string[] } {
  const themes = [...html.matchAll(/wp-content\/themes\/([a-z0-9_-]+)/gi)].map(m => m[1].toLowerCase());
  const plugins = [...html.matchAll(/wp-content\/plugins\/([a-z0-9_-]+)/gi)].map(m => m[1].toLowerCase());
  return {
    themes: [...new Set(themes)].slice(0, 5),
    plugins: [...new Set(plugins)].slice(0, 25),
  };
}

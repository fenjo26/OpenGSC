// N8 — PDF from the frozen HTML snapshot, through Playwright (already a dependency —
// no new packages). The import is dynamic and non-literal, exactly like richResults.ts:
// an instance without a browser must degrade to "PDF unavailable, download the HTML",
// never crash the report run. The HTML itself is scriptless, so the browser renders a
// static document — setContent, pdf, close, nothing else.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** The minimal Playwright surface this function touches — keeps the optional dep untyped. */
interface PdfPage {
  setContent(html: string, opts?: Record<string, unknown>): Promise<void>;
  pdf(opts?: Record<string, unknown>): Promise<Uint8Array | ArrayBuffer>;
}
interface PdfContext { newPage(): Promise<PdfPage> }
interface PdfBrowser { newContext(): Promise<PdfContext>; close(): Promise<void> }
interface ChromiumModule { launch(opts?: Record<string, unknown>): Promise<PdfBrowser> }

/** data/reports/<runId>.pdf — relative to the process cwd (the app root). */
export function reportPdfPath(runId: string): string {
  return path.join(process.cwd(), "data", "reports", `${runId}.pdf`);
}

export interface PdfResult {
  ok: boolean;
  /** "playwright_not_installed" | "pdf_failed"; absent when ok. */
  error?: string;
  path?: string;
}

export async function renderReportPdf(runId: string, html: string): Promise<PdfResult> {
  // Non-literal specifier keeps playwright an optional runtime dep (richResults pattern).
  const spec = "playwright";
  let chromium: ChromiumModule;
  try {
    const mod = (await import(spec)) as { chromium?: ChromiumModule };
    chromium = mod.chromium!;
    if (!chromium) throw new Error("no chromium");
  } catch {
    return { ok: false, error: "playwright_not_installed" };
  }

  let browser: PdfBrowser | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 60_000 });
    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" },
    });
    const file = reportPdfPath(runId);
    await mkdir(path.dirname(file), { recursive: true });
    // playwright types the PDF as Buffer | ArrayBuffer depending on the runtime — writeFile
    // takes the typed view either way, without a Buffer.from coercion round-trip.
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    await writeFile(file, bytes);
    return { ok: true, path: file };
  } catch {
    return { ok: false, error: "pdf_failed" };
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
  }
}

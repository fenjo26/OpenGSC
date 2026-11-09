// wave-ext E5 — browser SERP captures: validation, storage and the shapes the SERP Monitor
// "Browser captures" tab reads. E0 lays the signatures (CONTRACT/E5 §1); bodies land with E5.
//
// A capture never touches SerpSnapshot/SerpKeyword/SerpProjectHost/SerpChange — see the model
// comment in schema.prisma; that isolation is the whole point of the separate table.
import type { HostChange } from "@/lib/serpmon/types";
import type { CaptureRequest, CaptureResponse } from "./types";

/** Pure validation/normalisation of the client body. `keyword` is the normalised query. */
export function validateCapture(body: unknown):
  { ok: true; value: CaptureRequest & { keyword: string } } | { ok: false; error: string } {
  void body;
  throw new Error("not_implemented");
}

/** Upsert into SerpCapture (EXT_CAPTURE_DEDUPE_MS duplicate → update), filling the SerpUrl/
 *  SerpHost dictionaries via ensureUrls and fire-and-forget-enriching new hosts. */
export async function saveCapture(userId: string, input: CaptureRequest & { keyword: string }): Promise<CaptureResponse> {
  void userId; void input;
  throw new Error("not_implemented");
}

export interface CaptureListItem {
  id: string; keyword: string; engineHost: string; country: string; lang: string;
  page: number; got: number; capturedAt: string; projectId: string | null; keywordId: string | null;
  features: string[];
}

export interface CaptureView extends CaptureListItem {
  rows: { position: number; url: string; host: string; title: string; snippet: string }[];
  compare: null | { snapshotId: string; takenAt: string; depth: number; changes: HostChange[] };
}

export async function listCaptures(userId: string, q: { projectId?: string; keyword?: string; limit: number }): Promise<CaptureListItem[]> {
  void userId; void q;
  throw new Error("not_implemented");
}

export async function captureView(userId: string, id: string, compare?: "nearest" | string): Promise<CaptureView | null> {
  void userId; void id; void compare;
  throw new Error("not_implemented");
}

export async function deleteCapture(userId: string, id: string): Promise<boolean> {
  void userId; void id;
  throw new Error("not_implemented");
}

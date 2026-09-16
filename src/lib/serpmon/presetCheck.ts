// SERP Monitor — does the SE::Google preset a project names exist on the A-Parser instance?
//
// Checked when a project is saved, so a typo ("opengcs") is refused in the dialog instead of
// failing every keyword of the next run. Best-effort by design: an instance that is offline or
// not configured yet must not block saving settings — only an explicit "no such preset" does.

import { aparserParserPreset, isMissingParserPreset } from "@/lib/seo/aparser";
import { APARSER_SERP_PARSERS } from "@/lib/seo/aparserSerp";
import { getAparserServerCreds } from "@/lib/seo/aparserServerCreds";
import { InputError, normalizeAparserPreset } from "./store";

export async function assertAparserPresetExists(userId: string, raw: unknown): Promise<void> {
  const preset = normalizeAparserPreset(raw);
  if (preset === "default") return; // always there
  const creds = await getAparserServerCreds(userId);
  if (!creds) return;
  const r = await aparserParserPreset(creds, APARSER_SERP_PARSERS.google, preset).catch(() => null);
  if (r && !r.data && isMissingParserPreset(r.error)) throw new InputError("aparser_preset_missing");
}

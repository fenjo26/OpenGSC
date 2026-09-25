// T3 (docs/tasks/wave-oct/T3-notify-channels.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { NotifyEvent } from "./types";

export function toDiscordChunks(text: string): string[] {
  throw new Error("wave: toDiscordChunks not implemented (T3)");
}

export function toTeamsCard(title: string, text: string): object {
  throw new Error("wave: toTeamsCard not implemented (T3)");
}

export function toEmail(title: string, text: string): { subject: string; text: string; html: string } {
  throw new Error("wave: toEmail not implemented (T3)");
}

export function toWebhookBody(event: NotifyEvent, title: string, text: string, instance: string): string {
  throw new Error("wave: toWebhookBody not implemented (T3)");
}

export function signWebhook(secret: string, body: string): string {
  throw new Error("wave: signWebhook not implemented (T3)");
}

export function eventAllowed(events: NotifyEvent[] | undefined, event: NotifyEvent): boolean {
  throw new Error("wave: eventAllowed not implemented (T3)");
}

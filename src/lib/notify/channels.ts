// T3 (docs/tasks/wave-oct/T3-notify-channels.md) owns this file and replaces the throwing bodies.
// The signatures below are the wave contract (CONTRACT.md §3) — every caller in the wave
// compiles against them from the first commit.

import type { NotifyChannelId, NotifyChannelView, NotifyChannelsConfig, NotifyDelivery } from "./types";

export async function readChannels(userId: string): Promise<NotifyChannelsConfig> {
  throw new Error("wave: readChannels not implemented (T3)");
}

export async function channelViews(userId: string): Promise<NotifyChannelView[]> {
  throw new Error("wave: channelViews not implemented (T3)");
}

export async function saveChannel(userId: string, id: Exclude<NotifyChannelId, "telegram" | "slack">, patch: Record<string, unknown>): Promise<NotifyChannelView> {
  throw new Error("wave: saveChannel not implemented (T3)");
}

export async function testChannel(userId: string, id: NotifyChannelId): Promise<NotifyDelivery> {
  throw new Error("wave: testChannel not implemented (T3)");
}

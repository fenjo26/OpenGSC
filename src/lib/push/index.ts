// N10 (docs/tasks/wave-nov/N10-pwa-push.md) — web push as a notify channel.
// Public surface of src/lib/push: routes and the notify stack import from here.
//
//   payload.ts      — pure payload building (markdown strip, 240-char body, URL by event)
//   subscription.ts — pure per-row delivery rules (404/410, five consecutive failures)
//   vapid.ts        — VAPID keys: env override, else generated once into InstanceSetting
//   store.ts        — PushSubscription rows (owner + accepted members audience)
//   send.ts         — web-push delivery + notify fan-out entry point

export { buildPushPayload, matchSiteDomain, hostnameOf, urlForEvent, stripMarkdown, parseEventsFilter, MAX_BODY_CHARS, MAX_TITLE_CHARS, type PushPayload } from "./payload";
export { subscriptionAllows, outcomeForAttempt, isGoneStatus, MAX_CONSECUTIVE_FAILURES, type SubscriptionOutcome } from "./subscription";
export { getVapidKeys, vapidFromEnv, vapidSubjectFromEnv, type VapidKeys } from "./vapid";
export {
  pushSchemaMissing, listUserSubscriptions, listWorkspaceSubscriptions, workspaceRecipientIds,
  workspaceSiteDomains, pushChannelSummary, upsertSubscription, deleteSubscription,
  updateSubscriptionEvents, markAttempt, eventsToCsv, csvToEvents, type PushSubRow, type SubscribeInput,
} from "./store";
export { pushToSubscriptions, sendWorkspacePush, type PushSendReport } from "./send";

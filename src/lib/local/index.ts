// Local SEO (N4) — public surface of the module. The page, routes, scheduler and MCP tools
// import from their specific files; this barrel exists so `@/lib/local` answers with the feature's
// own vocabulary instead of the foundation stub's NOT_IMPLEMENTED marker.

export * from "./types";
export {
  directorySuggestions, directoryLabelFromUrl,
} from "./citations";
export {
  buildLocalBusinessSchema, validateLocalBusinessSchema, diffSchemas,
  BUSINESS_TYPES, DEFAULT_BUSINESS_TYPE, isKnownBusinessType, normaliseHours,
} from "./schema";
export { localSchemaMissing } from "./store";
export { startLocalScheduler, kickLocalScheduler } from "./scheduler";

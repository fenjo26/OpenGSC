/** Keep provider payloads and internal error codes out of rank UI tooltips. */
export function rankErrorKey(error: string):
  | "rankErrQuota" | "rankErrEmpty" | "rankErrUntrusted"
  | "rankErrCredentials" | "rankErrNetwork" | "rankErrGeneric"
  | "lrErr_location_unsupported" | "lrErr_location_unknown" | "lrErr_location_invalid" {
  if (error === "location_unsupported") return "lrErr_location_unsupported";
  if (error === "location_unknown") return "lrErr_location_unknown";
  if (error === "location_invalid") return "lrErr_location_invalid";
  if (/untrusted_not_found/i.test(error)) return "rankErrUntrusted";
  if (/empty_serp/i.test(error)) return "rankErrEmpty";
  if (/credits?|quota|balance|payment required|rate.?limit|\b429\b|\b402\b/i.test(error)) return "rankErrQuota";
  if (/no_serp_key|no_serp_base_url|invalid.api.key|unauthorized|\b401\b|\b403\b/i.test(error)) return "rankErrCredentials";
  if (/network|fetch failed|timeout|\bE(?:CONN|TIMEDOUT|AI_AGAIN|NOTFOUND)\w*\b|сеть/i.test(error)) return "rankErrNetwork";
  return "rankErrGeneric";
}

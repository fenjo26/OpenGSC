export interface LineDiff {
  beforeLines: number;
  afterLines: number;
  commonPrefix: number;
  commonSuffix: number;
  removed: string[];
  added: string[];
  truncated: boolean;
}
/**
 * A bounded, deterministic preview. It intentionally shows only the changed middle instead of
 * running an unbounded LCS over two long articles inside an API request.
 */
export function createLineDiff(before: string, after: string, limit = 240): LineDiff {
  const a = String(before ?? "").replace(/\r\n/g, "\n").split("\n");
  const b = String(after ?? "").replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const removedAll = a.slice(prefix, a.length - suffix);
  const addedAll = b.slice(prefix, b.length - suffix);
  return {
    beforeLines: a.length, afterLines: b.length, commonPrefix: prefix, commonSuffix: suffix,
    removed: removedAll.slice(0, limit), added: addedAll.slice(0, limit),
    truncated: removedAll.length > limit || addedAll.length > limit,
  };
}

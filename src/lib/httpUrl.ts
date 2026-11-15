/** True when the string is an absolute http(s) URL — the "this row is a page, not a query"
 *  test used by the dashboard tables to decide whether a label can render as a link. */
export function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

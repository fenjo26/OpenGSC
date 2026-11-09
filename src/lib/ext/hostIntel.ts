// wave-ext E5 — the DB half of /api/ext/hosts: everything OpenGSC knows about up to 100 hosts
// in a fixed number of queries. E0 lays the signatures (CONTRACT/E5 §1); bodies land with E5.
import type { HostsRequest, HostsResponse, EnrichResponse } from "./types";

/** One call, every source (own/PBN/DR/refdomains/age/serpmon/linksToUs/outreach/drops), fixed
 *  query count independent of the number of hosts. */
export async function hostIntel(userId: string, req: HostsRequest): Promise<HostsResponse> {
  void userId; void req;
  throw new Error("not_implemented");
}

/** Age (RDAP/WHOIS) + free DR for hosts that lack them — network but never money. */
export async function enrichHosts(userId: string, hosts: string[]): Promise<EnrichResponse> {
  void userId; void hosts;
  throw new Error("not_implemented");
}

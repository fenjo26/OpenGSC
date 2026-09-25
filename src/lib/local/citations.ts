// Directory suggestions for the citations tab (N4, brief §3). Pure data + two small helpers.
//
// This is a hand-curated list of REGISTRATION links, not an auto-posting target: the brief is
// explicit that OpenGSC only suggests where else to get listed. Greece gets its own set because
// the instance's local businesses (transfers, massage) live there and xo.gr / vrisko.gr / 11888
// carry real local ranking weight; everything else falls back to worldwide directories.

import type { DirectorySuggestion } from "./types";

const GR_SUGGESTIONS: DirectorySuggestion[] = [
  { name: "Google Business Profile", url: "https://business.google.com/" },
  { name: "Facebook Pages", url: "https://www.facebook.com/pages/create/" },
  { name: "Apple Business Connect", url: "https://businessconnect.apple.com/" },
  { name: "Bing Places", url: "https://www.bingplaces.com/" },
  { name: "Xo.gr", url: "https://www.xo.gr/" },
  { name: "Vrisko.gr", url: "https://www.vrisko.gr/" },
  { name: "11888.gr", url: "https://www.11888.gr/" },
  { name: "TripAdvisor", url: "https://www.tripadvisor.com/BusinessListings" },
  { name: "Foursquare", url: "https://foursquare.com/" },
];

const GLOBAL_SUGGESTIONS: DirectorySuggestion[] = [
  { name: "Google Business Profile", url: "https://business.google.com/" },
  { name: "Facebook Pages", url: "https://www.facebook.com/pages/create/" },
  { name: "Apple Business Connect", url: "https://businessconnect.apple.com/" },
  { name: "Bing Places", url: "https://www.bingplaces.com/" },
  { name: "TripAdvisor", url: "https://www.tripadvisor.com/BusinessListings" },
  { name: "Foursquare", url: "https://foursquare.com/" },
  { name: "Yelp", url: "https://biz.yelp.com/" },
  { name: "LinkedIn Company", url: "https://www.linkedin.com/company/setup/" },
];

/** Suggestions for the profile's country: the Greek set for `gr`, worldwide for the rest/unknown. */
export function directorySuggestions(country: string): DirectorySuggestion[] {
  return (country || "").toLowerCase() === "gr" ? GR_SUGGESTIONS : GLOBAL_SUGGESTIONS;
}

/** A human label for a listing URL's directory ("Xo.gr" from https://www.xo.gr/business/123). */
export function directoryLabelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

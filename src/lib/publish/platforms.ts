// Platform metadata for the UI — pure data, no adapters, safe to import from client
// components. The adapter instances live in registry.ts (server-side: the WordPress adapter
// imports node-only modules), so this file is what the Add-connection form renders from.
//
// Field labels are i18n keys from the pre-added publishing set; t() has no interpolation, so
// keys are referenced, never composed here.

export interface PlatformFieldDef {
  /** Key inside the credentials JSON the adapter reads. */
  key: "username" | "appPassword";
  /** i18n key for the field label. */
  labelKey: "publishUsername" | "publishAppPassword";
  /** Secret fields are masked in the UI and never echoed back by the API. */
  secret: boolean;
}

export interface PlatformDef {
  id: string;
  name: string;
  /** What the platform calls the target — a site URL for WordPress, a blog id later. */
  siteIdentifierLabelKey: "publishSiteIdentifier";
  fields: PlatformFieldDef[];
}

export const PLATFORMS: PlatformDef[] = [
  {
    id: "wordpress",
    name: "WordPress",
    siteIdentifierLabelKey: "publishSiteIdentifier",
    fields: [
      { key: "username", labelKey: "publishUsername", secret: false },
      { key: "appPassword", labelKey: "publishAppPassword", secret: true },
    ],
  },
];

export function platformDefById(id: string): PlatformDef | undefined {
  return PLATFORMS.find(p => p.id === id);
}

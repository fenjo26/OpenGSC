export interface AiCompetitor {
  name: string;                 // display name
  domain: string;               // host without www; "" when the rival has no site
  terms: string[];              // brand spellings; name is always included implicitly
}

export interface SovEngineRow {
  engine: string;               // AeoEngine
  answers: number;              // latest answer per question in the window
  us: { mentioned: number; cited: number; avgRank: number | null };
  competitors: { name: string; mentioned: number; cited: number }[];
}

export interface SovReport {
  window: { from: string; to: string };
  questions: number;
  answers: number;
  shareOfVoice: { name: string; isUs: boolean; mentions: number; share: number }[];   // share 0..1
  citationShare: { name: string; isUs: boolean; citations: number; share: number }[];
  byEngine: SovEngineRow[];
  trend: { week: string; usShare: number | null }[];            // ISO week "2026-W40"
}

export interface CitedDomainRow {
  domain: string;
  citations: number;            // total citation slots across answers
  answers: number;              // answers citing it at least once
  engines: string[];
  questions: number;
  exampleQuestion: string;
  exampleUrl: string;
  isUs: boolean;
  competitor: string | null;    // competitor name if the domain belongs to one
}

export interface SuggestedQuestion {
  question: string;
  impressions28d: number;
  clicks28d: number;
  page: string | null;
}

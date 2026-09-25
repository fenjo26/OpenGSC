import test from "node:test";
import type { AiCompetitor, SovReport } from "./types";

// Type-only module: the test is that it imports (and typechecks) at all.
test("visibility types import", () => {
  const rival: AiCompetitor = { name: "Example", domain: "example.com", terms: ["Example Co"] };
  const report: Pick<SovReport, "questions" | "answers"> = { questions: 0, answers: 0 };
  void rival; void report;
});

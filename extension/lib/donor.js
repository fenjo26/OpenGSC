// OpenGSC extension — donor-mode facts: outbound links, restored-drop markers (wave-ext E3
// owns this file). E0 lays the empty DonorFacts shape of CONTRACT §4.5 so content.js can
// already reference it.

var ExtDonor = {
  /** MARKERS — the restored-site markers (CONTRACT §4.6): a copy of the list in
   *  src/lib/pbn/clean.ts plus the Wayback leftovers. E3 fills the real list; the test in
   *  src/lib/ext/donor.test.ts keeps it in sync with clean.ts. */
  MARKERS: [],

  /** collect(document) → DonorFacts. E3 implements; the stub returns the empty shape. */
  collect: function () {
    return {
      host: "",
      outbound: [],
      markers: [],
      archiveRefs: 0,
      generator: "",
      firstTextBlockIndex: -1,
    };
  },

  /** deriveSignals(donorFacts) → [{ id, severity, evidence }] — pure. E3 implements. */
  deriveSignals: function (_donorFacts) { return []; },

  /** verdict(signals) → "restored_drop" | "suspicious" | "clean" | "unknown" — pure. E3. */
  verdict: function (_signals) { return "unknown"; },
};

// Node/test interop (classic script everywhere else).
if (typeof module !== "undefined" && module.exports) module.exports = ExtDonor;

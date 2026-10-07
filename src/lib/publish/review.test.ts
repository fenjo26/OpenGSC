import test from "node:test";
import assert from "node:assert/strict";
import { linkInventory, anchorDistribution, reviewBatch, ANCHOR_REPEAT_MIN_POSTS } from "./review";

// The pre-publish review's pure half: which links count as money-site links, how anchors
// aggregate across posts, and which honest warnings fire. No database, no network.

const HOST = "money.example.com";

const md = (anchor: string, url: string) => `# Title\n\nText with [${anchor}](${url}) inside.`;

test("linkInventory keeps the money host and subdomains, drops external and malformed targets", () => {
  const body = [
    md("prices", "https://money.example.com/prices"),
    md("blog sub", "https://blog.money.example.com/post-1"),
    md("competitor", "https://other.example.net/prices"),
    md("relative", "/prices"),
    "A bare [not-a-link](https://) malformed target.",
  ].join("\n\n");
  const refs = linkInventory(body, HOST);
  assert.deepEqual(refs.map(r => r.anchor), ["prices", "blog sub"]);
  assert.equal(refs[0].url, "https://money.example.com/prices");
  assert.deepEqual(linkInventory(body, ""), [], "no host → no inventory");
});

test("anchorDistribution counts POSTS per anchor, not occurrences inside one post", () => {
  const markdowns = [
    md("taxi transfers", "https://money.example.com/") + "\n" + md("taxi transfers", "https://money.example.com/tours"),
    md("taxi transfers", "https://money.example.com/"),
    md("read the guide", "https://money.example.com/guide"),
  ];
  const s = anchorDistribution(markdowns, HOST);
  const taxi = s.rows.find(r => r.anchor === "taxi transfers")!;
  assert.equal(taxi.posts, 2, "two posts use it — the double occurrence in post 1 counts once");
  assert.equal(taxi.repeated, true);
  assert.deepEqual(taxi.urls.sort(), ["https://money.example.com/", "https://money.example.com/tours"].sort());
  const guide = s.rows.find(r => r.anchor === "read the guide")!;
  assert.equal(guide.posts, 1);
  assert.equal(guide.repeated, false);
  assert.equal(s.postsWithLinks, 3);
});

test("anchorDistribution flags an empty anchor repeated across posts and caps rendered rows", () => {
  const markdowns = Array.from({ length: 30 }, (_, i) => md(`anchor ${i % 25}`, "https://money.example.com/"));
  const s = anchorDistribution(markdowns, HOST);
  assert.ok(s.rows.length <= 20, "capped at a summary size");
  const empty = anchorDistribution([md("", "https://money.example.com/a"), md("", "https://money.example.com/b")], HOST);
  const row = empty.rows.find(r => r.anchor === "")!;
  assert.equal(row.posts, 2);
  assert.equal(row.repeated, true, "an empty anchor repeated is as much a template as a keyword");
  assert.equal(ANCHOR_REPEAT_MIN_POSTS, 2);
});

test("reviewBatch: same title construction on 2+ posts is a skeleton warning; distinct constructions are not", () => {
  // The footprint module folds entities (here: the money domain label "money") and
  // years/numbers to {x}/{y}/{n} — so these two titles share the construction.
  const planned = [
    { title: "Money Airport Taxi Guide 2026", markdown: md("t", "https://money.example.com/a"), scheduledAt: null },
    { title: "Money Airport Taxi Guide 2025", markdown: md("t", "https://money.example.com/b"), scheduledAt: null },
    { title: "Where to Eat Cheap in Halkidiki", markdown: "", scheduledAt: null },
  ];
  const w = reviewBatch(planned, HOST);
  assert.equal(w.skeletons.length, 1, "the two guides share a skeleton after the entity/year fold");
  assert.equal(w.skeletons[0].titles.length, 2);
  // No scheduledAt → no cluster claim, no matter how many posts.
  assert.equal(w.clusters.length, 0);
});

test("reviewBatch: a satellite's own name in the title folds via extraEntities (the swap a template performs)", () => {
  const w = reviewBatch([
    { title: "Satellite One Casino Review: Best Bonus", markdown: "", scheduledAt: null },
    { title: "Satellite Two Casino Review: Best Bonus", markdown: "", scheduledAt: null },
  ], HOST, ["https://satellite-one.example.com", "satellite-two.example.com"]);
  // "satellite one" / "satellite two" are the domain labels of the two connections and fold
  // to {x} — same construction on two satellites, which is the warning the plan asked for.
  assert.equal(w.skeletons.length, 1);
  assert.equal(w.skeletons[0].titles.length, 2);
});

test("reviewBatch: two publications inside one clock hour are a cluster warning", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 7, h, 12, 0));
  const w = reviewBatch([
    { title: "Post one title here", markdown: "", scheduledAt: at(10) },
    { title: "Post two title here", markdown: "", scheduledAt: new Date(at(10).getTime() + 30 * 60_000) },
    { title: "Post three title here", markdown: "", scheduledAt: at(15) },
  ], HOST);
  assert.equal(w.clusters.length, 1);
  assert.equal(w.clusters[0].hour, "2026-10-07T10");
  assert.equal(w.clusters[0].titles.length, 2);
});

test("reviewBatch carries the repeated anchors as warnings", () => {
  const w = reviewBatch([
    { title: "First satellite post title", markdown: md("taxi", "https://money.example.com/"), scheduledAt: null },
    { title: "Second satellite post title", markdown: md("taxi", "https://money.example.com/"), scheduledAt: null },
  ], HOST);
  assert.equal(w.repeatedAnchors.length, 1);
  assert.equal(w.repeatedAnchors[0].anchor, "taxi");
});

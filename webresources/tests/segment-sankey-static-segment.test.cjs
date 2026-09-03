"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const htmlPath = path.join(__dirname, "..", "segment-sankey.html");
const html = fs.readFileSync(htmlPath, "utf8");

test("the static-segment detector recognizes only the missing-query response", () => {
  const match = /function isStaticSegmentWithoutFilterQuery\(error\) \{[\s\S]*?^      \}/m.exec(html);
  assert.ok(match, "the static-segment detector is missing");

  const context = {};
  vm.runInNewContext(
    `${match[0]}
     result = [
       isStaticSegmentWithoutFilterQuery({ message: "The segment definition 123 does not contain an MQL query." }),
       isStaticSegmentWithoutFilterQuery({ message: "The count provider timed out." })
     ];`,
    context
  );

  assert.deepStrictEqual(Array.from(context.result), [true, false]);
});

test("static segments receive friendly nontechnical copy", () => {
  assert.ok(html.includes(
    "This is a static segment with a fixed member list. A filter-by-filter preview is only available for dynamic segments."
  ));
  assert.ok(html.includes(
    "There are no filter steps to display for this static segment."
  ));
});

test("pending Fabric dependency tables are retried across separate plugin requests", () => {
  assert.match(html, /const MAX_DEPENDENCY_RETRIES = 6;/);
  assert.match(
    html,
    /did not expose these tables within \\d\+ seconds/
  );
  assert.match(html, /error\.retryRegardlessOfTrigger = true;/);
  assert.match(
    html,
    /\(isAutomatic \|\| error\.retryRegardlessOfTrigger\)/
  );
});

test("pending Fabric dependency tables display accessible progress", () => {
  assert.match(html, /id="dependency-progress" role="status" aria-live="polite"/);
  assert.match(html, /aria-label="Fabric preparation progress"/);
  assert.match(html, /function showDependencyProgress\(/);
  assert.match(html, /Waiting for: /);
  assert.match(html, /Readiness attempt /);
  assert.match(html, /function clearDependencyProgress\(/);
});

test("a paused Fabric capacity is retried with dedicated progress", () => {
  assert.match(html, /const MAX_CAPACITY_RETRIES = 30;/);
  assert.match(html, /error\.retryLimit = MAX_CAPACITY_RETRIES;/);
  assert.match(html, /Fabric capacity is starting automatically/);
  assert.match(html, /Starting Fabric capacity/);
  assert.match(html, /Azure is resuming the paused capacity/);
});

test("the first paint shows an accessible progressive loading skeleton", () => {
  assert.match(
    html,
    /<section class="summary" id="summary" aria-label="Summary" aria-busy="true">/
  );
  assert.match(html, /class="metric-value loading-value"/);
  assert.match(html, /class="loading-flow" role="status" aria-live="polite"/);
  assert.match(html, /Loading segment structure and filter counts\./);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
});

test("refresh keeps an existing visualization visible while counts update", () => {
  assert.match(html, /function setLoading\(isLoading, showSkeleton\)/);
  assert.match(html, /if \(showSkeleton\) \{\s*showLoadingSkeleton\(\);/);
  assert.match(html, /chart\.classList\.add\("refreshing"\)/);
  assert.match(html, /chart\.setAttribute\("inert", ""\)/);
  assert.match(html, /pointer-events: none/);
  assert.match(html, /setLoading\(true, isNewSegment\)/);
  assert.match(
    html,
    /if \(isNewSegment\) \{\s*document\.getElementById\("summary"\)\.hidden = true;/
  );
});

test("a response for a segment that is no longer active is discarded", () => {
  assert.match(html, /activeSegmentId && activeSegmentId !== segmentId/);
  assert.match(html, /queueMicrotask\(\(\) => \{/);
  assert.match(html, /refresh\(\{ segmentId: activeSegmentId, automatic: true \}\)/);
  assert.match(html, /return false;\s*\}\s*render\(result,/);
});

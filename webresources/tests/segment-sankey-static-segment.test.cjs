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
  assert.match(html, /aria-label="Fabric table synchronization progress"/);
  assert.match(html, /function showDependencyProgress\(/);
  assert.match(html, /Waiting for: /);
  assert.match(html, /Synchronization attempt /);
  assert.match(html, /function clearDependencyProgress\(/);
});

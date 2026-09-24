"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const resources = path.join(__dirname, "..");
const countView = fs.readFileSync(path.join(resources, "segment-sankey.html"), "utf8");
const memberView = fs.readFileSync(path.join(resources, "segment-members.html"), "utf8");
const setupView = fs.readFileSync(path.join(resources, "segment-preview-setup.html"), "utf8");

test("segment count requests coalesce safely and cache only a bounded number of results", () => {
  assert.match(countView, /const REQUEST_CACHE_TTL_MS = 5000;/);
  assert.match(countView, /const MAX_REQUEST_CACHE_ENTRIES = 12;/);
  assert.match(countView, /const countRequestCache = new Map\(\);/);
  assert.match(countView, /if \(existing\?\.promise\) \{[\s\S]{0,120}return awaitSharedRequest\(existing\.promise, signal\);/);
  assert.match(countView, /if \(existing && !forceRefresh && existing\.expiresAt > Date\.now\(\)\)/);
  assert.match(countView, /Promise\.resolve\(\)\s*\.then\(load\)/);
  assert.match(countView, /while \(cache\.size >= MAX_REQUEST_CACHE_ENTRIES\)/);
  assert.match(countView, /cache\.delete\(key\);[\s\S]{0,100}throw error;/);
  assert.match(countView, /!isAutomatic/);
});

test("segment diagnostics report browser-observed request source", () => {
  assert.match(countView, /clientRequestSource === "client-cache"[\s\S]{0,80}return "client-cache-hit";/);
  assert.match(countView, /clientRequestSource === "coalesced"[\s\S]{0,100}return "coalesced-with-in-flight-request";/);
  assert.match(countView, /normalizedServerCache !== "not_reported"[\s\S]{0,80}: "network";/);
});

test("segment diagnostics preserve the Dataverse phase timing breakdown", () => {
  assert.match(countView, /dataverseSettings: finiteMetric\(timings\.dataverseSettings\)/);
  assert.match(countView, /progressiveFirstPaint: finiteMetric\([\s\S]{0,80}diagnostic\.progressiveFirstPaintMs/);
  assert.match(countView, /dataverseRequestBuild: finiteMetric\(timings\.dataverseRequestBuild\)/);
  assert.match(countView, /dataverseDependencyResolution: finiteMetric\([\s\S]{0,80}timings\.dataverseDependencyResolution/);
  assert.match(countView, /dataverseApiRoundtrip: finiteMetric\(timings\.dataverseApiRoundtrip\)/);
  assert.match(countView, /dataverseResponseMapping: finiteMetric\([\s\S]{0,80}timings\.dataverseResponseMapping/);
  assert.match(countView, /dataverseSegmentRetrieve: finiteMetric\([\s\S]{0,80}timings\.dataverseSegmentRetrieve/);
  assert.match(countView, /dataverseMqlParsing: finiteMetric\(timings\.dataverseMqlParsing\)/);
  assert.match(countView, /dataverseRelationshipMetadata: finiteMetric\([\s\S]{0,80}timings\.dataverseRelationshipMetadata/);
  assert.match(countView, /dataverseEntityMetadata: finiteMetric\([\s\S]{0,80}timings\.dataverseEntityMetadata/);
  assert.match(countView, /dataverseSegmentReferences: finiteMetric\([\s\S]{0,80}timings\.dataverseSegmentReferences/);
  assert.match(countView, /dataverseStaticMembers: finiteMetric\([\s\S]{0,80}timings\.dataverseStaticMembers/);
  assert.match(countView, /requestBuildCache: safeDiagnosticText\([\s\S]{0,80}runtime\.requestBuildCache/);
});

test("segment counts render progressive preview and final phases in parallel", () => {
  assert.match(countView, /klth_phase: phase \|\| "complete"/);
  assert.match(countView, /segmentId \+ "\|preview"/);
  assert.match(countView, /segmentId \+ "\|complete"/);
  assert.match(countView, /const previewPromise = cachedRequest\(/);
  assert.match(countView, /const finalPromise = cachedRequest\(/);
  assert.match(countView, /renderProgressive\(preview, performance\.now\(\) - startedAt\)/);
  assert.match(countView, /stage\.count === null \|\| stage\.status === "pending"/);
  assert.match(countView, /Waiting for dependent segment data/);
  assert.match(countView, /label\.textContent = stage\.label/);
  assert.doesNotMatch(countView, /escapeHtml\(stage\.label\)/);
  assert.match(countView, /function lockChartHeight\(chart\)/);
  assert.match(countView, /function releaseChartHeight\(chart\)/);
  assert.match(countView, /elapsedMilliseconds,\s*true\s*\)/);
  assert.match(countView, /state\.evaluationToken = result\.isComplete \? result\.evaluationToken : ""/);
});

test("member requests use their full request shape as a bounded cache key", () => {
  assert.match(memberView, /const memberRequestCache = new Map\(\);/);
  assert.match(memberView, /JSON\.stringify\(request\),\s*\(\) => executeRequest\(request\)/);
  assert.match(memberView, /const REQUEST_CACHE_TTL_MS = 5000;/);
  assert.match(memberView, /const MAX_REQUEST_CACHE_ENTRIES = 12;/);
  assert.match(memberView, /if \(existing\?\.promise\) \{\s*return awaitSharedRequest\(existing\.promise, signal\);/);
  assert.match(memberView, /while \(cache\.size >= MAX_REQUEST_CACHE_ENTRIES\)/);
  assert.match(memberView, /cache\.delete\(key\);[\s\S]{0,100}throw error;/);
});

test("solution updates wait for active Dataverse import or uninstall operations", () => {
  assert.match(setupView, /async function activeSolutionOperations\(\)/);
  assert.match(setupView, /importjobs\?\$select=importjobid,startedon&\$filter=completedon eq null/);
  assert.match(setupView, /asyncoperations\?\$select=name,startedon&\$filter=statecode eq 0/);
  assert.match(setupView, /async function requireNoActiveSolutionOperations\(\)/);
  assert.match(setupView, /active solution import or uninstall operation/);
  assert.match(setupView, /await requireNoActiveSolutionOperations\(\);[\s\S]{0,300}releases\/latest/);
  assert.match(setupView, /async function importSolutionAndConfirm\(update, bytes\) \{\s*await requireNoActiveSolutionOperations\(\);/);
  assert.match(setupView, /Update temporarily unavailable/);
});

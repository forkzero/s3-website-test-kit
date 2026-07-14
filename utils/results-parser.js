#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Diffs two load-test runs produced by test-runner.js. The two runs are just a
// "baseline" and a "candidate" — e.g. native S3 vs s3proxy, or two s3proxy
// builds. Each run's own `environment` label (from TEST_ENVIRONMENT) is used in
// the report, so nothing here is tied to a specific pair of targets.

// test-runner.js writes: load-test-results-<environment>-<timestamp>.json
const RESULTS_RE = /^load-test-results-(.+)-(\d+)\.json$/;

const RT_KEYS = ['p50', 'p95', 'p99', 'mean'];

// Percentage change of `value` relative to `base` (positive => value is higher).
const pctDiff = (value, base) => (base === 0 ? (value === 0 ? 0 : 100) : ((value - base) / base) * 100);

function loadResults(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Error loading results from ${filePath}: ${error.message}`);
    process.exit(1);
  }
}

// Every results file in the cwd, parsed and sorted newest-first by timestamp.
function listResults() {
  return fs
    .readdirSync('.')
    .map((f) => ({ file: f, match: f.match(RESULTS_RE) }))
    .filter((x) => x.match)
    .map((x) => ({ file: x.file, env: x.match[1], ts: Number(x.match[2]) }))
    .sort((a, b) => b.ts - a.ts);
}

// A compare argument is either a path to a results file, or a bare environment
// label (-> the latest load-test-results-<label>-*.json in the cwd).
function resolveResultsArg(arg) {
  if (arg.endsWith('.json') || arg.includes('/')) return arg;
  const match = listResults().find((r) => r.env === arg);
  if (!match) {
    console.error(`No results file for environment "${arg}" (expected load-test-results-${arg}-*.json)`);
    process.exit(1);
  }
  return match.file;
}

// The two most recent runs, preferring two different environments.
function autoFindPair() {
  const runs = listResults();
  if (runs.length < 2) {
    console.error('Need at least two load-test-results-*.json files to compare (run the suite against two targets first).');
    process.exit(1);
  }
  const candidate = runs[0];
  const baseline = runs.find((r) => r.env !== candidate.env) || runs[1];
  return { baseline: baseline.file, candidate: candidate.file };
}

function compare(baseline, candidate) {
  const comparison = {
    timestamp: new Date().toISOString(),
    baseline: baseline.environment || 'baseline',
    candidate: candidate.environment || 'candidate',
    summary: { responseTime: {}, successRate: {}, totalRequests: {}, specialFeatures: {} },
    recommendations: [],
  };

  for (const k of RT_KEYS) {
    const b = baseline.summary.responseTime[k];
    const c = candidate.summary.responseTime[k];
    comparison.summary.responseTime[k] = { baseline: b, candidate: c, diffPct: pctDiff(c, b) };
  }

  comparison.summary.successRate = {
    baseline: baseline.summary.successRate,
    candidate: candidate.summary.successRate,
    diff: candidate.summary.successRate - baseline.summary.successRate,
  };
  comparison.summary.totalRequests = {
    baseline: baseline.summary.totalRequests,
    candidate: candidate.summary.totalRequests,
  };
  for (const feat of ['rangeRequestCount', 'specialCharacterRequestCount', 'healthCheckCount']) {
    comparison.summary.specialFeatures[feat] = {
      baseline: baseline.summary[feat],
      candidate: candidate.summary[feat],
    };
  }

  const p95 = comparison.summary.responseTime.p95.diffPct;
  if (Math.abs(p95) > 20) {
    const slower = p95 > 0 ? comparison.candidate : comparison.baseline;
    comparison.recommendations.push(`${slower} shows >20% higher p95 response time - investigate performance overhead`);
  }
  const srDiff = comparison.summary.successRate.diff;
  if (Math.abs(srDiff) > 1) {
    const lower = srDiff < 0 ? comparison.candidate : comparison.baseline;
    comparison.recommendations.push(`${lower} has a lower success rate - check error handling and configuration`);
  }
  for (const [feat, label] of [
    ['rangeRequestCount', 'Range request'],
    ['specialCharacterRequestCount', 'Special-character request'],
  ]) {
    const s = comparison.summary.specialFeatures[feat];
    if (s.baseline !== s.candidate) comparison.recommendations.push(`${label} counts differ between runs - verify handling`);
  }

  return comparison;
}

function generateReport(c) {
  const { baseline: B, candidate: C } = c;
  const w = Math.max(10, B.length, C.length) + 2;
  const col = (s) => String(s).padStart(w);

  console.log('\n=== S3 Website Performance Comparison ===');
  console.log(`Generated: ${c.timestamp}`);
  console.log(`Baseline: ${B}   Candidate: ${C}`);

  console.log('\nResponse time (ms):');
  console.log(`${''.padEnd(8)}${col(B)}${col(C)}${col('diff')}`);
  for (const k of RT_KEYS) {
    const r = c.summary.responseTime[k];
    console.log(`${k.padEnd(8)}${col(r.baseline.toFixed(1))}${col(r.candidate.toFixed(1))}${col(`${r.diffPct.toFixed(1)}%`)}`);
  }

  console.log('\nSuccess rate:');
  console.log(`  ${B}: ${c.summary.successRate.baseline.toFixed(2)}%`);
  console.log(`  ${C}: ${c.summary.successRate.candidate.toFixed(2)}%`);
  console.log(`  diff: ${c.summary.successRate.diff.toFixed(2)}%`);

  console.log('\nFeature request counts:');
  for (const [feat, label] of [
    ['rangeRequestCount', 'Range'],
    ['specialCharacterRequestCount', 'Special-char'],
    ['healthCheckCount', 'Health'],
  ]) {
    const s = c.summary.specialFeatures[feat];
    console.log(`  ${label.padEnd(12)} ${B}: ${s.baseline}, ${C}: ${s.candidate}`);
  }

  if (c.recommendations.length > 0) {
    console.log('\nRecommendations:');
    c.recommendations.forEach((rec) => console.log(`  • ${rec}`));
  } else {
    console.log('\nNo significant performance differences detected');
  }
  console.log('');
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'compare') {
    console.log('Usage:');
    console.log('  s3-website-perf-compare compare [--baseline <file|env>] [--candidate <file|env>]');
    console.log('');
    console.log('Each argument is a results file (load-test-results-<env>-<ts>.json) or a bare');
    console.log('environment label (uses the latest matching file in the current directory).');
    console.log('With no arguments, compares the two most recent runs from different environments.');
    return;
  }

  let baselineArg, candidateArg;
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === '--baseline') baselineArg = args[i + 1];
    else if (args[i] === '--candidate') candidateArg = args[i + 1];
  }

  let baselineFile, candidateFile;
  if (baselineArg || candidateArg) {
    if (!baselineArg || !candidateArg) {
      console.error('Provide both --baseline and --candidate (or neither to auto-detect the two latest runs).');
      process.exit(1);
    }
    baselineFile = resolveResultsArg(baselineArg);
    candidateFile = resolveResultsArg(candidateArg);
  } else {
    ({ baseline: baselineFile, candidate: candidateFile } = autoFindPair());
    console.log(`Auto-selected baseline:  ${baselineFile}`);
    console.log(`Auto-selected candidate: ${candidateFile}`);
  }

  const comparison = compare(loadResults(baselineFile), loadResults(candidateFile));
  generateReport(comparison);

  const outFile = `performance-comparison-${Date.now()}.json`;
  fs.writeFileSync(outFile, JSON.stringify(comparison, null, 2));
  console.log(`Detailed comparison saved to: ${outFile}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { compare, loadResults, generateReport };
export default { compare, loadResults, generateReport };

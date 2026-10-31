#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Diffs two load-test runs, a "baseline" and a "candidate" (e.g. native S3 vs
// s3proxy, or two s3proxy builds). Input is Artillery's own JSON report, written
// with `artillery run ... -o report.json` — that report is aggregated across all
// of Artillery's worker threads, so the totals and percentiles are correct.
// (A per-request Artillery processor cannot aggregate this way: each worker only
// sees its own slice of requests. See issue #9.)

const RT_KEYS = ['p50', 'p95', 'p99', 'mean'];

// Percentage change of `value` relative to `base` (positive => value is higher).
const pctDiff = (value, base) => (base === 0 ? (value === 0 ? 0 : 100) : ((value - base) / base) * 100);

function loadReport(filePath, label) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Error loading report from ${filePath}: ${error.message}`);
    process.exit(1);
  }
  if (!report.aggregate || !report.aggregate.counters) {
    console.error(`${filePath} is not an Artillery JSON report. Generate one with:`);
    console.error('  artillery run --config <config> --target <url> -o <report.json> <scenario>');
    process.exit(1);
  }
  return summarize(report, label ?? path.basename(filePath).replace(/\.json$/, ''));
}

// Reduce an Artillery report's aggregate into the fields we compare.
function summarize(report, label) {
  const counters = report.aggregate.counters || {};
  const rt = (report.aggregate.summaries || {})['http.response_time'] || {};

  const statusCodes = {};
  let success = 0;
  const scenarios = {};
  for (const [k, v] of Object.entries(counters)) {
    const code = k.match(/^http\.codes\.(\d+)$/);
    if (code) {
      statusCodes[code[1]] = v;
      if (Number(code[1]) < 400) success += v; // 2xx/3xx count as success
    }
    const scenario = k.match(/^vusers\.created_by_name\.(.+)$/);
    if (scenario) scenarios[scenario[1]] = v;
  }

  const totalRequests = counters['http.requests'] || 0;
  return {
    label,
    totalRequests,
    downloadedBytes: counters['http.downloaded_bytes'] || 0,
    successRate: totalRequests ? (success / totalRequests) * 100 : 0,
    responseTime: { mean: rt.mean, p50: rt.p50 ?? rt.median, p95: rt.p95, p99: rt.p99, min: rt.min, max: rt.max },
    statusCodes,
    scenarios,
    vusers: {
      created: counters['vusers.created'] || 0,
      completed: counters['vusers.completed'] || 0,
      failed: counters['vusers.failed'] || 0,
    },
  };
}

function compare(baseline, candidate) {
  const comparison = {
    timestamp: new Date().toISOString(),
    baseline: baseline.label,
    candidate: candidate.label,
    summary: { responseTime: {}, successRate: {}, totalRequests: {}, downloadedBytes: {} },
    recommendations: [],
  };

  for (const k of RT_KEYS) {
    const b = baseline.responseTime[k];
    const c = candidate.responseTime[k];
    comparison.summary.responseTime[k] = { baseline: b, candidate: c, diffPct: pctDiff(c, b) };
  }
  comparison.summary.successRate = {
    baseline: baseline.successRate,
    candidate: candidate.successRate,
    diff: candidate.successRate - baseline.successRate,
  };
  comparison.summary.totalRequests = { baseline: baseline.totalRequests, candidate: candidate.totalRequests };
  comparison.summary.downloadedBytes = { baseline: baseline.downloadedBytes, candidate: candidate.downloadedBytes };

  const p95 = comparison.summary.responseTime.p95.diffPct;
  if (Number.isFinite(p95) && Math.abs(p95) > 20) {
    const slower = p95 > 0 ? comparison.candidate : comparison.baseline;
    comparison.recommendations.push(`${slower} shows >20% higher p95 response time - investigate performance overhead`);
  }
  const srDiff = comparison.summary.successRate.diff;
  if (Math.abs(srDiff) > 1) {
    const lower = srDiff < 0 ? comparison.candidate : comparison.baseline;
    comparison.recommendations.push(`${lower} has a lower success rate - check error handling and configuration`);
  }

  return comparison;
}

function generateReport(c, baseline, candidate) {
  const { baseline: B, candidate: C } = c;
  const w = Math.max(10, B.length, C.length) + 2;
  const col = (s) => String(s).padStart(w);
  const num = (n) => (typeof n === 'number' ? n.toFixed(1) : 'n/a');

  console.log('\n=== S3 Website Performance Comparison ===');
  console.log(`Generated: ${c.timestamp}`);
  console.log(`Baseline: ${B}   Candidate: ${C}`);

  console.log('\nResponse time (ms):');
  console.log(`${''.padEnd(8)}${col(B)}${col(C)}${col('diff')}`);
  for (const k of RT_KEYS) {
    const r = c.summary.responseTime[k];
    const diff = Number.isFinite(r.diffPct) ? `${r.diffPct.toFixed(1)}%` : 'n/a';
    console.log(`${k.padEnd(8)}${col(num(r.baseline))}${col(num(r.candidate))}${col(diff)}`);
  }

  console.log('\nRequests / success:');
  console.log(`  ${B}: ${baseline.totalRequests} reqs, ${baseline.successRate.toFixed(2)}% success`);
  console.log(`  ${C}: ${candidate.totalRequests} reqs, ${candidate.successRate.toFixed(2)}% success`);

  console.log('\nStatus codes:');
  console.log(`  ${B}: ${fmtCodes(baseline.statusCodes)}`);
  console.log(`  ${C}: ${fmtCodes(candidate.statusCodes)}`);

  if (c.recommendations.length > 0) {
    console.log('\nRecommendations:');
    c.recommendations.forEach((rec) => console.log(`  • ${rec}`));
  } else {
    console.log('\nNo significant performance differences detected');
  }
  console.log('');
}

const fmtCodes = (codes) =>
  Object.keys(codes).length ? Object.entries(codes).map(([k, v]) => `${k}:${v}`).join(' ') : '(none)';

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'compare') {
    console.log('Usage:');
    console.log('  s3-website-perf-compare compare --baseline <report.json> --candidate <report.json>');
    console.log('                                  [--baseline-label <name>] [--candidate-label <name>]');
    console.log('');
    console.log('Each report is an Artillery JSON report produced with `artillery run ... -o <report.json>`.');
    console.log('Labels default to the report filename.');
    return;
  }

  const opts = {};
  for (let i = 1; i < args.length; i += 2) opts[args[i]] = args[i + 1];
  const baselineFile = opts['--baseline'];
  const candidateFile = opts['--candidate'];
  if (!baselineFile || !candidateFile) {
    console.error('Both --baseline and --candidate are required (paths to Artillery JSON reports).');
    process.exit(1);
  }

  const baseline = loadReport(baselineFile, opts['--baseline-label']);
  const candidate = loadReport(candidateFile, opts['--candidate-label']);
  const comparison = compare(baseline, candidate);
  generateReport(comparison, baseline, candidate);

  const outFile = `performance-comparison-${Date.now()}.json`;
  fs.writeFileSync(outFile, JSON.stringify(comparison, null, 2));
  console.log(`Detailed comparison saved to: ${outFile}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { summarize, compare, generateReport };
export default { summarize, compare, generateReport };

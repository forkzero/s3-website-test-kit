// Dependency-free validator: run in CI to catch broken assets before publish.
// Checks that the path helpers resolve, every YAML is non-empty and structurally
// sane, and that no s3proxy-only endpoint leaked into the target-agnostic core.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths, config, scenario } from '../index.js';

let failed = false;
const fail = (m) => {
  console.error('✗', m);
  failed = true;
};
const ok = (m) => console.log('✓', m);

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  );

// 1. Path helpers resolve to real files.
for (const s of ['core/load-test.yml', 'core/basic-load.yml', 's3proxy/health.yml', 's3proxy/error-contract.yml']) {
  existsSync(scenario(s)) ? ok(`scenario resolves: ${s}`) : fail(`scenario missing: ${s}`);
}
existsSync(config('load-test.yml'))
  ? ok('config resolves: load-test.yml')
  : fail('config missing: load-test.yml');

// 1b. A shipped conformance config must exist AND enable the expect plugin —
// otherwise `expect:` assertions are silently inert (issue #3).
if (!existsSync(config('conformance.yml'))) {
  fail('config missing: conformance.yml');
} else {
  const conf = readFileSync(config('conformance.yml'), 'utf8');
  /plugins:[\s\S]*expect:/.test(conf)
    ? ok('conformance.yml enables the expect plugin')
    : fail('conformance.yml does not enable plugins.expect (assertions would not run)');
}

// 2. In one pass over every .yml under scenarios/ and configs/: it's non-empty
// with its top key, and core scenarios stay target-agnostic (no /health).
let coreClean = true;
for (const f of [...walk(paths.scenarios), ...walk(paths.configs)].filter((f) => f.endsWith('.yml'))) {
  const txt = readFileSync(f, 'utf8').trim();
  const key = f.includes('/scenarios/') ? 'scenarios:' : 'config:';
  const label = f.split('/').slice(-2).join('/');
  if (!txt) fail(`empty yaml: ${label}`);
  else if (!txt.includes(key)) fail(`${label} missing '${key}'`);
  else ok(`yaml ok: ${label}`);

  if (f.includes('/scenarios/core/') && txt.includes('/health')) {
    fail(`/health leaked into core: ${label}`);
    coreClean = false;
  }
}
if (coreClean) ok('core scenarios free of s3proxy-only endpoints');

process.exit(failed ? 1 : 0);

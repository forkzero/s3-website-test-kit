# @forkzero/s3-website-test-kit

Target-agnostic [Artillery](https://www.artillery.io/) load and conformance
tests for **S3 static-website semantics**: index documents, streaming, range
requests, custom error documents, and URL encoding. The suite is just HTTP GETs
against a base URL, so you can point it at:

- **native S3 static website hosting** (`bucket.s3-website-<region>.amazonaws.com`),
- **[s3proxy](https://github.com/gmoon/s3proxy)** in front of a private bucket
  (npm package `gmoon/s3proxy` or container `forkzero/s3proxy-docker`),
- or anything else serving the same objects.

Run the same suite against native S3 and against s3proxy, then diff the results
to prove parity (and measure overhead). That is the point of the kit.

## Install

```bash
npm install --save-dev @forkzero/s3-website-test-kit artillery
```

`artillery` is a peer dependency, so you control its version.

## Scenarios: core vs s3proxy

- **`scenarios/core/`** - portable. Every request is valid against native S3
  website hosting *and* s3proxy (static files, streaming, `206` range, `403`
  on a private object, `404` -> error document, special-character keys, HEAD).
- **`scenarios/s3proxy/`** - target-specific. `health.yml` hits `/health`,
  which s3proxy serves but native S3 website hosting does not.
  `error-contract.yml` asserts s3proxy's XML error bodies (`404`/`403` ->
  `application/xml`), which native S3 website hosting returns as `text/html`.
  Only run these against an s3proxy target.

## Usage

Resolve asset paths with the package helpers:

```js
import { config, scenario, paths } from '@forkzero/s3-website-test-kit';

config('load-test.yml');             // -> /abs/.../configs/load-test.yml
scenario('core/load-test.yml');      // -> /abs/.../scenarios/core/load-test.yml
scenario('s3proxy/health.yml');      // -> /abs/.../scenarios/s3proxy/health.yml
```

Or point the Artillery CLI at the installed files. Override `--target` to choose
what you are testing:

```bash
# Against native S3 website hosting
artillery run \
  --target http://my-bucket.s3-website-us-east-1.amazonaws.com \
  --config node_modules/@forkzero/s3-website-test-kit/configs/load-test.yml \
  node_modules/@forkzero/s3-website-test-kit/scenarios/core/load-test.yml

# Against s3proxy
artillery run \
  --target http://localhost:8080 \
  --config node_modules/@forkzero/s3-website-test-kit/configs/load-test.yml \
  node_modules/@forkzero/s3-website-test-kit/scenarios/core/load-test.yml
```

Set `TEST_ENVIRONMENT` (e.g. `native-s3`, `s3proxy-docker`, `s3proxy-npm`) to
label the run in the JSON summary the `test-runner.js` processor emits.

## Running the conformance gate

Conformance is the kit's headline feature, so running it is one line. Pair
`configs/conformance.yml` (enables the `expect` plugin — the load configs don't,
so `expect:` assertions are otherwise silently inert) with the core conformance
scenario, and override `--target`:

```bash
artillery run \
  --config node_modules/@forkzero/s3-website-test-kit/configs/conformance.yml \
  --target http://localhost:8080 \
  node_modules/@forkzero/s3-website-test-kit/scenarios/core/conformance.yml
```

The scenario is a single sequential flow (one vuser hits every endpoint in
order), so each assertion runs exactly once regardless of arrival volume, and
**any failed expectation makes Artillery exit non-zero** — usable directly as a
CI gate.

> The conformance config intentionally omits a `processor`: pairing the `expect`
> plugin with this package's ESM processor crashes Artillery. Use a load config
> (e.g. `configs/docker-container.yml`) when you want the JSON summary.

## Contents

```
configs/           Artillery config files (phases, processor wiring)
scenarios/core/    Portable S3-website scenarios (native S3 and s3proxy)
scenarios/s3proxy/ s3proxy-only scenarios (health)
utils/             Shared processor (test-runner.js) and results comparator
test-data/         Script to create the required objects in your S3 test bucket
```

### Comparing two runs

A run using a config with the `test-runner.js` processor writes a JSON summary
named `load-test-results-<TEST_ENVIRONMENT>-<ts>.json`. `s3-website-perf-compare`
diffs two of them — a **baseline** and a **candidate** — labelling each by its
`TEST_ENVIRONMENT`. For example, native S3 vs s3proxy:

```bash
# each argument is a results file or a bare TEST_ENVIRONMENT label
# (uses the latest matching file in the current directory)
npx s3-website-perf-compare compare --baseline native-s3 --candidate s3proxy-docker

# or let it pick the two most recent runs from different environments:
npx s3-website-perf-compare compare
```

## Test data requirements

The conformance suite asserts specific keys, sizes, **and content-types**, plus
a deterministic `403`. The scripts in `test-data/` stand this up for you.

### Bootstrap a target from scratch

`bootstrap-s3-target.sh` creates a working conformance target end-to-end in any
account — region-aware bucket creation, the dataset with the exact content-types
the suite asserts, and a bucket-policy `Deny` for the `403` case (which works
under BucketOwnerEnforced / Block Public Access, unlike a legacy object ACL):

```bash
BUCKET=my-test-bucket ./test-data/bootstrap-s3-target.sh            # create + load
BUCKET=my-test-bucket PUBLIC_READ=true ./test-data/bootstrap-s3-target.sh  # also serve native S3 website hosting
BUCKET=my-test-bucket ./test-data/bootstrap-s3-target.sh teardown   # delete everything
```

Leave `PUBLIC_READ` unset for an s3proxy target (s3proxy reads with its own
credentials); set `PUBLIC_READ=true` to also grant anonymous read so the bucket
can serve **native S3 static-website hosting** (disables Block Public Access).

### Load data into an existing bucket

`setup-s3-data.sh` uploads just the dataset (with content-types and the `403`
policy) into a bucket you already have. `BUCKET` is **required** — there is no
default bucket:

```bash
BUCKET=my-test-bucket ./test-data/setup-s3-data.sh
```

### The dataset

- `index.html` — `text/html`, 338 B
- `large.bin` — `application/octet-stream`, 10 MB (streaming / range)
- `test1m.tmp` — `binary/octet-stream`, 1 MB
- `zerobytefile` — `binary/octet-stream`, 0 B
- `unauthorized.html` — returns `403` (bucket-policy `Deny`)
- a special-character key — 46 B, for URL-encoding tests
- a missing key (e.g. `/filenotfound`) exercises the `404` path — no object needed

## Public API / stability

What this package supports for consumers (changes here follow semver):

- **JS helpers** — `paths`, `config()`, `scenario()` from the package root
  (`import { config, scenario } from '@forkzero/s3-website-test-kit'`). Typed via
  the shipped `index.d.ts`.
- **Asset files by path** — everything under `configs/` and `scenarios/`,
  referenced as `node_modules/@forkzero/s3-website-test-kit/…` (or via the
  helpers). Filenames are part of the contract.
- **CLI** — the `s3-website-perf-compare` bin and its arguments.
- **Results contract** — a run using a `processor:`-wired config writes
  `load-test-results-<TEST_ENVIRONMENT>-<ts>.json`; that name and its `summary`
  shape are what `s3-website-perf-compare` consumes.

**Internal (no stability guarantee — do not import directly):** everything under
`utils/` (e.g. `test-runner.js`, `results-parser.js`). The processor is loaded by
Artillery via the `processor:` path inside a config, and the parser is exposed
through the CLI — neither is a supported import target.

## License

Apache-2.0

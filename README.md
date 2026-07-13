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
  which s3proxy serves but native S3 website hosting does not. Only run it
  against an s3proxy target.

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

## Contents

```
configs/           Artillery config files (phases, processor wiring)
scenarios/core/    Portable S3-website scenarios (native S3 and s3proxy)
scenarios/s3proxy/ s3proxy-only scenarios (health)
utils/             Shared processor (test-runner.js) and results comparator
test-data/         Script to create the required objects in your S3 test bucket
```

### Comparing two runs

`test-runner.js` writes a JSON summary per run; `results-parser.js` diffs two of
them, for example native S3 vs s3proxy:

```bash
npx s3-website-perf-compare compare \
  --docker-results test-results-native-s3-<ts>.json \
  --npm-results test-results-s3proxy-<ts>.json
```

## Test data requirements

Your S3 test bucket must contain these objects (see `test-data/setup-s3-data.sh`):

- `index.html` (~338 bytes) - basic HTML
- `large.bin` (10 MB) - large binary for streaming
- `test1m.tmp` (1 MB) - medium file
- `zerobytefile` (0 bytes) - empty file
- `unauthorized.html` - object that returns 403
- `404.html` (or your configured error document)
- a filename with special characters, for URL-encoding tests

## License

Apache-2.0

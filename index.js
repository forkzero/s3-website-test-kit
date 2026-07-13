import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Absolute path to this package's root, so consumers can locate the shared
// Artillery assets without hardcoding a `node_modules/@forkzero/...` path.
const root = dirname(fileURLToPath(import.meta.url));

export const paths = {
  root,
  configs: join(root, 'configs'),
  scenarios: join(root, 'scenarios'),
  utils: join(root, 'utils'),
  testData: join(root, 'test-data'),
};

/** Absolute path to a config file, e.g. `config('load-test.yml')`. */
export const config = (name) => join(root, 'configs', name);

/** Absolute path to a scenario file, e.g. `scenario('load-test.yml')`. */
export const scenario = (name) => join(root, 'scenarios', name);

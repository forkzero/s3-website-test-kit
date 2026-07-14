/**
 * Public JS API of @forkzero/s3-website-test-kit: helpers to resolve the
 * shipped Artillery assets without hardcoding a node_modules path.
 */

/** Absolute paths to the package and its asset directories. */
export const paths: {
  /** Package root. */
  root: string;
  /** `configs/` directory. */
  configs: string;
  /** `scenarios/` directory. */
  scenarios: string;
  /** `utils/` directory (internal — not part of the public API). */
  utils: string;
  /** `test-data/` directory. */
  testData: string;
};

/** Absolute path to a config file, e.g. `config('conformance.yml')`. */
export function config(name: string): string;

/** Absolute path to a scenario file, e.g. `scenario('core/conformance.yml')`. */
export function scenario(name: string): string;

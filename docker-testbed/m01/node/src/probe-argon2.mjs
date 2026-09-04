import { performance } from "node:perf_hooks";
import argon2 from "argon2";

const password = "M01 synthetic calibration password";
const candidates = [
  { memoryCost: 19456, timeCost: 2, parallelism: 1 },
  { memoryCost: 32768, timeCost: 2, parallelism: 1 },
  { memoryCost: 65536, timeCost: 2, parallelism: 1 },
  { memoryCost: 65536, timeCost: 3, parallelism: 1 },
  { memoryCost: 98304, timeCost: 2, parallelism: 1 },
];

const measurements = [];
for (const candidate of candidates) {
  const started = performance.now();
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    hashLength: 32,
    saltLength: 16,
    ...candidate,
  });
  const elapsedMs = performance.now() - started;
  const verified = await argon2.verify(hash, password);
  const rejectsWrongPassword = !(await argon2.verify(hash, `${password}!`));
  measurements.push({ ...candidate, elapsedMs, verified, rejectsWrongPassword });
}

const passing = measurements.filter((measurement) => measurement.verified && measurement.rejectsWrongPassword);
const selected = passing.sort((left, right) => Math.abs(left.elapsedMs - 100) - Math.abs(right.elapsedMs - 100))[0];
const result = {
  node: process.version,
  targetMs: 100,
  measurements,
  selected,
  provisional: true,
  dsmCalibrationRequired: true,
  passed: Boolean(selected) && selected.memoryCost <= 98304,
};
console.log(JSON.stringify(result, null, 2));
if (!result.passed) {
  process.exitCode = 1;
}

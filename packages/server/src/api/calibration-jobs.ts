import { randomUUID } from 'node:crypto';

export type CalibrationJobPhase = 'loading-model' | 'measuring' | 'finalizing';
export type CalibrationJobState = 'running' | 'succeeded' | 'failed';

export interface CalibrationJobSnapshot<Result> {
  readonly id: string;
  readonly state: CalibrationJobState;
  readonly phase: CalibrationJobPhase;
  readonly progress: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly result: Result | null;
  readonly errorCode: string | null;
}

type CalibrationReporter = (phase: CalibrationJobPhase, progress: number) => void;

interface StoredCalibrationJob<Result> extends CalibrationJobSnapshot<Result> {
  readonly principalId: number;
}

const publicSnapshot = <Result>(
  job: StoredCalibrationJob<Result>,
): CalibrationJobSnapshot<Result> => ({
  id: job.id,
  state: job.state,
  phase: job.phase,
  progress: job.progress,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  result: job.result,
  errorCode: job.errorCode,
});

export class CalibrationJobRegistry<Result> {
  readonly #jobs = new Map<number, StoredCalibrationJob<Result>>();

  constructor(private readonly classifyFailure: (error: unknown) => string) {}

  status(principalId: number): CalibrationJobSnapshot<Result> | null {
    const job = this.#jobs.get(principalId);
    return job === undefined ? null : publicSnapshot(job);
  }

  start(
    principalId: number,
    operation: (report: CalibrationReporter) => Promise<Result>,
  ): CalibrationJobSnapshot<Result> {
    const current = this.#jobs.get(principalId);
    if (current?.state === 'running') return publicSnapshot(current);

    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const initial: StoredCalibrationJob<Result> = {
      id,
      principalId,
      state: 'running',
      phase: 'loading-model',
      progress: 1,
      startedAt,
      finishedAt: null,
      result: null,
      errorCode: null,
    };
    this.#jobs.set(principalId, initial);

    const report: CalibrationReporter = (phase, progress) => {
      const job = this.#jobs.get(principalId);
      if (job?.id !== id || job.state !== 'running') return;
      this.#jobs.set(principalId, {
        ...job,
        phase,
        progress: Math.min(99, Math.max(job.progress, Math.round(progress))),
      });
    };

    void Promise.resolve()
      .then(() => operation(report))
      .then((result) => {
        const job = this.#jobs.get(principalId);
        if (job?.id !== id) return;
        this.#jobs.set(principalId, {
          ...job,
          state: 'succeeded',
          phase: 'finalizing',
          progress: 100,
          finishedAt: new Date().toISOString(),
          result,
        });
      })
      .catch((error: unknown) => {
        const job = this.#jobs.get(principalId);
        if (job?.id !== id) return;
        this.#jobs.set(principalId, {
          ...job,
          state: 'failed',
          finishedAt: new Date().toISOString(),
          errorCode: this.classifyFailure(error),
        });
      });

    return publicSnapshot(initial);
  }
}

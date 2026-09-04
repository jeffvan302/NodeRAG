import { spawn } from 'node:child_process';
import type {
  ManagedProcess,
  PlatformAdapter,
  ProcessAdapter,
  ProcessSpec,
  ResourceAdapter,
} from '@noderag/shared';

export interface DsmAdapterEnvironment {
  readonly packageRoot: string;
  readonly packageDataRoot: string;
  readonly temporaryRoot: string;
  readonly nodeBinary: string;
  readonly port: number;
}

const requireAbsolute = (name: string, value: string): string => {
  if (!value.startsWith('/')) throw new Error(`${name} must be an absolute DSM path.`);
  return value;
};

class DsmProcessAdapter implements ProcessAdapter {
  readonly #nodeBinary: string;

  constructor(nodeBinary: string) {
    this.#nodeBinary = requireAbsolute('nodeBinary', nodeBinary);
  }

  async spawn(spec: ProcessSpec): Promise<ManagedProcess> {
    if (spec.command !== this.#nodeBinary) {
      throw new Error('DSM process adapter only starts the declared Node.js_v22 binary.');
    }
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      shell: false,
      stdio: 'inherit',
    });
    if (child.pid === undefined) throw new Error('The DSM process did not receive a PID.');
    const pid = child.pid;
    return {
      pid,
      stop: async (signal = 'SIGTERM') => {
        if (child.exitCode !== null) return;
        child.kill(signal);
        await new Promise<void>((resolveExit, reject) => {
          child.once('exit', () => resolveExit());
          child.once('error', reject);
        });
      },
    };
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

class DsmResourceAdapter implements ResourceAdapter {
  readonly port: number;
  constructor(port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid DSM resource port: ${port}`);
    }
    this.port = port;
  }
  async acquire(): Promise<void> {}
  async release(): Promise<void> {}
}

export const createDsmAdapterContract = (environment: DsmAdapterEnvironment): PlatformAdapter => ({
  kind: 'dsm',
  paths: {
    packageRoot: requireAbsolute('packageRoot', environment.packageRoot),
    dataRoot: requireAbsolute('packageDataRoot', environment.packageDataRoot),
    temporaryRoot: requireAbsolute('temporaryRoot', environment.temporaryRoot),
    uiRoot: `${requireAbsolute('packageRoot', environment.packageRoot)}/ui`,
  },
  process: new DsmProcessAdapter(environment.nodeBinary),
  resources: new DsmResourceAdapter(environment.port),
});

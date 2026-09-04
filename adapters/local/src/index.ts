import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type {
  ManagedProcess,
  PlatformAdapter,
  PlatformPaths,
  ProcessAdapter,
  ProcessSpec,
  ResourceAdapter,
} from '@noderag/shared';

const assertPort = (port: number): number => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid local port: ${port}`);
  }
  return port;
};

class LocalProcessAdapter implements ProcessAdapter {
  async spawn(spec: ProcessSpec): Promise<ManagedProcess> {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      shell: false,
      stdio: 'inherit',
    });
    if (child.pid === undefined) {
      throw new Error('The local process did not receive a PID.');
    }
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

class LocalResourceAdapter implements ResourceAdapter {
  readonly port: number;

  constructor(port: number) {
    this.port = assertPort(port);
  }

  async acquire(): Promise<void> {}
  async release(): Promise<void> {}
}

export interface LocalAdapterOptions {
  readonly root: string;
  readonly port?: number;
}

export const createLocalAdapter = (options: LocalAdapterOptions): PlatformAdapter => {
  const root = resolve(options.root);
  const paths: PlatformPaths = {
    packageRoot: root,
    dataRoot: resolve(root, 'runtime-data'),
    temporaryRoot: resolve(root, '.tmp'),
    uiRoot: resolve(root, 'packages/ui/dist'),
  };
  return {
    kind: 'local',
    paths,
    process: new LocalProcessAdapter(),
    resources: new LocalResourceAdapter(options.port ?? 8787),
    backgroundScheduling: {
      workerNice: 10,
      workerIoClass: 2,
      workerIoPriority: 7,
      embedderNice: 5,
    },
  };
};

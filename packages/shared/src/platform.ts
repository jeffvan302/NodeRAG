export type PlatformKind = 'local' | 'dsm';
export type TerminationSignal = 'SIGINT' | 'SIGKILL' | 'SIGTERM';

export interface PlatformPaths {
  readonly packageRoot: string;
  readonly dataRoot: string;
  readonly temporaryRoot: string;
  readonly uiRoot: string;
}

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ManagedProcess {
  readonly pid: number;
  stop(signal?: TerminationSignal): Promise<void>;
}

export interface ProcessAdapter {
  spawn(spec: ProcessSpec): Promise<ManagedProcess>;
  isAlive(pid: number): boolean;
}

export interface ResourceAdapter {
  readonly port: number;
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly paths: PlatformPaths;
  readonly process: ProcessAdapter;
  readonly resources: ResourceAdapter;
}

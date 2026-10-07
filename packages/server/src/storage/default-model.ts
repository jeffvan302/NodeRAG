import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadModelArtifact, sha256File, type ModelArtifactResult } from './model-artifacts.js';

export interface DefaultModelFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly urls: readonly string[];
}

export const defaultModelFiles: readonly DefaultModelFile[] = [
  {
    name: 'model.onnx',
    bytes: 600_127_788,
    sha256: 'a7eda29cc374b01ae75eb1af1ab65c3c61a64c43f39f16e08c6e37c075dcbf4d',
    urls: [
      'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/resolve/bd58e9fd4b0467770da53678d8da25481c0f959b/onnx/model_quint8_avx2.onnx?download=true',
    ],
  },
  {
    name: 'tokenizer.json',
    bytes: 11_423_705,
    sha256: 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a',
    urls: [
      'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/resolve/bd58e9fd4b0467770da53678d8da25481c0f959b/tokenizer.json?download=true',
    ],
  },
  {
    name: 'tokenizer_config.json',
    bytes: 9_706,
    sha256: '253153d0738ceb4c668d2eff957714dd2bea0b56de772a9fdccd96cbf517e6a0',
    urls: [
      'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/resolve/bd58e9fd4b0467770da53678d8da25481c0f959b/tokenizer_config.json?download=true',
    ],
  },
];

export interface DefaultModelInstallStatus {
  readonly state: 'missing' | 'downloading' | 'paused' | 'failed' | 'ready';
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly progress: number;
  readonly currentFile: string | null;
  readonly errorCode: string | null;
}

const safeDownloadError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  if (
    /^(model_checksum_mismatch|model_download_(failed|url_forbidden|redirect_invalid|redirect_limit|http_[0-9]{3}))$/u.test(
      message,
    )
  ) {
    return message;
  }
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'model_storage_full';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'model_storage_permission_denied';
  return 'model_download_failed';
};

const fileSize = async (path: string): Promise<number> =>
  lstat(path)
    .then((value) => (value.isFile() ? value.size : 0))
    .catch(() => 0);

export class DefaultModelInstaller {
  private task: Promise<void> | null = null;
  private errorCode: string | null = null;
  private currentFile: string | null = null;
  private readonly markerPath: string;

  constructor(
    private readonly options: {
      readonly root: string;
      readonly allowedHosts: readonly string[];
      readonly files?: readonly DefaultModelFile[];
      readonly fetcher?: typeof fetch;
    },
  ) {
    this.markerPath = join(options.root, '.default-model.verified.json');
  }

  private get files(): readonly DefaultModelFile[] {
    return this.options.files ?? defaultModelFiles;
  }

  private markerContents(): string {
    return JSON.stringify({
      version: 1,
      files: this.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    });
  }

  private async markerValid(): Promise<boolean> {
    const expected = this.markerContents();
    return readFile(this.markerPath, 'utf8')
      .then((value) => value === expected)
      .catch(() => false);
  }

  async status(): Promise<DefaultModelInstallStatus> {
    const sizes = await Promise.all(
      this.files.map(async (file) => {
        const complete = await fileSize(join(this.options.root, file.name));
        if (complete === file.bytes) return complete;
        return Math.min(
          file.bytes,
          await fileSize(join(this.options.root, `${file.name}.partial`)),
        );
      }),
    );
    const downloadedBytes = sizes.reduce((total, value) => total + value, 0);
    const totalBytes = this.files.reduce((total, value) => total + value.bytes, 0);
    const ready = downloadedBytes === totalBytes && (await this.markerValid());
    return {
      state: ready
        ? 'ready'
        : this.task !== null
          ? 'downloading'
          : this.errorCode !== null
            ? 'failed'
            : downloadedBytes > 0
              ? 'paused'
              : 'missing',
      downloadedBytes,
      totalBytes,
      progress: totalBytes === 0 ? 100 : Math.floor((downloadedBytes / totalBytes) * 100),
      currentFile: this.currentFile,
      errorCode: this.errorCode,
    };
  }

  start(record: (artifact: ModelArtifactResult) => Promise<void>): void {
    if (this.task !== null) return;
    this.errorCode = null;
    this.task = this.install(record)
      .catch((error: unknown) => {
        this.errorCode = safeDownloadError(error);
      })
      .finally(() => {
        this.currentFile = null;
        this.task = null;
      });
  }

  async waitForIdle(): Promise<void> {
    await this.task;
  }

  private async install(record: (artifact: ModelArtifactResult) => Promise<void>): Promise<void> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    await rm(this.markerPath, { force: true });
    for (const file of this.files) {
      this.currentFile = file.name;
      const destination = join(this.options.root, file.name);
      const valid =
        (await fileSize(destination)) === file.bytes &&
        (await sha256File(destination).catch(() => '')) === file.sha256;
      let artifact: ModelArtifactResult;
      if (valid) {
        artifact = { name: file.name, bytes: file.bytes, sha256: file.sha256 };
      } else {
        await rm(destination, { force: true });
        artifact = await downloadModelArtifact({
          name: file.name,
          urls: file.urls,
          expectedSha256: file.sha256,
          allowedHosts: this.options.allowedHosts,
          destinationRoot: this.options.root,
          ...(this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher }),
        });
      }
      await record(artifact);
    }
    const partialMarker = `${this.markerPath}.partial`;
    await writeFile(partialMarker, this.markerContents(), { mode: 0o600 });
    await rename(partialMarker, this.markerPath);
  }
}

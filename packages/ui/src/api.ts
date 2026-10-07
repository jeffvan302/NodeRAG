import { appUrl } from './url.js';
import { createIdempotencyKey } from './idempotency-key.js';

export interface ProblemDetail {
  readonly status: number;
  readonly code: string;
  readonly title?: string;
  readonly requestId?: string;
}

export interface SetupStatus {
  readonly state: string;
  readonly tokenIssued: boolean;
  readonly tokenExpiresAt: string | null;
  readonly step: string;
  readonly progress: number;
}

export interface Principal {
  readonly principalId: number;
  readonly username: string | null;
  readonly serverAdmin: boolean;
  readonly searchOnly: boolean;
}

export interface Silo {
  readonly id: number;
  readonly slug: string;
  readonly displayName: string;
}

export type JsonRecord = Record<string, unknown>;

const csrfKey = 'noderag.csrf';
export const authenticationRequiredEvent = 'noderag:authentication-required';
let csrfToken = sessionStorage.getItem(csrfKey);

export class ApiProblem extends Error {
  readonly detail: ProblemDetail;

  constructor(detail: ProblemDetail) {
    super(detail.title ?? detail.code.replaceAll('_', ' '));
    this.name = 'ApiProblem';
    this.detail = detail;
  }
}

const parseFailure = async (response: Response): Promise<ProblemDetail> => {
  const fallback = { status: response.status, code: `request_failed_${String(response.status)}` };
  try {
    const body = (await response.json()) as Partial<ProblemDetail>;
    return {
      status: typeof body.status === 'number' ? body.status : response.status,
      code: typeof body.code === 'string' ? body.code : fallback.code,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
    };
  } catch {
    return fallback;
  }
};

export const api = async <T>(
  path: string,
  init: RequestInit & { readonly idempotent?: boolean } = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken !== null) {
    headers.set('x-csrf-token', csrfToken);
  }
  if (init.idempotent === true && !headers.has('idempotency-key')) {
    headers.set('idempotency-key', createIdempotencyKey());
  }
  const response = await fetch(appUrl(path), { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const detail = await parseFailure(response);
    if (detail.code === 'authentication_required' || detail.code === 'csrf_rejected') {
      forgetSession();
      window.dispatchEvent(new Event(authenticationRequiredEvent));
    }
    throw new ApiProblem(detail);
  }
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') ?? '';
  return (contentType.includes('json') ? await response.json() : await response.text()) as T;
};

export const postJson = <T>(
  path: string,
  body: unknown,
  options: { readonly idempotent?: boolean; readonly method?: 'POST' | 'PUT' | 'PATCH' } = {},
): Promise<T> =>
  api<T>(path, {
    method: options.method ?? 'POST',
    body: JSON.stringify(body),
    ...(options.idempotent === undefined ? {} : { idempotent: options.idempotent }),
  });

export const signIn = async (username: string, password: string): Promise<void> => {
  const session = await postJson<{ readonly csrfToken: string }>('/v1/auth/login', {
    username,
    password,
  });
  csrfToken = session.csrfToken;
  sessionStorage.setItem(csrfKey, session.csrfToken);
};

export const signOut = async (): Promise<void> => {
  await api<undefined>('/v1/auth/logout', { method: 'POST' });
  csrfToken = null;
  sessionStorage.removeItem(csrfKey);
};

export const forgetSession = (): void => {
  csrfToken = null;
  sessionStorage.removeItem(csrfKey);
};

export const displayError = (error: unknown): string => {
  if (error instanceof ApiProblem) {
    const friendly: Record<string, string> = {
      authentication_required: 'Please sign in again.',
      csrf_rejected: 'Your session needs to be refreshed. Please sign in again.',
      invalid_request: 'Some information is missing or invalid.',
      mutation_not_ready: 'NodeRag is not ready to make changes yet.',
      read_not_ready: 'Search is temporarily unavailable while NodeRag starts.',
      storage_probe_failed: 'NodeRag could not validate that storage folder.',
      storage_permission_denied:
        'NodeRag cannot create and manage files there. Give the noderag system user Read/Write access to the selected folder and its parent share.',
      storage_path_must_be_absolute: 'Enter a complete absolute Synology or Linux folder path.',
      storage_path_must_be_under_volume:
        'Synology storage must resolve to a folder under /volume1, /volume2, or another DSM volume.',
      storage_path_not_directory: 'The selected storage path is not a usable folder.',
      storage_managed_subdirectory_invalid:
        'The existing .noderag-managed item is not a safe folder. Rename or remove that item and try again.',
      storage_filesystem_unsupported: 'NodeRag storage must use a Synology ext4 or Btrfs volume.',
      storage_capacity_insufficient:
        'That volume does not have enough free space for NodeRag and its rebuild reserve.',
      storage_encryption_required: 'This installation requires an approved encrypted storage path.',
      storage_read_after_fsync_failed:
        'The storage folder failed the durable write and read-back verification.',
      chat_storage_path_invalid: 'The .noderag-chat item already exists but is not a safe folder.',
      chat_storage_manifest_invalid:
        'The existing Chat storage manifest is missing, unsafe, or not recognized.',
      chat_model_not_available:
        'That Chat model is not in the current provider catalog. Refresh the provider models.',
      chat_model_catalog_stale:
        'That Chat model is from an older provider catalog. Refresh models and select a current entry.',
      chat_reasoning_effort_not_available:
        'That reasoning effort is not supported by the selected model.',
      chat_generation_provider_not_ready:
        'Test the selected response provider successfully before making it the Chat default.',
      chat_model_capacity_unknown:
        'Enter a verified context-window value for every model used by managed context.',
      chat_reserves_exceed_model_capacity:
        'The context reserves consume the selected model’s verified context window.',
      chat_output_reserve_exceeds_model_limit:
        'The output reserve is larger than the selected model’s verified output limit.',
      l2_output_target_exceeds_model_limit:
        'The L2 summary target is larger than that model’s verified output limit.',
      l3_output_target_exceeds_model_limit:
        'The L3 state target is larger than that model’s verified output limit.',
      managed_context_not_ready:
        'Save the managed context configuration and run its synthetic preview successfully first.',
      chat_file_required: 'Choose an image file to upload.',
      chat_file_name_invalid: 'That image filename is not safe to store.',
      chat_file_type_unsupported: 'Use a PNG, JPEG, GIF, or WebP image.',
      chat_file_signature_invalid:
        'The file contents do not match the selected image type. Choose the original image again.',
      chat_file_empty: 'The selected image is empty.',
      chat_file_too_large: 'That image is larger than the configured Chat file limit.',
      chat_file_quota_exceeded: 'This Chat has reached its file storage limit.',
      chat_file_storage_unsafe: 'NodeRag found an unsafe Chat file path and refused to use it.',
      chat_file_storage_unavailable:
        'NodeRag cannot reach the configured Chat file storage right now.',
      chat_file_disk_full: 'The Chat file storage volume does not have enough free space.',
      chat_file_not_found: 'That Chat file no longer exists or belongs to another Chat.',
      chat_file_delete_confirmation_required: 'Confirm the Chat file deletion and try again.',
      ollama_cloud_internet_not_ready:
        'Test both Ollama Cloud web search and web fetch successfully before enabling internet by default.',
      storage_location_in_use:
        'That path or purpose is already tied to recovery work. Add a new storage location instead.',
      model_download_failed:
        'The embedding model download stopped. Check the NAS internet connection and try again; NodeRag will resume the partial download.',
      model_download_url_forbidden: 'The configured model download address is not approved.',
      model_download_redirect_invalid: 'The model provider returned an invalid download redirect.',
      model_download_redirect_limit: 'The model provider returned too many download redirects.',
      model_checksum_mismatch:
        'The downloaded model failed its checksum verification and was not activated.',
      model_storage_full: 'The package volume does not have enough free space for the local model.',
      model_storage_permission_denied:
        'NodeRag cannot write the embedding model into its private package storage.',
      embedding_model_not_installed:
        'The local embedding model is not installed. Return to the model step and install it before calibration.',
      embedding_model_restart_required:
        'The embedding model changed. Restart NodeRag and run calibration again.',
      embedding_model_load_failed:
        'NodeRag found the local model but could not load it. The model may be incomplete or incompatible with this processor.',
      embedding_worker_unavailable:
        'The local embedding service is not running. Restart NodeRag and try calibration again.',
      embedding_calibration_token_limit:
        'A calibration sample exceeded the active model token limit.',
      embedding_calibration_failed:
        'The local embedding service could not complete calibration. Check the NodeRag package logs for the recorded error code.',
      embedding_calibration_timed_out:
        'Calibration did not finish within two hours. Restart NodeRag and try again.',
      'source-folder-not-found': 'That folder no longer exists on the NodeRag server.',
      'source-folder-unreadable':
        'NodeRag cannot read that folder. Check the service account permissions.',
      'source-already-connected':
        'That input folder is already connected to this knowledge space. Refresh the source list instead of adding it again.',
      'source-create-failed': `NodeRag could not save this input folder. Reference: ${error.detail.requestId ?? 'not available'}.`,
      'source-update-failed': `NodeRag could not update this input folder. Reference: ${error.detail.requestId ?? 'not available'}.`,
      'source-not-found': 'That input-folder connection no longer exists. Refresh the folder list.',
      'crawl-failed':
        'NodeRag could not queue this crawl. Refresh the folder and job lists, then try again.',
      'source-detach-failed':
        'NodeRag could not disconnect this input folder. Refresh the folder list and try again.',
      'invalid-source-glob':
        'One of the include or exclude patterns is invalid. Use comma-separated patterns such as **/*.pdf, **/*.docx.',
      'too-many-source-globs': 'Use no more than 64 include or exclude patterns.',
      'invalid-source-schedule': 'The repeat interval must be a whole number of minutes.',
      'source-folder-browse-failed': 'NodeRag could not read the available source folders.',
      'source-root-must-be-absolute': 'Choose or enter an absolute server folder path.',
      'source-root-not-directory': 'That path is not a folder NodeRag can use.',
      'source-root-outside-allowlist':
        'That folder is outside the source locations allowed for NodeRag.',
      'source-roots-not-configured':
        'No browsable source locations are configured for this NodeRag server.',
      research_name_exists: 'You already have a research collection with that name.',
      research_not_found: 'That research collection is no longer available. Refresh Research.',
      reference_not_found:
        'That passage is no longer part of the active document index and cannot be saved.',
      document_page_not_found:
        'That PDF page is not available in the current document index. Re-index the document and try again.',
      artifact_missing:
        'The processed document file is unavailable. Re-index the document and try again.',
      research_reference_not_found:
        'That saved passage is no longer in the research collection. Refresh Research.',
      ollama_cloud_key_required: 'Enter or save an Ollama Cloud API key first.',
      ollama_cloud_model_required: 'Choose an Ollama Cloud model first.',
      ollama_cloud_credentials_rejected:
        'Ollama Cloud rejected this API key. Replace the key and test again.',
      ollama_cloud_rate_limited:
        'Ollama Cloud is temporarily rate limited. Wait briefly, then test again.',
      ollama_cloud_model_not_found:
        'Ollama Cloud did not recognize that model name. Refresh the model list or enter the exact Cloud model name.',
      ollama_cloud_unavailable:
        'Ollama Cloud is temporarily unavailable. Check internet access and try again.',
      ollama_cloud_unreachable:
        'NodeRag could not reach Ollama Cloud. Check the server internet connection.',
      ollama_cloud_timeout: 'Ollama Cloud did not respond before the connection-test timeout.',
      ollama_cloud_response_malformed:
        'Ollama Cloud returned a response NodeRag could not safely read.',
      ollama_cloud_response_too_large:
        'Ollama Cloud returned more data than the administration test allows.',
      ollama_cloud_service_root_invalid:
        'The Ollama connection is not the approved Ollama Cloud address.',
      chat_provider_unavailable: 'The Chat provider configuration is unavailable in this build.',
      openai_oauth_unavailable:
        'The OpenAI connection service is unavailable. Restart NodeRag and try again.',
      openai_oauth_required: 'Connect an OpenAI account before using these settings.',
      openai_model_required: 'Choose a model from the connected OpenAI account.',
      openai_model_not_available:
        'That model is no longer available to the connected account. Refresh the model list.',
      openai_login_owned_by_another_administrator:
        'Another administrator started this OpenAI sign-in. Ask them to finish or cancel it.',
      openai_login_denied: 'OpenAI sign-in was denied or did not complete.',
      openai_disconnect_confirmation_required:
        'Confirm that you want to disconnect and remove the saved OpenAI credential.',
      openai_protocol_invalid:
        'The OpenAI connection service returned an unexpected response. Restart NodeRag and try again.',
      app_server_request_timeout:
        'The OpenAI connection service did not respond in time. Try again.',
      app_server_process_stopped:
        'The OpenAI connection service stopped. Restart NodeRag and try again.',
      app_server_unavailable:
        'The OpenAI connection service is not ready. Restart NodeRag and try again.',
      secret_vault_unavailable: 'Protected credential storage is unavailable.',
      service_not_operational: 'Finish the first-time setup before signing in.',
    };
    if (/^model_download_http_[0-9]{3}$/u.test(error.detail.code)) {
      return `The model provider returned HTTP ${error.detail.code.slice(-3)}. Check the NAS internet connection and try again.`;
    }
    return friendly[error.detail.code] ?? error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
};

export const formatBytes = (value: unknown): string => {
  const bytes = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = -1;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
};

export const truncateGraphemes = (value: string, maximum: number): string => {
  if (value.length <= maximum) return value;
  if (typeof Intl.Segmenter === 'undefined') return `${value.slice(0, maximum)}…`;
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  return segments.length <= maximum
    ? value
    : `${segments
        .slice(0, maximum)
        .map((entry) => entry.segment)
        .join('')}…`;
};

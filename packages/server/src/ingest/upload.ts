import { basename, extname } from 'node:path';
import type { SqlClient } from '../store/database.js';
import { databaseInteger } from '../store/database.js';
import {
  validatedDocumentMetadata,
  type DocumentFileStore,
  type StagedUpload,
} from '../storage/document-files.js';

export interface AcceptDocumentUploadInput {
  readonly siloId: number;
  readonly principalId: number;
  readonly filename: string;
  readonly mimeType: string;
  readonly staged: StagedUpload;
  readonly provenanceMetadata?: Readonly<Record<string, unknown>>;
}

export interface AcceptedDocumentUpload {
  readonly documentId: number;
  readonly jobId: number;
  readonly state: 'pending';
  readonly originalSha256: string;
}

export const uploadRequestDigestInput = (input: {
  readonly siloId: number;
  readonly filename: string;
  readonly mimeType: string;
  readonly sha256: Buffer;
  readonly bytes: number;
}): string =>
  JSON.stringify({
    siloId: input.siloId,
    filename: input.filename.normalize('NFC'),
    mimeType: input.mimeType.toLowerCase(),
    sha256: input.sha256.toString('hex'),
    bytes: input.bytes,
  });

export const acceptDocumentUpload = async (
  database: SqlClient,
  files: DocumentFileStore,
  input: AcceptDocumentUploadInput,
): Promise<AcceptedDocumentUpload> => {
  const metadata = validatedDocumentMetadata(input.filename, input.mimeType);
  const sequence = await database.query<{ id: unknown }>(
    `SELECT nextval(pg_get_serial_sequence('noderag.document', 'id')) AS id`,
  );
  const documentId = databaseInteger(sequence.rows[0]?.id, 'document id');
  const paths = await files.promoteOriginal(input.staged, documentId, metadata.extension);
  try {
    await database.query(
      `INSERT INTO noderag.document
         (id, silo_id, name, title, extension, mime_type, relative_path,
          byte_count, original_sha256, uploaded_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $3, $7, $8, $9,
               jsonb_build_object('managedOriginal', $10::text,
                                  'managedMarkdown', $11::text) || $12::jsonb)`,
      [
        documentId,
        input.siloId,
        metadata.name,
        basename(metadata.name, extname(metadata.name)),
        metadata.extension,
        metadata.mimeType,
        input.staged.bytes,
        input.staged.sha256,
        input.principalId,
        paths.originalRelative,
        paths.markdownRelative,
        JSON.stringify(input.provenanceMetadata ?? {}),
      ],
    );
    const job = await database.query<{ id: unknown }>(
      `INSERT INTO noderag.job (kind, document_id, silo_id, priority, payload)
       VALUES ('extract', $1, $2, 3, jsonb_build_object('format', $3::text))
       RETURNING id`,
      [documentId, input.siloId, metadata.extension],
    );
    const jobId = databaseInteger(job.rows[0]?.id, 'extract job id');
    await database.query(
      `INSERT INTO noderag.job_event (job_id, sequence, event_type, detail)
       VALUES ($1, 0, 'queued', jsonb_build_object('documentId', $2::bigint))`,
      [jobId, documentId],
    );
    await database.query(
      `INSERT INTO noderag.audit_log
         (principal_id, silo_id, action, result, row_count, detail)
       VALUES ($1, $2, 'document.upload', 'ok', 1,
               jsonb_build_object('documentId', $3::bigint, 'bytes', $4::bigint,
                                  'extension', $5::text))`,
      [input.principalId, input.siloId, documentId, input.staged.bytes, metadata.extension],
    );
    return {
      documentId,
      jobId,
      state: 'pending',
      originalSha256: input.staged.sha256.toString('hex'),
    };
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(paths.originalAbsolute, { force: true }));
    throw error;
  }
};

export type AcceptMarkdownUploadInput = AcceptDocumentUploadInput;
export type AcceptedMarkdownUpload = AcceptedDocumentUpload;
export const acceptMarkdownUpload = acceptDocumentUpload;

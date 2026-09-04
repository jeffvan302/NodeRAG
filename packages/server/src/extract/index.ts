import type {
  AssembledDocument,
  DocumentFormat,
  ExtractionOptions,
  InjectedVision,
} from './contract.js';
import { assembleExtractedDocument } from './assembly.js';
import { extractDocx } from './docx.js';
import { extractPdf } from './pdf.js';
import { extractTextDocument } from './text.js';
import { extractXlsx } from './xlsx.js';

export * from './contract.js';
export { assembleExtractedDocument } from './assembly.js';

export const extractDocument = async (
  bytes: Uint8Array,
  format: DocumentFormat,
  options: ExtractionOptions = {},
  injectedVision?: InjectedVision,
): Promise<AssembledDocument> => {
  const extracted =
    format === 'md' || format === 'txt'
      ? await extractTextDocument(bytes, format)
      : format === 'pdf'
        ? await extractPdf(bytes, options, injectedVision)
        : format === 'docx'
          ? await extractDocx(bytes, options, injectedVision)
          : await extractXlsx(bytes, options, injectedVision);
  return assembleExtractedDocument(extracted);
};

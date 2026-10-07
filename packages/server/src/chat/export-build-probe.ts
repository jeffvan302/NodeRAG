import { probeChatExportCapabilities } from './exports.js';

void probeChatExportCapabilities()
  .then((capabilities) => {
    if (
      capabilities['status'] !== 'healthy' ||
      (capabilities['formats'] as Record<string, Record<string, unknown>> | undefined)?.['docx']?.[
        'available'
      ] !== true ||
      (capabilities['formats'] as Record<string, Record<string, unknown>> | undefined)?.['pdf']?.[
        'available'
      ] !== true
    ) {
      throw new Error('built-chat-export-capability-unhealthy');
    }
    process.stdout.write('Built DOCX/PDF export capability probe passed.\n');
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });

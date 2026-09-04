import { loadRuntimeConfig } from '../config.js';
import { runMigrations } from './migrations.js';

const config = await loadRuntimeConfig();
if (config.database === null) {
  throw new Error('Set NODERAG_POSTGRES_PASSWORD_FILE before running migrations.');
}
const manifest = await runMigrations(config.database);
console.info(`Migration head ${manifest.expectedHead} is applied and checksum-verified.`);

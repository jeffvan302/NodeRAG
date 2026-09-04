import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'spk/noderag/src/noderag.svg');
const output = resolve(root, 'spk/generated/m02/icons');
await mkdir(output, { recursive: true });
for (const size of [72, 256]) {
  await sharp(source)
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(resolve(output, `PACKAGE_ICON_${size}.PNG`));
}
console.info('Generated deterministic 72px and 256px DSM package icons.');

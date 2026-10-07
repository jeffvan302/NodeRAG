#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" == "1000" ]]
: "${NODERAG_OLD_SPK:?NODERAG_OLD_SPK is required}"
: "${NODERAG_NEW_SPK:?NODERAG_NEW_SPK is required}"
mkdir -p /work/old-outer /work/old-package /work/new-outer /work/new-package /work/var
tar -xf "${NODERAG_OLD_SPK}" -C /work/old-outer
tar -xzf /work/old-outer/package.tgz -C /work/old-package
tar -xf "${NODERAG_NEW_SPK}" -C /work/new-outer
tar -xzf /work/new-outer/package.tgz -C /work/new-package
grep -q '^version="1.0.0-26"$' /work/old-outer/INFO
grep -q '^version="1.0.0-46"$' /work/new-outer/INFO

export NODERAG_NODE_BIN
NODERAG_NODE_BIN="$(command -v node)"
export NODERAG_PORT=8787 NODERAG_TEST_EMBEDDER=1 NODERAG_SIMULATOR=1
export NODERAG_STORAGE_REBUILD_RESERVE_BYTES=0
export SYNOPKG_PKGDEST=/work/old-package SYNOPKG_PKGVAR=/work/var
/work/old-outer/scripts/postinst
/work/old-outer/scripts/start-stop-status start

node - <<'NODE'
const fs = await import('node:fs');
const base = 'http://127.0.0.1:8787';
for (let attempt = 0; attempt < 120; attempt += 1) {
  if ((await fetch(`${base}/health`).catch(() => null))?.ok) break;
  if (attempt === 119) throw new Error('Revision 26 failed to become healthy.');
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const setupToken = fs.readFileSync('/work/var/secrets/setup.token', 'utf8').trim();
let response = await fetch(`${base}/v1/setup/configure`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    setupToken,
    username: 'upgrade-admin',
    password: 'C11-forward-upgrade-only!',
    defaultSiloName: 'Upgrade Knowledge Base',
  }),
});
if (response.status !== 201) throw new Error(`Revision 26 setup failed: ${response.status} ${await response.text()}`);
const setup = await response.json();
response = await fetch(`${base}/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'upgrade-admin', password: 'C11-forward-upgrade-only!' }),
});
if (!response.ok) throw new Error('Revision 26 login failed.');
const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0];
const login = await response.json();
const mutationHeaders = (key) => ({
  cookie,
  origin: base,
  'x-csrf-token': login.csrfToken,
  'idempotency-key': key,
});
response = await fetch(`${base}/v1/research`, {
  method: 'POST',
  headers: { ...mutationHeaders('c11-upgrade-research'), 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Revision 26 Legal Notes' }),
});
if (response.status !== 201) throw new Error(`Revision 26 Research create failed: ${response.status} ${await response.text()}`);
const research = await response.json();
const form = new FormData();
form.append('file', new Blob(['# Upgrade proof\n\nMAGENTA-ORBIT survives revision 46 without re-indexing.\n'], { type: 'text/markdown' }), 'upgrade-proof.md');
response = await fetch(`${base}/v1/documents?siloId=${setup.defaultSilo.id}`, {
  method: 'POST',
  headers: mutationHeaders('c11-upgrade-document'),
  body: form,
});
if (response.status !== 202) throw new Error(`Revision 26 upload failed: ${response.status} ${await response.text()}`);
const document = await response.json();
for (let attempt = 0; attempt < 120; attempt += 1) {
  response = await fetch(`${base}/v1/search`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'MAGENTA-ORBIT', mode: 'keyword', silos: [setup.defaultSilo.id] }),
  });
  const result = await response.json();
  if (response.ok && result.items?.some((item) => item.text.includes('MAGENTA-ORBIT'))) break;
  if (attempt === 119) throw new Error('Revision 26 document did not become searchable.');
  await new Promise((resolve) => setTimeout(resolve, 500));
}
fs.writeFileSync('/work/upgrade-state.json', JSON.stringify({
  siloId: setup.defaultSilo.id,
  researchId: research.id,
  documentId: document.documentId,
}));
NODE

root_key_before="$(sha256sum /work/var/secrets/root.key | awk '{print $1}')"
/work/old-outer/scripts/preupgrade
export SYNOPKG_PKGDEST=/work/new-package
/work/new-outer/scripts/postupgrade
[[ "$(sha256sum /work/var/secrets/root.key | awk '{print $1}')" == "${root_key_before}" ]]

node - <<'NODE'
const fs = await import('node:fs');
const base = 'http://127.0.0.1:8787';
const saved = JSON.parse(fs.readFileSync('/work/upgrade-state.json', 'utf8'));
for (let attempt = 0; attempt < 120; attempt += 1) {
  if ((await fetch(`${base}/health`).catch(() => null))?.ok) break;
  if (attempt === 119) throw new Error('Revision 32 failed to become healthy.');
  await new Promise((resolve) => setTimeout(resolve, 500));
}
let response = await fetch(`${base}/ready`);
const ready = await response.json();
if (!response.ok || ready.migrationHead !== '000029_chat_files') {
  throw new Error(`Revision 32 migration head is wrong: ${JSON.stringify(ready)}`);
}
response = await fetch(`${base}/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'upgrade-admin', password: 'C11-forward-upgrade-only!' }),
});
if (!response.ok) throw new Error('The revision 26 administrator credential did not survive upgrade.');
const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0];
response = await fetch(`${base}/v1/search`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'MAGENTA-ORBIT', mode: 'keyword', silos: [saved.siloId] }),
});
const search = await response.json();
if (!response.ok || !search.items?.some((item) => Number(item.documentId) === Number(saved.documentId))) {
  throw new Error('Revision 26 search index did not survive upgrade.');
}
response = await fetch(`${base}/v1/research`, { headers: { cookie } });
const research = await response.json();
if (!response.ok || !research.items?.some((item) => Number(item.id) === Number(saved.researchId))) {
  throw new Error('Revision 26 Research collection did not survive upgrade.');
}
response = await fetch(`${base}/v1/admin/chat/providers`, { headers: { cookie } });
const providers = await response.json();
const cloud = providers.providers?.find((provider) => provider.provider === 'ollama_cloud');
if (!response.ok || cloud?.serviceRoot !== 'https://ollama.com') {
  throw new Error('Revision 32 did not expose the fixed Ollama Cloud provider.');
}
NODE

/work/new-outer/scripts/start-stop-status stop
echo 'Revision 26 to revision 46 forward-upgrade simulation passed.'

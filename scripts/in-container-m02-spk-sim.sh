#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" == "1000" ]]
[[ "$(id -g)" == "1000" ]]

mkdir -p /work/outer /work/package /work/var /work/watch-base/watch
printf '# Watched package source\n\nThe cerulean actuator ledger survives source indexing and restart.\n' \
  >/work/watch-base/watch/source.md
report_failure() {
  status="$?"
  if [[ "${status}" -ne 0 ]]; then
    for log_file in /work/var/log/*.log; do
      [[ -f "${log_file}" ]] && { echo "Failure log: ${log_file}" >&2; tail -n 80 "${log_file}" >&2; }
    done
  fi
}
trap report_failure EXIT
: "${NODERAG_SPK_INPUT:?NODERAG_SPK_INPUT is required}"
tar -xf "${NODERAG_SPK_INPUT}" -C /work/outer
tar -xzf /work/outer/package.tgz -C /work/package
export SYNOPKG_PKGDEST=/work/package
export SYNOPKG_PKGVAR=/work/var
export NODERAG_NODE_BIN
NODERAG_NODE_BIN="$(command -v node)"
export NODERAG_PORT=8787
: "${NODERAG_PACKAGE_DB_HOST:?NODERAG_PACKAGE_DB_HOST is required}"
: "${NODERAG_PACKAGE_DB_PASSWORD:?NODERAG_PACKAGE_DB_PASSWORD is required}"
printf '%s\n' "${NODERAG_PACKAGE_DB_PASSWORD}" >/work/postgres_password
chmod 600 /work/postgres_password
export NODERAG_POSTGRES_HOST="${NODERAG_PACKAGE_DB_HOST}"
export NODERAG_POSTGRES_PORT=5432
export NODERAG_POSTGRES_DATABASE=noderag_package
export NODERAG_POSTGRES_USER=noderag
export NODERAG_POSTGRES_PASSWORD_FILE=/work/postgres_password

/work/outer/scripts/postinst
[[ "$(stat -c '%a' /work/var)" == "700" ]]
[[ "$(stat -c '%a' /work/var/secrets/root.key)" == "600" ]]
[[ "$(wc -c </work/var/secrets/root.key)" == "32" ]]
secret_root_sha="$(sha256sum /work/var/secrets/root.key | awk '{print $1}')"
/work/outer/scripts/postinst
[[ "$(sha256sum /work/var/secrets/root.key | awk '{print $1}')" == "${secret_root_sha}" ]]
printf 'retain-me\n' >/work/var/data/operator-state

health_check() {
  node - <<'NODE'
const response = await fetch('http://127.0.0.1:8787/health');
const body = await response.json();
if (!response.ok || body.status !== 'ok' || body.service !== 'noderag') process.exit(1);
NODE
}

/work/outer/scripts/start-stop-status start
health_check
/work/outer/scripts/start-stop-status status

node - <<'NODE'
const fs = await import('node:fs');
const base = 'http://127.0.0.1:8787';
const setupToken = fs.readFileSync('/work/var/secrets/setup.token', 'utf8').trim();
let response = await fetch(`${base}/v1/setup/configure`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    setupToken,
    username: 'package-admin',
    password: 'M05-package-test-only!',
  }),
});
if (response.status !== 201) throw new Error(`Setup failed: ${response.status} ${await response.text()}`);
const configured = await response.json();
if (fs.existsSync('/work/var/secrets/setup.token')) throw new Error('Consumed setup token was not removed.');
response = await fetch(`${base}/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'package-admin', password: 'M05-package-test-only!' }),
});
if (!response.ok) throw new Error(`Login failed: ${response.status}`);
const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0];
const login = await response.json();
const original = '\uFEFF# Package search\r\n\r\nThe amber gearbox ledger records quarterly maintenance costs.\r\n';
const form = new FormData();
form.append('file', new Blob([original], { type: 'text/markdown' }), 'package.md');
response = await fetch(`${base}/v1/documents?siloId=${configured.defaultSilo.id}`, {
  method: 'POST',
  headers: {
    cookie,
    origin: base,
    'x-csrf-token': login.csrfToken,
    'idempotency-key': 'm04-package-upload-001',
  },
  body: form,
});
if (response.status !== 202) throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
const upload = await response.json();
let search;
for (let attempt = 0; attempt < 80; attempt += 1) {
  response = await fetch(`${base}/v1/search`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'amber gearbox costs', siloIds: [configured.defaultSilo.id] }),
  });
  if (!response.ok) throw new Error(`Search failed: ${response.status} ${await response.text()}`);
  search = await response.json();
  if (search.items.length > 0) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!search || search.items.length === 0) throw new Error('Packaged worker did not produce a search result.');
const hit = search.items[0];
if (!hit.text.includes('amber gearbox ledger')) throw new Error('Packaged search returned the wrong passage.');
const bucket = String(Math.floor(upload.documentId / 1000)).padStart(6, '0');
const canonicalPath = `/work/var/data/documents/${bucket}/${upload.documentId}/canonical.md`;
const canonical = fs.readFileSync(canonicalPath, 'utf8');
if (canonical.includes('\r') || !canonical.startsWith('# Package search\n\n')) {
  throw new Error('Packaged canonical Markdown was not normalized.');
}
if (canonical.slice(hit.locator.characterStart, hit.locator.characterEnd) !== hit.text) {
  throw new Error('Packaged UTF-16 locator did not reproduce the passage.');
}
const bytes = Buffer.from(canonical, 'utf8').subarray(hit.locator.byteStart, hit.locator.byteEnd).toString('utf8');
if (bytes !== hit.text) throw new Error('Packaged UTF-8 locator did not reproduce the passage.');

const formatFixtures = [
  {
    path: '/fixtures/txt/sample.txt',
    name: 'package-sample.txt',
    type: 'text/plain',
    expected: 'inspection schedules',
  },
  {
    path: '/fixtures/pdf/two-column.pdf',
    name: 'package-two-column.pdf',
    type: 'application/pdf',
    expected: null,
  },
  {
    path: '/fixtures/docx/word-saved.docx',
    name: 'package-word-saved.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    expected: 'Rendered pagination fixture',
  },
  {
    path: '/fixtures/xlsx/messy-workbook.xlsx',
    name: 'package-messy-workbook.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    expected: 'Maintenance cost register',
  },
  {
    path: '/fixtures/pdf/scanned.pdf',
    name: 'package-scanned.pdf',
    type: 'application/pdf',
    expected: '',
  },
];
for (const [index, fixture] of formatFixtures.entries()) {
  const formatForm = new FormData();
  formatForm.append('file', new Blob([fs.readFileSync(fixture.path)], { type: fixture.type }), fixture.name);
  response = await fetch(`${base}/v1/documents?siloId=${configured.defaultSilo.id}`, {
    method: 'POST',
    headers: {
      cookie,
      origin: base,
      'x-csrf-token': login.csrfToken,
      'idempotency-key': `m06-package-format-${String(index)}`,
    },
    body: formatForm,
  });
  if (response.status !== 202) {
    throw new Error(`Format upload failed for ${fixture.name}: ${response.status} ${await response.text()}`);
  }
  const acceptedFormat = await response.json();
  const formatBucket = String(Math.floor(acceptedFormat.documentId / 1000)).padStart(6, '0');
  const formatCanonical = `/work/var/data/documents/${formatBucket}/${acceptedFormat.documentId}/canonical.md`;
  let extracted = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (fs.existsSync(formatCanonical)) {
      extracted = fs.readFileSync(formatCanonical, 'utf8');
      if (fixture.expected === '' || extracted.length > 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (extracted === null) throw new Error(`Packaged extractor did not write ${fixture.name}.`);
  if (fixture.expected === null && extracted.length === 0) {
    throw new Error(`Packaged extractor produced empty Markdown for ${fixture.name}.`);
  }
  if (fixture.expected && !extracted.includes(fixture.expected)) {
    throw new Error(`Packaged extractor output was wrong for ${fixture.name}.`);
  }
  if (fixture.expected === '' && extracted !== '') {
    throw new Error('Scanned PDF was indexed as text instead of waiting for vision.');
  }
}
response = await fetch(`${base}/v1/sources`, {
  method: 'POST',
  headers: {
    cookie,
    origin: base,
    'x-csrf-token': login.csrfToken,
    'idempotency-key': 'm05-package-source-001',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    siloId: configured.defaultSilo.id,
    uri: '/work/watch-base/watch',
    includeGlobs: ['**/*.md'],
  }),
});
if (response.status !== 201) throw new Error(`Source create failed: ${response.status} ${await response.text()}`);
const source = await response.json();
response = await fetch(`${base}/v1/sources/${source.id}/crawl`, {
  method: 'POST',
  headers: {
    cookie,
    origin: base,
    'x-csrf-token': login.csrfToken,
    'idempotency-key': 'm05-package-crawl-001',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ siloId: configured.defaultSilo.id }),
});
if (response.status !== 202) throw new Error(`Source crawl failed: ${response.status} ${await response.text()}`);
let watchedSearch;
for (let attempt = 0; attempt < 80; attempt += 1) {
  response = await fetch(`${base}/v1/search`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'cerulean actuator ledger', siloIds: [configured.defaultSilo.id] }),
  });
  watchedSearch = await response.json();
  if (response.ok && watchedSearch.items.some((item) => item.text.includes('cerulean actuator'))) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!watchedSearch?.items.some((item) => item.text.includes('cerulean actuator'))) {
  throw new Error('Packaged watched source was not indexed.');
}
response = await fetch(`${base}/v1/jobs/stream?once=true`, {
  headers: { cookie },
});
if (!response.ok || !(await response.text()).includes('event: succeeded')) {
  throw new Error('Packaged SSE event replay did not expose durable completion.');
}
response = await fetch(`${base}/v1/documents/${upload.documentId}`, {
  method: 'DELETE',
  headers: {
    cookie,
    origin: base,
    'x-csrf-token': login.csrfToken,
    'idempotency-key': 'm05-package-purge-001',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ siloId: configured.defaultSilo.id, confirmDocumentId: upload.documentId }),
});
if (response.status !== 202) throw new Error(`Document purge failed: ${response.status} ${await response.text()}`);
if (fs.existsSync(`/work/var/data/documents/${bucket}/${upload.documentId}`)) {
  throw new Error('Document purge retained the managed directory.');
}
fs.writeFileSync('/work/package-search.json', JSON.stringify({
  cookie,
  siloId: configured.defaultSilo.id,
  query: 'cerulean actuator ledger',
}));
NODE

/work/outer/scripts/start-stop-status restart
health_check
node - <<'NODE'
const fs = await import('node:fs');
const saved = JSON.parse(fs.readFileSync('/work/package-search.json', 'utf8'));
const response = await fetch('http://127.0.0.1:8787/v1/search', {
  method: 'POST',
  headers: { cookie: saved.cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ query: saved.query, siloIds: [saved.siloId] }),
});
const body = await response.json();
if (!response.ok || body.items.length === 0) throw new Error('Search did not survive packaged restart.');
NODE
/work/outer/scripts/start-stop-status stop
! /work/outer/scripts/start-stop-status status

# Reboot simulation: package data survives while the service is stopped and restarted.
/work/outer/scripts/start-stop-status start
health_check
[[ "$(cat /work/var/data/operator-state)" == "retain-me" ]]
/work/outer/scripts/preuninst
/work/outer/scripts/postuninst
[[ "$(cat /work/var/data/operator-state)" == "retain-me" ]]

# Destructive uninstall is separate, explicit, and constrained to the package data path.
NODERAG_DELETE_DATA=yes /work/outer/scripts/postuninst
[[ ! -e /work/var ]]
echo "Non-root thin-SPK lifecycle simulation passed."

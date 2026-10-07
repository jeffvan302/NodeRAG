# Secrets Policy

Never commit provider credentials, Supabase service/database credentials,
administrator or application passwords, API keys, backup passwords, production
backups, customer documents, extracted private text, or generated private
vectors.

## Runtime ownership

Railway contains only two secret roots:

- `ADMIN_SESSION_SECRET`
- `ADMIN_SETUP_TOKEN`

Three additional bootstrap variables are not secrets:

- `ADMIN_AUTH_ENABLED`
- `ADMIN_SETUP_ENABLED`
- `SETTINGS_SERVICE_URL`

The Boolean access gates live in Railway shared variables, never in the local
settings vault, so an operator can re-enable login or recovery without first
accessing that vault. Missing values fail closed; only an explicit `true`
enables the corresponding entry point.
Private service credentials are domain-separated hashes derived from the
session root; they are not separate operator-managed variables.

The private settings service encrypts every logical record with AES-256-GCM.
Collection and record indexes are keyed opaque hashes, so SQLite does not expose
plaintext setting names, user identities, API keys, or values at rest.

Treat `ADMIN_SESSION_SECRET` as the installation's persistent root key. Before
changing it, export and verify a password-encrypted settings backup; the live
SQLite records cannot be decrypted after the root changes. The portable backup
can be restored into an installation that uses a different root key.

The vault owns:

- Supabase connections and management credentials;
- provider endpoints and provider secrets;
- runtime, RAG, model, task, RunPod, storage, and context settings;
- named provider access-point keys and capacity settings;
- administrator and application-login records; and
- application API keys.

Browser responses may report whether a credential exists and may show a short
non-reversible fingerprint or key preview, but never return stored provider or
connection secrets.

## Backup policy

Settings exports are always encrypted with a required, user-supplied password
of at least 12 characters. Export and restore are manual administrator actions;
they are not included in scheduled Supabase data backups. The portable archive
is decrypted and then re-encrypted under the destination installation key during
restore.

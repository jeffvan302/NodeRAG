# Supabase Database Connection Discovery

This note describes how an application or installer can determine the PostgreSQL connection details for a Supabase project when it already has:

- The Supabase project URL
- The database password
- A Supabase Personal Access Token (PAT), if Management API access is needed

## 1. Derive the Project Reference

A Supabase project URL normally looks like:

```text
https://abcdefghijklmnopqrst.supabase.co
```

The project reference is the first part of the hostname:

```text
abcdefghijklmnopqrst
```

## 2. Derive the Direct Database Hostname

The direct PostgreSQL hostname can be constructed from the project reference:

```text
db.<project-ref>.supabase.co
```

Example:

```text
db.abcdefghijklmnopqrst.supabase.co
```

A direct PostgreSQL connection string is therefore typically:

```text
postgresql://postgres:<DATABASE_PASSWORD>@db.<project-ref>.supabase.co:5432/postgres
```

This means the direct database hostname can usually be derived from the Supabase URL without calling an API.

## 3. Use the Supabase Management API

If the application has a Supabase **Personal Access Token**, it can query the Supabase Management API for the project's database configuration.

The project reference can first be extracted from the Supabase URL, then used with the Management API.

Authentication uses:

```http
Authorization: Bearer <SUPABASE_PERSONAL_ACCESS_TOKEN>
```

The Management API can provide database and pooler information such as:

- Database host
- Database port
- Database name
- Database user
- Pooler connection information

The current implementation uses the documented endpoint:

```text
GET /v1/projects/<project-ref>/config/database/pooler
```

The token needs `database_pooling_config_read` (or the equivalent
`database:read` OAuth scope).

This is useful when an installer needs the actual Supavisor connection details instead of deriving only the direct database hostname.

## 4. Direct vs. Pooler Connections

Supabase normally provides several PostgreSQL connection options:

### Direct connection

```text
Host: db.<project-ref>.supabase.co
Port: 5432
User: postgres
```

This is appropriate when the deployment environment can connect directly to the Supabase database.

### Session pooler

A Supavisor session pooler normally uses a hostname similar to:

```text
aws-<region>.pooler.supabase.com
```

with:

```text
Port: 5432
User: postgres.<project-ref>
```

This is often preferable for applications running in environments where direct IPv6 connectivity may be unavailable.

### Transaction pooler

The transaction pooler normally uses the same pooler host but port:

```text
6543
```

It is generally intended for short-lived or serverless database connections.

## 5. Suggested Installer Inputs

For an automated Railway/Supabase deployment, the installer can ask the user for:

```text
SUPABASE_URL
SUPABASE_DB_PASSWORD
SUPABASE_MANAGEMENT_TOKEN
```

> The token is named `SUPABASE_MANAGEMENT_TOKEN` rather than
> `SUPABASE_ACCESS_TOKEN` in this platform. That name is already taken by the
> GitHub Actions deployment secret, and the platform contract requires each
> variable name to have one owner. They are the same kind of credential with
> different custodians, and keeping them separate means either can be rotated,
> or leak, without implicating the other.
>
> The database password is an input and cannot be discovered. PostgreSQL stores
> role passwords as SCRAM-SHA-256 hashes, so Supabase holds no plaintext copy to
> return. The Management API can _reset_ it, but a silent reset would break
> everything else already using it.

The installer can then:

1. Extract the project reference from `SUPABASE_URL`.
2. Derive the direct database hostname.
3. Call the Supabase Management API using the Personal Access Token.
4. Retrieve the pooler/database connection information.
5. Retrieve a server-side project API key from
   `GET /v1/projects/<project-ref>/api-keys?reveal=true`. The token needs
   `api_gateway_keys_read` (or the equivalent `secrets:read` OAuth scope).
6. Prefer a modern `sb_secret_` key and fall back to a legacy `service_role`
   key when necessary.
7. Construct and prove the PostgreSQL Session Pooler connection.
8. Derive `https://<project-ref>.supabase.co/rest/v1` and save the linked,
   inactive PostgreSQL/PostgREST target in encrypted Settings.

The Personal Access Token is a discovery credential, not a runtime data-plane
credential. The Configuration workflow discards it after discovery succeeds.
The derived PostgreSQL connection and selected server-side project API key are
the only credentials retained for the inactive target.

## Important: API Key vs. Personal Access Token

A Supabase project API key such as:

```text
anon
service_role
publishable
secret
```

is not the same as a Supabase Personal Access Token.

Project API keys authenticate against the project's APIs.

A Personal Access Token is associated with the Supabase account and can be used with the Supabase Management API.

## Example Flow

```text
Supabase URL
     |
     v
Extract project reference
     |
     +--> Derive direct DB hostname
     |
     +--> Supabase Management API
              |
              v
        Retrieve database /
        Supavisor pooler details
        and server API key
              |
              v
        Build PostgreSQL
        connection string
              |
              v
        Configure Railway
```

This allows most of the Supabase database configuration to be automated so the user does not need to manually copy database hostnames and connection details from the Supabase dashboard.

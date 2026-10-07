# REST API Documentation

The external contract consists only of routes below `/api/v1`. Private
Railway admin routes below `/api/...` and model tools such as `rag_documents`,
`rag_search`, or `write_file` are implementation details and are not public
REST operations.

## API Base

```text
https://web-production-3bf65.up.railway.app/api/v1
```

Every protected request sends:

```http
Authorization: Bearer brk_your_api_key_here
```

Every state-changing route documented as idempotent also sends a new stable
key for that logical operation:

```http
Idempotency-Key: client-generated-unique-value
```

## References

- [Pure REST API command reference](rest-api-command-reference.md) is the
  external-client edition used to generate the standalone API PDF.
- [Canonical API usage guide](../api-usage.md) is checked against all public
  route handlers by `pnpm docs:check`.
- [Bubble API installation](../bubble-api-installation.md) explains how to
  configure the same REST calls in Bubble's API Connector.
- [Bubble delivery guide](../bubble-integration-delivery-guide.md) covers
  reusable Bubble workflows, data types, privacy, polling, and acceptance
  tests.

## Maintenance Rule

Change `docs/api-usage.md` first when the REST contract changes. Then run the
PDF builder, which refreshes `rest-api-command-reference.md` from that
canonical source, and run `pnpm docs:check` before committing.

# Bubble Integration Documentation

Use these documents in order:

1. [Bubble API installation](../bubble-api-installation.md) for the production
   URL, private API Connector setup, bearer key, call initialization, and a
   minimum end-to-end test.
2. [Bubble integration delivery guide](../bubble-integration-delivery-guide.md)
   for complete Bubble types, workflows, polling, streaming Ask, Tasks,
   downloads, privacy, and acceptance testing.
3. [REST API command reference](../api/rest-api-command-reference.md) for every
   HTTP method, path, field, response, error, and `curl` example.
4. [Current Bubble API state](../bubble-api-current-state.md) for implementation
   status and remaining delivery context.

The Bubble plugin is named **RAG Railway Connector**. Its production API base
is:

```text
https://web-production-3bf65.up.railway.app/api/v1
```

The private plugin authentication value must include the scheme and space:

```text
Bearer brk_your_api_key_here
```

The standalone Bubble installation PDF intentionally excludes the full REST
command catalog. Distribute it together with the standalone REST API command
reference when a recipient needs both setup and wire-level details.

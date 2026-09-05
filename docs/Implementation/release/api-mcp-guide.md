# REST, MCP, and Gateway Guide — 1.0.0-rc.1

## Contracts and authentication

The frozen REST contract is `platform/openapi.m14.json`. Browser mutations require the session
cookie, same-origin request, CSRF token, and—where declared—an `Idempotency-Key`. API keys use
`Authorization: Bearer ...`; the clear token is returned only when created. Error responses use
RFC 9457 problem details with a bounded code and request ID.

Every content request resolves a server-side silo scope from the principal, required capability,
optional requested silo IDs, and optional gateway. Requested IDs only narrow scope. Do not treat a
client-supplied silo ID as authorization.

## Search

Submit `POST /v1/search` with a query, `vector`, `keyword`, or `hybrid` mode, optional silo
narrowing, filters, limit, and opaque cursor. Results provide passage text, document identity,
heading/page or sheet context where applicable, and character/byte locators. Character offsets are
UTF-16 code units; byte offsets are UTF-8 bytes. Prefer returned text/context rather than slicing.

Search-only credentials cannot download whole originals or canonical Markdown. They can use the
bounded chunk/context routes required for retrieval.

## MCP

MCP is exposed at `POST /mcp` and identifies this candidate as NodeRag `1.0.0-rc.1`. The protocol
supports initialization, ping, tool listing, and scoped tool calls including search, silo listing,
chunk context, and page retrieval according to the credential's grants. MCP and REST must return
the same scoped search result for equivalent requests.

## Gateways

An enabled gateway binds a dedicated loopback listener and restricts requests to its configured
silo set in addition to the principal's grants. Validate the port before enablement. If the bind
fails, inspect `lastBindError`; never replace authentication with a public listener. Use DSM's
approved reverse proxy/TLS arrangement for network exposure after live certification.

## Operational rules

- Retry an idempotent mutation with the same key and identical body; a changed body must conflict.
- Treat pagination cursors as opaque and restart pagination after a cursor error.
- Reconnect job SSE with `Last-Event-ID`; completion is durable in the database.
- Record request IDs for support, but never log credentials, raw queries, uploaded bodies, or
  private filesystem paths.

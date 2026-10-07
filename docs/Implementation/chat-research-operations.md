# C05 Research Attachments and Citations — Operations Guide

**Applies to:** NodeRag Chat migration `000023_chat_research`
**Environment:** WSL/Linux Docker testbed; DSM packaging remains deferred to C11

## What C05 delivers

C05 lets an entitled user attach one or more Research collections while creating a chat. NodeRag
captures a fixed, owner-scoped revision containing at most 500 currently readable references. Page
references are selected before passage-only references when the bound is reached. The snapshot keeps
source identity, hashes, locators, evidence, confidence, and citation labels; it does not duplicate
whole source documents.

The model can use exactly three Research operations:

1. `research.list_sources.v1` lists the attached revision's sources and current availability.
2. `research.read_page.v1` reads the cited canonical Markdown page.
3. `research.read_document.v1` reads one bounded, paged Markdown range.

Broader RAG and internet tools remain absent in C05. For Chat, Ollama always means **Ollama Cloud**.
No local, self-hosted, forwarded, or custom Ollama server is accepted. C07 will provide Chat internet
search and web fetch only through `https://ollama.com/api/web_search` and
`https://ollama.com/api/web_fetch`, including when OpenAI generates the final answer.

## Creating a Research-backed chat

1. Create and populate a personal Research collection from Search or the Research workspace.
2. Open **Chat**, select **New chat**, and choose one or more visible Research collections.
3. Review each collection's visible-reference count. Hidden references are never copied into the
   attachment.
4. Select a healthy response model and create the chat.
5. Confirm the header shows the Research names, revision, snapshot time, and saved-source count.
6. Ask a question. NodeRag supplies bounded, explicitly untrusted excerpts and lets the response
   provider call only the three Research operations above.
7. Open **Sources provided for this answer** to inspect the exact cited PDF page, Markdown page, or
   source passage. The viewer remains tied to the answer's attachment revision.

## Authorization and source integrity

Research collection ownership is checked when the snapshot is created. Current knowledge-space read
permission is checked again before every list, page, document, and original-file read. The model
cannot provide a principal ID or knowledge-space scope.

Each source is compared with its captured reference digest, original-document hash, and canonical
Markdown hash. A removed or changed reference/document becomes `source_stale`; a lost grant becomes
`access_revoked`. Neither state silently substitutes current content. Viewer buttons are disabled for
unavailable citations, and direct API reads fail with the corresponding safe error.

Research text is wrapped and labelled as untrusted source material. Instructions found inside a
document cannot enable a tool, request a credential, activate internet access, or alter NodeRag's
authorization policy.

## Citation and viewer behavior

- citations belong to one assistant message and one immutable attachment revision;
- citation labels are stable within that revision;
- PDF reads use a permission- and hash-checked original-file route before PDF.js opens the cited page;
- Markdown reads use a permission- and hash-checked cited-page route, not a generic document route;
- refreshing Research does not move old answers to the new revision;
- previous/next source navigation stays within the answer's available citations;
- confidence, source passage, evidence highlights, and exact locators remain visible.

## Refreshing Research

Select **Refresh Research** and accept the confirmation only when the chat should see updated
references. Refresh creates a new immutable revision and updates future runs. Existing runs, answers,
tool calls, and citations retain the earlier revision. Refresh never edits an existing snapshot.

## Durable tool-call record

Each call stores its run, order, provider call ID, versioned tool name, validated arguments, status,
result byte count/hash, safe failure code, and timestamps. Full document/tool output is not copied
into the tool-call table. A run enforces the configured maximum tool-call count, rejects duplicate
call IDs, caps one result at 512 KiB, and verifies its active worker lease before accepting a call.

Both production response providers use the same NodeRag executor. Ollama Cloud receives function
definitions at the fixed Cloud chat endpoint. OpenAI app-server receives only matching dynamic
Research tools; its built-in web, shell, local-file, and workspace capabilities remain disabled.

## Backup, restore, and recovery

C05 tables participate in full encrypted backup. Research snapshots, citations, and tool-call
provenance are excluded from portable corpus export. Full restore stages all rows, breaks the nullable
chat/current-revision cycle safely, restores both sides, and lets PostgreSQL revalidate the foreign
key. Provider credentials retain the existing disabled-after-restore policy.

## Troubleshooting

- **Research is not offered:** confirm collection ownership, current knowledge-space grants, Chat
  entitlement, and the C05 rollout flag.
- **Access revoked:** restore the user's read grant only if policy permits, then retry. Do not edit the
  snapshot.
- **Source stale:** inspect the current document/reference, then confirm **Refresh Research** to create
  a new revision.
- **Tool limit reached:** reduce the request scope or have an administrator review the bounded Chat
  setting; do not grant an unrestricted tool.
- **PDF/Markdown cannot open:** verify the source still reports active and that the managed original
  and canonical Markdown hashes match their database records.
- **Internet unavailable:** expected in C05. Internet is introduced only in C07 through Ollama Cloud.

## Deferred behavior

- C06: current-permission-scoped wider RAG search and Markdown reads.
- C07: explicit, cited Ollama Cloud internet search and web fetch.
- C08–C10: Chat files, exports, ingest, managed context, and archive/reconciliation.
- C11: complete Docker release gate, DSM package integration, live Synology acceptance, and immutable
  SPK.

# C08 Chat Artifacts and Markdown — Operations Guide

**Applies to:** NodeRag Chat migration `000026_chat_artifacts`
**Environment:** WSL/Linux Docker testbed; Synology DSM execution remains deferred to C11
**Provider boundary:** Chat Ollama means Ollama Cloud only

## What C08 adds

C08 gives every chat owner a contained Markdown workspace. A user or the response model can create,
read, organize, and revise Markdown files without receiving a shell, an unrestricted filesystem
handle, or access to another chat. Every file revision is immutable and content-addressed. The
current working copy can change only through an exact SHA-256 line patch or another explicit,
authorized operation.

This stage does not alter the Chat network boundary. Ollama generation is direct Ollama Cloud at
`POST https://ollama.com/api/chat`. Chat internet search and page retrieval continue to use only
Ollama Cloud at `POST https://ollama.com/api/web_search` and
`POST https://ollama.com/api/web_fetch`, including when OpenAI generates the answer. Local,
self-hosted, forwarded, and custom Ollama endpoints are not Chat options.

## Opening the artifact workspace

1. Sign in with an account that has Chat access.
2. Open **Chat** and select a conversation you own.
3. Select **Artifacts** in the conversation header.
4. Review the quota strip before creating a large file. It shows used storage, the per-chat quota,
   current file count, and the maximum size for one Markdown file.
5. Select a folder or file. Use the breadcrumb at the top to return to a parent folder.

Keyboard navigation in the file list is:

- **Up/Down Arrow:** move focus between entries;
- **Right Arrow:** open the focused file or folder;
- **Left Arrow:** return to the parent folder.

## Creating and organizing content

- Select **New Markdown**, enter a `.md` or `.markdown` filename, add starting content, and create it.
- Select **New folder** to create a contained folder. Parent folders must already exist.
- Open a file and use **Copy file** to create an independent revisioned copy at a new path.
- Use **Rename** to rename or move the file to another existing folder.
- Use **Download** to receive the selected current revision as `text/markdown`.
- Use **Delete** only after reading and accepting the confirmation. Delete is intentionally not a
  model tool.

Paths are relative to the current chat. Absolute paths, `..`, backslashes, drive names, hidden
segments, NTFS alternate streams, control characters, reserved device names, trailing spaces/dots,
Unicode/case aliases, symbolic links, and junction escapes are rejected.

## Editing and revision history

1. Open a Markdown file.
2. Review the rendered preview and edit the source in **Edit Markdown**.
3. Select **Save new revision**. NodeRag sends the previous SHA-256 and the exact lines expected at
   the changed range.
4. If someone or a model changed the file first, NodeRag returns a conflict and preserves both the
   current file and the submitted draft. Reload before retrying.
5. Expand **Revision history** to see creation time, author kind, byte size, and retained source
   labels.
6. Select **Compare with current** on an older revision for a side-by-side source comparison.

The immutable revision includes the creating principal and, for model changes, the exact response
message, run, tool call, and verified R/S/W source labels. A claimed source label must exist in the
same chat response; fabricated or cross-chat provenance is rejected.

## Markdown safety and presentation

The common reader supports GitHub-style tables, task lists, headings, lists, quotes, code blocks,
strict Mermaid diagrams, entity-relationship diagrams, and LaTeX/KaTeX expressions. It exposes both
Preview and Markdown source views.

Raw HTML is displayed as text and then sanitized. Scripts, forms, frames, embedded objects, inline
styles, unsafe links, and browser-storage access are unavailable. Mermaid uses strict mode and its
generated SVG is sanitized again. KaTeX runs with trust disabled. External images are blocked by
default. If an administrator enables the policy, the reader still requires a deliberate user
action before loading a remote image and sends no referrer.

## Chat-owned website files

The artifact drawer also has a **Chat files** section for images that need a stable website address.
Select **Upload image** and choose a PNG, JPEG, GIF, or WebP file. NodeRag validates the extension,
reported media type, and binary signature, then assigns a new UUID. The original filename is only a
display label; it never controls the stored path. Two chats, or two uploads in one chat, can therefore
use the same original filename without a collision.

The canonical address is:

```text
https://<NodeRag host>/noderag/chat/<chat-id>/file/<file-id>.<extension>
```

The `/noderag/` prefix is retained automatically when NodeRag is reached through the DSM Web Station
alias. Use **Copy URL** for HTML or **Copy Markdown** for a ready-made `![label](URL)` image reference.
The rich Markdown reader recognizes this same-origin route as a managed image and loads it without
enabling external images.

These are private website links, not public shares. The requester must be signed in, have Chat access,
and own the chat named in the URL. A wrong chat ID, file ID, or extension returns Not Found. Responses
are served inline with private/no-cache policy, an integrity-derived ETag, MIME sniffing disabled, and
same-origin embedding. Deleting a Chat file requires confirmation and invalidates its URL. Public
sharing, if added later, must use a separate expiring signed-link design rather than weakening this
owner-only route.

Image bytes share the existing per-chat artifact quota and maximum-file setting. Full backups include
the `chat_file` records and the chat-owned `files/` directory; portable exports exclude them.

## Model file tools

The model can receive only these tools when the artifact feature is enabled:

- `files.list.v1`
- `files.read.v1`
- `files.create.v1`
- `files.mkdir.v1`
- `files.rename.v1`
- `files.copy.v1`
- `files.patch.v1`

The model never receives shell, command, delete, arbitrary-path, arbitrary-URL, or unrestricted
file APIs. Tool availability is independent of Research, broader RAG, and Ollama Cloud internet
access. File content and tool output are marked as untrusted data.

## Administration settings

Open **Administration → Chat settings** to configure:

- maximum artifact file size, from 1 to 100 MiB;
- per-chat artifact quota, from the maximum file size up to 10 GiB;
- whether users may deliberately load external images found in Chat Markdown;
- active log segment maximum size, from 1 to 64 MiB;
- active log segment maximum age, from 5 minutes to 7 days.

Saving any context or Chat setting creates a new immutable configuration revision while preserving
these values. Existing chats retain the revision they were created with.

## Logs, reconciliation, backup, and recovery

The append-only conversation event file remains hash-chained to the database events. C08 also
records an active-segment SHA-256, byte count, event count, first/last event cursor, and contained
relative path. A partial final line is removed during synchronization only when it is recognizable
as an interrupted append; an earlier corruption fails closed. Older messages continue to load from
database cursors through **View older logs**. Archive rotation and compression are completed in C10.

`GET /v1/chats/{chatId}/artifacts-reconciliation` is a read-only existing-folder inventory. It
reports untracked, missing, changed, and unsafe paths and always reports zero applied mutations.
Automatic importing or repair is intentionally deferred to C10.

Full encrypted backups include artifact metadata, immutable revisions, and `.noderag-chat` content.
Portable exports exclude them. Log-segment rows are derived and excluded. Uninstall/upgrade policy
retains the external Chat root unless the administrator performs a separately confirmed removal.

## Safe error guidance

- `chat_artifact_path_invalid`: use a relative portable path and a Markdown extension for files.
- `chat_artifact_parent_missing`: create the parent folder first.
- `chat_artifact_path_conflict`: choose a path that does not already exist, including case aliases.
- `chat_artifact_patch_conflict`: reload; another revision won the optimistic edit.
- `chat_artifact_file_too_large`: reduce the file below the configured single-file limit.
- `chat_artifact_quota_exceeded`: delete unneeded working files or increase the per-chat quota.
- `chat_artifact_disk_full`: free storage or select a larger verified Chat volume.
- `chat_artifact_storage_unsafe`: remove the unsafe link/path and run the read-only inventory again.
- `chat_artifact_provenance_invalid`: retry through the current chat run; the claimed run/source
  relationship was not valid.
- `chat_file_type_unsupported`: upload PNG, JPEG, GIF, or WebP; active formats such as SVG are not
  accepted.
- `chat_file_signature_invalid`: the file extension/media type does not match its binary content.
- `chat_file_quota_exceeded`: remove an unneeded Chat file or increase the shared per-chat quota.
- `chat_file_not_found`: the URL is stale, has the wrong extension, or belongs to another chat.

No safe error contains a storage path outside the managed root, provider credential, prompt body, or
raw filesystem exception.

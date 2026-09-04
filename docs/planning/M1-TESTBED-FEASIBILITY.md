# Milestone 1 — Docker Testbed Feasibility Record

Status: `testbed-complete`
Recorded: 2026-09-04
Evidence environment: WSL 2 and Docker Desktop, not DSM
Certification ceiling: `testbed-complete`

## 1. Purpose and decision summary

Milestone 1 tests the assumptions most likely to invalidate the NodeRag design
before product services are created. The current results support continuing with
Node 22, PostgreSQL 17, pgvector `halfvec(1024)`, and the pinned q8 Qwen model as
the provisional default. No result in this document proves Synology runtime,
package identity, ACL, volume, lifecycle, performance, or thermal behavior.

| Decision | Testbed result | Provisional consequence |
|---|---|---|
| Node runtime | Node 22.22.0 loads all feasibility dependencies on Linux amd64. | Continue with Node 22; repeat with the installed Synology `Node.js_v22` runtime during final DSM certification. |
| Embeddings | Pinned q8 Qwen runs in `onnxruntime-node`, returns 1,024 finite values, L2 norm 1, and byte-for-byte repeatable floats for the repeated input. | Keep q8 as the default candidate; retain q4f16/fp16 only as benchmark alternatives. |
| Memory | One 1,024-token session plus a second short-query session peaked at 2,016,759,808 cgroup bytes under an enforced 8 GiB limit. | The two-session design is feasible on this testbed; NAS memory remains release-blocking. |
| Database | PostgreSQL 17.11, pgvector 0.8.6, and a real `halfvec(1024)` self-distance query pass. | Continue with the planned database/vector contract. |
| Password hashing | Argon2id at 64 MiB, time cost 2, parallelism 1 measured 113.99 ms and passed correct/wrong password checks. | Use this only as the initial development constant; recalibrate on the NAS. |
| Storage | Windows bind mount is 9p/DrvFS; Docker named volume is ext4 and retained mode 0700 with fsync/read verification. | Use named volumes for Linux build/test state and never treat DrvFS permission results as DSM evidence. |
| Formats | Eight synthetic files cover TXT, Markdown, text/raster PDF, two DOCX shapes, XLSX, and a table image. Required extraction/disposition checks pass. | Use this small corpus for feasibility only; grow the golden corpus in later milestones. |
| Ollama | Host route is reachable at `host.docker.internal:11434`, unauthenticated on this workstation, with no installed models. | Vision is honestly unavailable and nonblocking; keep content LAN-only and rerun when an approved model exists. |
| DSM packaging | Privilege/resource/port/web/lifecycle contracts and a non-root simulator pass. | Use contracts to build the thin SPK in M2; all real package behavior stays in the deferred register. |

## 2. Exact environment inventory

### Host and WSL

| Item | Captured value |
|---|---|
| Host OS | Microsoft Windows 11 Pro 10.0.26200 build 26200 |
| Host CPU | AMD Ryzen 9 5900X |
| Physical/logical cores | 12 / 24 |
| Host RAM | 63.93 GiB |
| WSL distribution | Ubuntu 24.04.4 LTS (`Ubuntu-24.04`) |
| WSL kernel | `6.6.87.2-microsoft-standard-WSL2` |
| WSL/container architecture | x86_64 / linux-amd64 |
| Docker transport from WSL | Windows CLI interop to Docker Desktop's Linux engine |
| Docker engine allocation | 24 logical CPUs; 33,613,312,000 bytes visible RAM |
| CPU features relevant to model choice | AVX2 present; AVX-512 absent |
| Workspace drive capacity | 2,000,381,014,016 bytes total; 746,543,927,296 bytes free at capture |

### Images and resource limits

| Image | Immutable identity | Size | Use |
|---|---|---:|---|
| Node base | `node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94` | 79,440,658 bytes | Node 22.22.0 Debian Bookworm compatibility base |
| M01 Node image | locally built image ID `sha256:d61f10008bf0a0cda42ff99e4a80d1f617b369a99f0de09a91b6f20c8cdae9cf` at capture | 461,959,298 bytes | Non-root feasibility runner |
| PostgreSQL/pgvector | `pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f` | 157,781,872 bytes | PostgreSQL 17.11 and pgvector 0.8.6 |
| spksrc builder | `ghcr.io/synocommunity/spksrc@sha256:31b66390e2357d5ab0be8c2e521dbc658a44afdfd50eb2e10346e5539f4e9811` | 537,777,796 bytes | x64 DSM 7.2 cross-build environment |

The `m01-node` service is capped at 12 CPUs and 8 GiB, runs as UID/GID 1000,
has a read-only root filesystem, drops every Linux capability, enables
`no-new-privileges`, and receives only a restricted temporary filesystem and
the declared read-only model/fixture mounts plus one named storage volume.

## 3. Filesystem and storage inventory

The checkout is `D:\Dev\NodeRag`, visible to WSL and containers through a 9p
DrvFS mount. WSL reports the fixture directory as mode 0777 because DrvFS does
not preserve the intended Linux modes. The storage probe classifies the fixture
bind mount as 9p and the `m01-storage` named volume as ext4. In the named volume,
the probe created an approved root as UID/GID 1000, applied and re-read mode
0700, wrote data, fsynced it, read it back, and removed it. Requests for `/`,
`/etc`, and `/workspace` were rejected as `outside-approved-storage-roots`.

These results justify using Docker named volumes for Linux-sensitive test state.
They say nothing about DSM `/volumeN`, btrfs/ext4 options, Synology ACLs,
encrypted shares, or package data-share acquisition; those are DSM-009 and
DSM-010 in the deferred register.

## 4. Corpus and ingest inputs

### Synthetic feasibility corpus

The committed corpus contains 8 files totaling 225,515 bytes. It is entirely
synthetic, non-private, English-language test data. It is immutable test input,
so expected daily change volume is zero.

| Format class | Count | Largest file | Largest bytes | Expected result |
|---|---:|---|---:|---|
| TXT | 1 | `txt/sample.txt` | 242 | usable UTF-8 text |
| Markdown | 1 | `md/sample.md` | 296 | usable Markdown and table text |
| PDF | 2 | `pdf/scanned.pdf` | 77,414 | text-layer reading order or honest `vision-required` |
| DOCX | 2 | `docx/gdocs-export-synthetic.docx` | 37,709 | usable text/table; page basis recorded |
| XLSX | 1 | `xlsx/messy-workbook.xlsx` | 5,438 | two regions and cached formula result |
| PNG | 1 | `images/table.png` | 64,658 | optional structured vision input |

`fixtures/formats/fixture-catalog.json` records every path, size, SHA-256,
provenance, and expected disposition. Its SHA-256 at capture is
`49b2a9f9305ec78f8a94d954282b5d1f5432530a7a73ef5c9ccb42b43e5eeb7b`.

### Operator inputs not yet available

- No approved production-like corpus has been supplied, so production document
  count, total bytes, format/language mix, largest files, and daily change
  volume remain unknown.
- The Google-style DOCX is explicitly synthetic. One approved real Google Docs
  export remains required before the final extraction golden set is frozen.
- Overnight indexing acceptability and the preferred global ingest window have
  not been confirmed. No schedule is assumed; M5 must collect this decision
  before enabling unattended watched-folder ingestion.

## 5. Ollama route and content boundary

The workstation exposes Ollama at `127.0.0.1:11434`; the container reaches it
through `http://host.docker.internal:11434`. The tags request completed in
45.49 ms during the recorded probe. No bearer token is configured, requested
parallelism is 1, no models are installed, and
`NODERAG_M01_CONTENT_MAY_LEAVE_LAN=false`. Therefore the table-image case is
`unavailable-no-vision-model`, `applicable: false`, and nonblocking under the M1
acceptance matrix. A future live invocation must use an operator-approved model
and must not cross the LAN boundary without explicit approval.

## 6. Pinned build, runtime, and model contracts

### spksrc

`docker-testbed/m01/spksrc-pin.json` pins SynoCommunity spksrc commit
`1f638f9f331d881b2fd5cb45bb24071e9f723400`, the immutable builder image, and
canonical Git-blob SHA-256 values for these recipes:

| Recipe | Version | Source SHA-256 | Role |
|---|---:|---|---|
| `cross/postgresql` | 17.11 | `dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979` | Production PostgreSQL cross-build |
| `cross/pgvector` | 0.8.6 | `10bf9938906e5d643bbc4a7eea104b6f57ba4898e5b76b20e60484ea1d5a7f8f` | Production extension cross-build |
| `native/nodejs_22` | 22.23.2 | `d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307` | spksrc build dependency only |

The final SPK is expected to declare `Node.js_v22`; the spksrc native Node
recipe does not prove the version or ABI installed by Package Center. DSM-002
retains that release-blocking check.

### Qwen and ONNX

The model manifest pins `Qwen/Qwen3-Embedding-0.6B` revision
`bd58e9fd4b0467770da53678d8da25481c0f959b`, Apache-2.0, last-token pooling,
L2 normalization, 1,024 dimensions, an empty document prefix, and the official
retrieval query prefix. Required artifacts are:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `onnx/model_quint8_avx2.onnx` | 600,127,788 | `a7eda29cc374b01ae75eb1af1ab65c3c61a64c43f39f16e08c6e37c075dcbf4d` |
| `tokenizer.json` | 11,423,705 | `def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a` |
| `tokenizer_config.json` | 9,706 | `253153d0738ceb4c668d2eff957714dd2bea0b56de772a9fdccd96cbf517e6a0` |
| `config.json` | 727 | `b5bf1f51fc45be473a54718cef92448d90a1be001bf9b9a44b8c7f10a19feaa9` |

Benchmark-only q4f16 and fp16 artifacts are pinned to
`onnx-community/Qwen3-Embedding-0.6B-ONNX` revision
`c25a394dd583836952667c12f008335071b3f43d`. The fp16 graph uses a separately
hashed 1,199,927,296-byte external-data file. All downloads are size- and
SHA-256-verified before use and remain under the Git-ignored runtime path.

The Node dependency lock SHA-256 is
`3e5523ec8179d1e078c11d37d099d44913b2e0ac4434d493db432f262e98026e`;
the model manifest SHA-256 is
`24a79ef804fbd256f4e7258be67025f2cb6138479b90199456885db85298c0e2`.

## 7. Executed probes and results

### Reproducible commands

```bash
bash docker-testbed/scripts/verify-m01.sh
bash docker-testbed/scripts/run-m01-benchmark.sh
bash docker-testbed/scripts/crossbuild-m01-spksrc.sh
```

The core command builds the Node image, verifies fixture/spksrc/model pins, and
runs inventory, DSM contract, lifecycle, Argon2id, extraction, Ollama, ONNX,
second-session memory, storage, PostgreSQL, and pgvector probes. Raw generated
JSON and build logs are written beneath the ignored
`docker-testbed/artifacts/m01/` directory.

### Runtime and database checks

- ONNX inputs `input_ids` and `attention_mask` produced a `[1, 26, 1024]`
  token-embedding output for the query probe.
- q8 model load was 4,583.40 ms; recorded first/repeat query inference was
  145.46/140.49 ms and the short document was 60.22 ms at one thread.
- Both query and document norms were within floating-point tolerance of 1;
  repeated-vector maximum delta was 0.
- The two-session cgroup peak was 2,016,759,808 bytes against 8,589,934,592
  bytes, with 1,024 and 26 actual tokens respectively.
- PostgreSQL reports major 17, the extension loads, `halfvec(1024)` accepts the
  probe, and cosine self-distance is 0.
- Argon2id candidates at 19/32/64/98 MiB were measured. The closest accepted
  near-100 ms result was 64 MiB, time cost 2, parallelism 1, 113.99 ms.

### Extraction dispositions

| Fixture class | Result |
|---|---|
| TXT/Markdown | Expected identifying text found. |
| Two-column PDF | 480 extracted characters; left-column items precede right-column items. |
| Raster-only PDF | Zero text-layer characters; honestly marked `vision-required`. |
| Word-style DOCX | 762 characters, table present, and explicit second-page text present. |
| Synthetic Google-export-style DOCX | 779 characters and table present; provenance says it is not a real export and page basis is none. |
| Messy XLSX | One worksheet, 50 populated cells, cached `SUM(E5:E7)=23100`, and second region found. |

## 8. Provisional benchmark evidence

The full run contains 108 cells: q8-avx2, q4f16, and fp16; 256, 512, and
1,024 actual tokens; and every thread count from 1 through 12. Each cell has a
warm-up and three measured repetitions, with p50, p95, min/max, process RSS,
CPU time, wall time, average occupied cores, and pressure snapshots.

Representative p50/p95 results (milliseconds) and maximum process RSS are:

| Variant | Threads | 256 p50/p95 | 512 p50/p95 | 1,024 p50/p95 | Maximum RSS |
|---|---:|---:|---:|---:|---:|
| q8-avx2 | 1 | 1,410.02 / 1,410.12 | 3,115.82 / 3,142.56 | 8,709.20 / 9,386.06 | 1,275,564,032 B |
| q8-avx2 | 4 | 404.06 / 517.83 | 1,115.58 / 1,324.07 | 2,843.19 / 3,003.03 | 1,443,229,696 B |
| q8-avx2 | 8 | 346.14 / 379.32 | 826.04 / 957.92 | 2,555.64 / 2,797.40 | 1,427,267,584 B |
| q8-avx2 | 12 | 336.04 / 355.93 | 762.21 / 776.00 | 2,306.08 / 2,371.05 | 1,421,201,408 B |
| q4f16 | 1 | 2,169.58 / 2,204.88 | 4,797.93 / 4,811.76 | 10,868.74 / 11,066.25 | 1,590,648,832 B |
| q4f16 | 4 | 705.50 / 736.03 | 1,653.47 / 2,781.22 | 4,344.15 / 4,429.94 | 1,651,544,064 B |
| q4f16 | 8 | 569.67 / 576.11 | 1,269.23 / 1,315.01 | 3,463.62 / 3,835.39 | 1,723,973,632 B |
| q4f16 | 12 | 539.28 / 577.63 | 1,179.71 / 1,189.10 | 3,069.11 / 3,148.96 | 1,703,202,816 B |
| fp16 | 1 | 2,114.13 / 2,128.36 | 4,587.29 / 4,649.30 | 10,563.73 / 10,634.46 | 2,846,846,976 B |
| fp16 | 4 | 663.68 / 889.65 | 1,442.99 / 1,509.72 | 3,930.16 / 4,054.21 | 2,862,170,112 B |
| fp16 | 8 | 617.66 / 638.17 | 1,243.85 / 1,266.16 | 3,172.65 / 3,254.27 | 2,857,201,664 B |
| fp16 | 12 | 531.28 / 545.18 | 1,146.54 / 1,149.58 | 2,862.98 / 2,870.82 | 2,838,306,816 B |

The maximum RSS anywhere in the full matrix was 2,896,658,432 bytes (fp16,
11 threads), below the 8 GiB container ceiling. Recorded average occupied cores
tracked the requested thread count closely. CPU pressure total increased during
the run, but the final 10/60/300-second `some` averages were 0.00/0.00/0.03;
memory pressure remained 0.00 throughout, and final I/O pressure averages were
0.00. The raw evidence retains all 108 rows and exact pressure counters.

q8 is both faster and lower-RSS than the two alternatives on this CPU, so it
remains the provisional default. Eight intra-op threads is the provisional
long-input worker cap: moving to twelve improved q8 p95 by about 6% at 256
tokens, 19% at 512, and 15% at 1,024 while consuming four additional physical
cores. The short-query session remains one thread. Both values must be tuned
against DSM service impact on the NAS.

All values are workstation baselines. They must not set a DSM capacity promise
until DSM-006, DSM-007, and DSM-015 repeat the accepted cases on the target NAS.

## 9. Cross-build evidence

The build runs in the immutable spksrc container against a Docker named volume,
not the unsupported Windows/DrvFS bind mount. It targets `ARCH=x64` and
`TCVERSION=7.2`, records file type and SHA-256 for PostgreSQL and `vector.so`,
and does not claim either artifact started on DSM.

The pinned build completed both recipes successfully. The installed x86-64
PostgreSQL 17.11 server has SHA-256
`d09f36d9215b743eed22abbf554e6eab83e88e2457abe653cc6325263dda7400`;
the installed pgvector 0.8.6 `vector.so` has SHA-256
`dfbcdf62e2ff4041adcf6825aa3ddaa232643f782e04b71e17480c1d6a0cd449`.
Both are ELF 64-bit x86-64 artifacts. The server's inspected dependencies are
OpenSSL 3, zlib, libm, ICU 77, and libc; `vector.so` directly requires libc.
The recorded runpaths are `/usr/local/postgresql/lib` and
`/usr/local/pgvector/lib` respectively. The complete generated artifact and
dynamic-dependency manifest has SHA-256
`8ea22cd964db69fd2255da9f8ae376bec82874ee596c528345aea00e4e4d2814`.
A second invocation completed from the preserved named-volume build state and
reproduced the same installed artifact hashes.

Package-user startup and runtime dependencies remain DSM-004 and DSM-005.

## 10. DSM contracts and resolved feasibility problems

The versioned contract requires `run-as: package`, a package data share, one
declared port (8787), reverse-proxy web integration, and explicit lifecycle
actions. Static validation reports 10 adapter methods and 11 lifecycle actions.
The simulator runs as UID/GID 1000, uses mode 0700, exercises install/start/
status/stop/uninstall ordering, and models retained data on normal uninstall.

Problems resolved during the spike:

1. The first dependency image installed two ONNX Runtime versions and appeared
   to stall during npm audit. Aligning the direct version with the Transformers
   dependency and disabling audit/funding network work in the immutable image
   reduced installation to 178 packages in roughly 26 seconds.
2. The generated XLSX uses valid namespace-prefixed OOXML that ExcelJS does not
   accept. The extraction probe now attempts ExcelJS first and records a switch
   to a namespace-aware OOXML reader; formulas use cached values without
   executing workbook code.
3. The q4f16/fp16 community graphs expose 28 layers of key/value cache inputs.
   The ONNX adapter now derives the declared metadata and supplies correctly
   typed zero-length caches for first-pass embedding inference, requesting only
   `last_hidden_state` to avoid unused cache outputs.
4. Windows bind mounts report permissive POSIX modes and are explicitly
   unsuitable for spksrc. The cross-build uses an ext4-backed Docker named
   volume and exports only evidence logs/artifact manifests.

## 11. Gate interpretation and remaining inputs

M1 is labeled `testbed-complete`: the benchmark and cross-build summaries are
filled, the clean-checkout GitHub Actions job passed on the exact implementation
commit, the proof closure passed again, and the final certification commit is
the target of the annotated `m01-complete` tag.

The following do not block the synthetic feasibility gate, but they must be
collected before the milestone that consumes them:

- approved production-like corpus inventory and daily change estimate;
- approved real Google Docs export fixture;
- confirmation of overnight indexing and preferred global ingest window;
- approved Ollama vision model/authentication if vision will be enabled;
- all live items in `docs/Implementation/dsm-deferred-register.md`.

## 12. Authoritative references

- Synology package identity: <https://help.synology.com/developer-guide/privilege/preface.html>
- Synology privilege configuration: <https://help.synology.com/developer-guide/privilege/privilege_config.html>
- Synology data-share resources: <https://help.synology.com/developer-guide/resource_acquisition/data_share.html>
- Synology port resources: <https://help.synology.com/developer-guide/resource_acquisition/port_config.html>
- Synology web integration: <https://help.synology.com/developer-guide/resource_acquisition/web_service.html>
- Synology lifecycle scripts: <https://help.synology.com/developer-guide/synology_package/scripts.html>
- SynoCommunity spksrc: <https://github.com/SynoCommunity/spksrc>
- Qwen model contract: <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
- Ollama structured outputs: <https://docs.ollama.com/capabilities/structured-outputs>
- Node release schedule: <https://nodejs.org/en/about/previous-releases>

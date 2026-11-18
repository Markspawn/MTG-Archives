# Pending scan review performance

Related to [#1004](https://github.com/sefaction/MTG-Archives/issues/1004).
Brian reported roughly twenty pending batches / two thousand saved scans, upload
lag and increasingly slow previews/originals. He requires no scan/batch count
ceiling and no forced reconciliation. He authorized this implementation and then
merging this batch when ready; production deployment remains separate.

The production browser showed one 5,386 kB original taking 5.81 seconds, including
198 ms waiting and 5.61 seconds downloading. The existing JPEG preview was 526 kB
/ 208 ms. A later direct original took 733 ms. These sequential observations show
avoidable transfer volume and variable latency; they do not attribute upload lag
to hardware, database waits or a worker. SSH was unavailable. Original incident
history and remaining affected-installation criteria are preserved in #1004.

## Changes

- Ordinary review uses the existing private JPEG. A component-local blob survives
  overlay/view changes without repeated downloads; decoded images are released
  after drawing and blob URLs revoked on unmount/source change. Originals remain
  available on demand and as fallback when previews are unavailable. The response
  supplies the oriented original frame for saved pixel coordinates, including
  historical EXIF axis swaps. Hash/access/visibility/private-delivery checks
  remain; there is no public image endpoint or shared private-image cache.
- Acquisition, card review and scanner reads serialize requests, schedule polling
  after completion, abort hidden/unmounted work and refresh on return. Manual
  refresh during a read queues a fresh read after it. Capture polls quickly,
  processing-only work less frequently, and settled batches back off. Drafts and
  revision conflicts retain their existing authority.
- Scanner image admission reads the locked session/destination rather than
  hydrating every earlier card. Epoch, execution, sequence, replay, overflow,
  accepted-original durability and ACK behavior remain. The helper still delivers
  serially; no unmeasured upload concurrency increase is included.
- Ordinary owner review reads an existing immutable correction signing key
  without the exclusive lock/upsert shared with uploads. Initialization, sampling,
  publication and cross-owner auditing retain mutation locks and checks.
- The dashboard resolves latest printing checks and failure identities in sets,
  preserving latest-job ordering, revision fences and one count per physical
  card. It avoids a correlated lookup for every retained candidate. Matched
  100,000-card controls return identical full dashboard data; warm observations
  improved from roughly 2.1–2.6 seconds to 0.43–0.44 seconds before adding the
  larger five-stage queue fixture. Aggregate totals still read retained metadata;
  no claim of constant-time all-history totals is made.

The larger five-stage fixture contains 100,000 cards and 499,996 job records.
Its original dashboard query exceeded 105 seconds and that exact owned local
diagnostic read was cancelled; the failure is retained. The set-based query
completed in 3.6–3.9 seconds; fixed-page review took 145–304 ms and photo metadata
5–8 ms. These are local synthetic observations, not production guarantees. A
query-local JIT comparison did not establish a sufficiently consistent further
benefit; no database configuration change is included.

Paging, bounded memory and concurrency regulate work, never saved scan/batch
counts. No count cap, pool enlargement, replica change or storage/physical-capacity
protection removal is included.

## Verification and limits

Eighty focused access/draft/replay/geometry/polling controls, TypeScript and
changed-file lint pass. Source-bound production build, actual PostgreSQL backlog
and lock controls, desktop/phone workflow and exact-head CI are tracked on the PR.
Early compiler heap exhaustion and compile/lint corrections remain in private
evidence, rather than being reclassified as successful checks.

The opt-in `scripts/ci/acquisition-performance.ts` tests a fixed hundred-card page
with 1/20/100 retained batches in CI and extends to 1,000 batches / 100,000
synthetic pending cards in the local review fixture. It checks counts/paging,
private metadata, owner denial, zero Inventory adds and review while an upload
owner's advisory lock is held. Originals exist for the selected batch; other
batches supply metadata/cardinality. This is not native recognition, physical
throughput or disk-capacity qualification.

`tests/ui/acquisition-performance.spec.ts` covers private preview use, mapped
visible pixels, no repeated original downloads during view changes, byte-identical
on-demand originals, fallback/retry, anonymous denial, source-table conservation
and desktop/phone layouts. Original privacy/review controls remain applicable.
Named-installation before/after upload timings and reporter acceptance remain
separate from local author evidence.

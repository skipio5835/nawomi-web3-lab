# ARCROW Local Recorder

This is a local, read-only ArcScan event collector, not a trading service or a
complete chain indexer. It runs independently of the browser. Closing the UI
does not stop a running recorder; shutting down/suspending the PC does. There is
no login-startup task, cloud service, wallet, signer, API key or `.env` requirement.

## Run

Run from the repository root with Node 22.16+ or Node 24 (tested on 24.13.1):

```powershell
npm.cmd run collect-arc-radar
npm.cmd run start-arc-radar-recorder
```

The first command runs one bounded cycle. The second repeats cycles with a
60-second pause after each cycle. Ctrl+C stops a foreground recorder. A stopped
recorder leaves its history readable. Start the existing local ARCROW web server
to display it at `/public/arc-radar.html?network=arc-testnet`.

Data lives in `.local/arcrow/arc-testnet.sqlite` (including SQLite WAL sidecars).
This directory is outside the served public directory and ignored by Git.
Do not copy it to the hackathon export or commit it. SQLite is a built-in Node
module; the tested Node version emits an experimental-feature warning.

## Source Registry

`src/arc-radar-sources.ts` separates configured feeds from announcements. A
configured feed pins network, source ID, protocol and emitter. An announcement
cannot authorize collection or create a trading link. The existing testnet
factory is an observed v2-style contract, not a claim about its operator.

References checked on 2026-09-15:

- Arc's [Uniswap announcement](https://www.arc.io/blog/how-uniswap-brings-deep-liquidity-for-apps-on-arc)
  describes the planned mainnet integration. No mainnet deployment is enabled.
- [Parabola's own site](https://parabola.meme/) describes a planned bonding-curve
  launchpad. This is a self-announcement, not an independently verified deployment.
- [Arc's contract reference](https://docs.arc.io/arc/references/contract-addresses)
  still labels its addresses testnet-only as of that check.

Protocol-specific launchpad progress, graduation and DEX migration are not yet
implemented. Add those only after verified deployments and event schemas exist.

## Persistence and Coverage

- Each emitter has a committed anchor and an optional in-progress pagination
  cursor. A SQL transaction commits decoded events, new pools and the next
  cursor together. Restart resumes pending pages before returning to the head.
- First collection reads only the newest page. Older initial history is marked
  limited when a continuation exists; it is not silently described as complete.
- Later reads page back toward the previous anchor. A missing anchor at the end
  increments a gap counter. Repeated cursors, invalid pages and conflicting
  stored events stop advancement and surface an error.
- Event identity is chain/database, pool, transaction hash and log index. v4
  identities include PoolManager and pool ID. Raw ABI decoding ignores explorer
  method labels. USDC event amounts remain decimal strings from integer units.
- RPC chain ID is checked before each cycle. All HTTP origins come from reviewed
  network configuration, redirects are rejected, responses/timeouts are bounded.
  Indexer blocks are not independently cross-checked against RPC block hashes.
  Conflicting retained hashes block the stream; automatic reorg repair is absent.
- At most 150 registered pools, 100,000 retained events and 30 days of event time.
  A full pool registry stops admission of additional pools and displays a capacity
  warning. It does not evict a pool's history to imply uninterrupted coverage.
- Each cycle visits configured source streams first, then the least recently
  attempted pool streams: at most six streams and two pages each, with a 45-second
  cycle deadline. Pool freshness therefore varies; 60 seconds is not a promise
  to refresh every pool. Failure cooldown ranges from 60 seconds to ten minutes.
- Backfill cursors are bounded at 500 pages per catch-up. Late-indexed logs outside
  the scanned overlap can still be missed. No whole-chain or gap-free guarantee.
- SQLite has a database page limit around 128 MiB with its default page size;
  temporary WAL files and process logs also use disk. This is not a total disk quota.

The UI keeps browser snapshots separate from recorded events. Browser price and
holder comparisons do not gain historical coverage merely because the recorder
is running. Local history shows the latest 20 retained events for the selected
pool, with event and saved timestamps. Snapshot freshness never means a token's
price, liquidity or ownership has been verified as safe.

## Local API and Recovery

The existing server exposes only `GET /api/arcrow/collector?network=arc-testnet`
with an optional validated `pool` reference. It reads the database in read-only
mode; it cannot start a collector, select an arbitrary file, sign or mutate data.
Host, Origin and Fetch Metadata checks reject foreign browser origins. No CORS
permission is granted. The frontend never requests this endpoint on public hosts.

A per-database expiring writer lease blocks duplicate collectors. Lease ownership
is checked before writes. After an unclean stop, the lease expires within three
minutes; the UI reports a recent heartbeat, not an independently checked process.
Network/source config changes invalidate the database fingerprint rather than
reusing another network's records. Preserve the old file and review a separate
database when configuration changes; there is no automatic reset or deletion.

The test suite covers cursor restart, atomic rollback, duplicate/conflicting logs,
wrong-chain denial, writer exclusion, malformed pages, v4 identity, API origin
restrictions, response validation and capacity limits. This remains local
preparation, not a production-readiness certification.
# Mainnet Note (2026-09-16)

ARCROW now also has a read-only mainnet browser feed. This background recorder
still supports testnet indexed events only. `--network=arc-mainnet` is rejected
before creating a database; the UI does not query the local recorder on mainnet.
The existing `.local/arcrow/arc-testnet.sqlite` and its network fingerprint are
unchanged. See `ARCROW_DATA.md` for mainnet RPC sample limits.

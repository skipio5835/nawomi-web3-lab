# ARCROW Data Sources

ARCROW defaults to Arc Mainnet, reading bounded Uniswap v3/v4 event samples from
the official public RPC. Arc Testnet remains a separate selectable network with
one USDC v2-style factory and public ArcScan indexing. An optional local recorder
persists testnet event history independently of the browser. Mainnet also has a
separate local last-good market feed; the public static demo still uses browser
RPC reads. See
[ARCROW_RECORDER.md](./ARCROW_RECORDER.md) for startup, source registration,
checkpoint recovery and coverage limits.

## Local Market Feed (2026-09-17)

The local mainnet list reads `/api/arcrow/markets?network=arc-mainnet` without
waiting for upstream RPC. The server collects in the background after the first
request and saves complete pool bundles to
`.local/arcrow/arc-mainnet-markets.sqlite` (gitignored, never publicly served).
Saved pools survive browser and server restarts. A first-ever collection still
takes time; an empty database is not presented as an empty market.

- A single collection loop serves every tab. Reads never trigger another RPC batch.
- Collection uses the existing chain, factory, block and event validators.
  Previously seen v3 addresses are reverified; saved v4 creation transaction
  references are reconstructed from canonical receipts, not trusted browser data.
- At most 150 stored pools, 32 recent logs per pool and eight pool updates per
  cycle. Two of the top eight recent sampled-volume pools rotate through refresh
  priority; these are partial samples, not a chain-wide ranking. Old inactive
  entries may give way to newer discoveries or explicit lookups at the cap.
- The browser polls saved results every ten seconds while visible. Original
  collection and quote times remain intact. Records older than three minutes
  are stale; failures preserve last-good data, not fabricated zeroes.
- The 55-second collection budget is reported separately from failed reads.
  Budget-interrupted pools retain retry priority and queued lookups are retained.
  Actual failures expose a count and classified reason, not raw provider errors.
  The database keeps the last completed `collection-report` and up to 40
  `failure-history` entries (time, stage, public target, reason). A successful
  cycle clears the current warning without deleting this diagnostic history.
- This is a bounded snapshot cache, NOT a full index, 24-hour volume archive or
  chain-wide token-name search. No missing intervals are reconstructed. No
  complete liquidity, holder or sell-safety claim follows from these samples.
- The first screen is a comparison table. Extra context is collapsed and token
  research opens only on selection. Searches and token details may still require
  direct read-only RPC calls; the local background feed does not need a wallet.
- The API is loopback-only with Host/Origin checks, bounded same-origin JSON
  lookup requests, fixed network/source configuration and no arbitrary URL/RPC
  proxying. No keys, transactions or public deployment are added.

- Network configuration: `src/arc-radar-networks.ts` defines the chain ID,
  explorer, API, USDC address and decimals, and DEX sources.
- DEX boundary: `src/arc-radar-dex.ts` retains v2 creation, reserve, swap,
  and liquidity parsing. `src/arc-radar-v4.ts` adds read-only Initialize
  and Swap decoding, used by the configured mainnet Uniswap v4 deployment.
- Discovery: configured sources are merged by chain and pool identity,
  ordered newest first, and capped by the shared result limit. A failed
  source fails the refresh rather than silently shrinking coverage.
- Budgets: at most four configured sources, ten discovery pages per source
  per refresh, 150 displayed pools, and three concurrent pool loads.
  These are request bounds, not full-chain coverage.
- Storage: API cache and watchlists include the network and chain ID.
  Pool-specific details and observations distinguish the v2 pair address
  or v4 PoolManager plus pool ID.
  Existing testnet watchlists remain readable; old token-scoped observation
  histories are retained in storage but are not reused across pools.

The network selector uses explicit URLs; the default is now mainnet.
`?network=arc-testnet` retains the testnet view. Unknown, empty, or repeated network
parameters fail closed and make no market API calls. Switching networks
clears pool links and preview parameters through full-page navigation;
no in-flight data, filters or selected pools carry across chains. The
testnet watchlist is retained, not copied to mainnet. A `candidate` network can be checked from the CLI but
cannot display markets until explicitly marked `ready` after review.

## Mainnet RPC Coverage (2026-09-16)

### Observed Charts

The selected pool chart uses locally bundled TradingView Lightweight Charts, with
no chart vendor data feed, wallet connection, external embed or extra RPC reads.
It shows sampled prices and observed USDC volume, not OHLC candles. Short histories
use 5-second buckets; longer histories use 1-minute buckets, bounded to the last
24 hours ending at the latest fetched event. Missing buckets are whitespace, not
zero-volume claims; connecting lines are not continuous trade history. Same-time
prices retain event order; duplicate trade identities are counted once.

The supply-value mode multiplies every plotted price by the latest fetched total
supply. It is neither historical circulating market capitalization nor a maximum
supply estimate. Missing or invalid supply disables this mode. Switching pools
replaces data and resets the range; value-mode changes preserve the visible range.
Labels show UTC and quote units (USDC). Zoom controls, touch interaction and theme
and language updates are local only. The existing full-details link gives a wider
chart. TradingView attribution is displayed below the chart.

### RPC Sources

- Official RPC: `https://rpc.mainnet.arc.io`, chain ID `5042`.
- Uniswap v4 PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`.
- Uniswap v3 Factory: `0xf0db7b58379503491d857db50ac9ece64c653918`.
  Official reference: https://github.com/Uniswap/contracts/blob/main/deployments/json/5042.json
- `src/arc-radar-v3.ts` decodes PoolCreated, Initialize and Swap. v3 Swap amounts
  are pool balance deltas (positive quote input = buy), unlike v4 caller deltas.
  No v2 reserves, ERC-20 LP ownership or constant-product exit math apply to v3.
- Mainnet address searches (`?token=0x...`) check USDC v3 pools at fee tiers
  100, 500, 3000 and 10000. They do not search other quotes, arbitrary forks,
  or all v4 pools. `?pool=0x...` resolves a v3 pool independent of creation age.
  Pool factory, tokens, fee and spacing are checked against the official factory's
  getPool mapping. Unknown creation time and transaction remain unknown.
  Lookup has a 60-second deadline. Empty results do not prove no market exists.
  For pools with equally unavailable liquidity, the latest observed trade selects
  the representative; this is not a liquidity ranking or trading recommendation.
- USDC ERC-20: `0x3600000000000000000000000000000000000000`, 6 decimals.
  Native USDC pools use the zero address and 18 decimals, separately.
- `src/arc-radar-rpc.ts` implements only bounded read operations. Each refresh
  checks chain identity, fresh blocks, USDC decimals and deployed manager code.
  Logs are scoped by manager, event topic and (for trades) pool ID. Block hashes
  and timestamps are matched to RPC blocks. This is not an independent node audit.
- The initial mainnet screen requests 8 pools and publishes each completed pool
  immediately with completed/total progress. "All" means V3 + V4, not all pools
  on the chain. Load-more extends the pinned discovery snapshot by eight candidates
  and fetches only unseen pools, retaining earlier rows (up to 150 per session).
  Discovery pages are shared within the session so new pool creation does not move
  the pagination boundary. Expired RPC cursors still fail closed; manual Refresh
  starts a new discovery snapshot and retains the already loaded rows.
- Automatic refresh waits 120 seconds after the previous request completes
  (300 seconds after failure), never overlaps and pauses in hidden tabs. It updates
  at most eight known pools, prioritizing the selection and rotating through the
  remainder; it does not restart discovery. Untouched/failed rows retain cached
  snapshots and their original timestamps. Manual Refresh scans recent pools.
- The market-list search matches names, symbols and addresses within loaded pools
  as the user types; it stays synchronized with the header search. Submitting a
  complete token address invokes the mainnet v3 lookup described above.
  Default sorting is descending observed 24H volume of each representative pool,
  not aggregated token volume or a chain-wide ranking. Partial history still applies.
- The mainnet market list has All / V3 / V4 categories. Each category queries its
  configured adapters for discovery and load-more; switching retains text search,
  sorting and market filters and immediately restores known pools in that scope.
  All shares its bounded result budget across available protocols, then sorts the
  selection by creation time. An empty protocol gives its unused slots to the rest.
  This is a mixed recent sample, not the newest eight pools across the whole chain.
  Each token row names its representative pool's DEX. The selector is hidden on
  token-address results, individual pool links and single-protocol testnet views.
- Discovery scans at most 10 pages
  of 50 blocks for v4 and 1,000 for v3. Per-pool history scans at most
  4 pages of 1,000 blocks. Each page shrinks on provider result limits and holds
  at most 160 events and 12 distinct timestamp blocks; busy ranges shrink before
  timestamp reads, preserving the older-page cursor. Reads never imply full 24H coverage. Cursors expire after
  20,000 blocks. Older pool links can be outside the discovery window.
- Six RPC requests maximum in flight, at least 350 ms between request starts,
  8-second request timeout, 2 MB response limit; 20-second mainnet browser page
  deadline. No unrestricted proxy, credentials,
  wallet provider, signatures or transaction submission. Cached pages retain
  their original fetch time; failures are not zero market activity.
- The mainnet explorer currently redirects to a login page. No attempt is made
  to bypass it. Holder lists, transfer clusters, verified source and per-pool TVL
  remain unavailable. Shared PoolManager balances are never presented as TVL.
- RPC market data is separate from the existing testnet SQLite recorder.
  Mainnet does not claim collection while the browser is closed. A persistent
  RPC indexer/backfill and wider DEX coverage remain future work.
- Local use only in this update. Hosting CSP and deployment require separate
  review; neither GitHub repository nor the hackathon deployment is updated.

### Mainnet activation checklist

1. Record official network, USDC and DEX deployment references and the review
   date. Do not infer addresses or Chain ID from testnet or another chain.
2. Add the confirmed mainnet configuration in `src/arc-radar-networks.ts`
   with status `candidate`. Only public, credential-free endpoints belong
   in the browser bundle. The API must support the Blockscout `/api/v2`
   schema used for indexed mode. RPC mode uses the explicit read-only adapter.
3. Run `npm run check-arc-radar-network -- arc-mainnet`. It checks Chain ID,
   a recent shared RPC/explorer block, USDC decimals and index metadata,
   DEX bytecode presence, log response shape and a final block-hash recheck.
   In RPC mode it instead checks raw Initialize decoding and pool/block identity
   without calling an explorer or claiming holder-index availability.
   The checker is read-only, bounded, does not load `.env`, and never changes
   configuration. Unconfigured or failed checks exit nonzero. The default
   command checks mainnet; `-- arc-testnet` validates the existing network.
4. A passing check is connectivity evidence, not proof of official DEX
   identity, complete history, token safety or browser access. Independently
   verify deployment provenance and real pool creation/swap samples with
   the explorer. Test browser CORS, host CSP, rate limits, quote direction,
   prices, holder responses and external DEX links. v4's missing liquidity
   and bounded historical coverage still apply.
5. Keep testnet/mainnet caches, watchlists and contract addresses separate.
   Mark mainnet `ready` only after the review, rebuild, and test the actual
   deployment path. Check visible network labels and that unsupported data
   remains unknown. Default-network changes require a separate decision.
6. If checks fail, return mainnet to `candidate` and rebuild. Never route a
   mainnet request to testnet as fallback. Publishing and hackathon updates
   remain explicit actions, separate from local configuration.

Official references last checked 2026-09-16:
[Arc launch announcement](https://www.arc.io/blog/arc-mainnet-goes-live-on-september-16-2026),
[RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints),
[Uniswap deployments](https://developers.uniswap.org/docs/protocols/v4/deployments).
The RPC page now lists mainnet settings, and Uniswap lists Arc chain 5042.
Live RPC probes confirmed chain identity, manager code, USDC decimals and raw
pool events. Readiness checks do not create a monitor or scheduler.

## Token readout

The token detail view combines existing price, swap, liquidity-event and
holder inputs into a deterministic readout (`src/arc-radar-analysis.ts`).
It makes no additional network requests, wallet calls, or AI/API calls.
Headlines are interpretations with linked evidence and explicit unresolved
points, not forecasts, safety scores or trade recommendations.

- The one-hour window is anchored to `periodsAsOf`, not the later render
  time. Period calculations expire after two minutes; the oldest market
  input must have been fetched within five minutes. Stale, future or undated
  inputs withhold current market interpretation. Price direction additionally
  needs a complete history, a valid hourly baseline and an event within 15
  minutes. Balance-only estimates cannot establish a price trend.
- Headline price moves use a 5% threshold. Flow uses valid Swap events and
  USDC value, not Transfer events, unique traders or inferred net capital
  inflow. Exact `(transaction hash, log index)` copies count once; conflicting
  copies or incomplete histories withhold flow conclusions. A missing sell
  is not proof of a sell restriction, and two-way swaps do not prove demand.
- A v2 removal qualifies at 10% of the prior quote-side reserve within the
  same hour. It is an individual event, not a net liquidity change: subsequent
  deposits and swaps can offset it. v4 pool liquidity and hook-adjusted
  execution remain unassessed. No manager-wide balance is substituted.
- Holder analysis requires fresh, complete coverage. A top-10 share of at
  least 50%, or an increase of at least 3 percentage points, merits review.
  Changes compare consecutive in-memory detail snapshots only when the
  excluded-pool scope matches, the prior snapshot precedes the current one
  by at most 24 hours, and both sources were complete and fresh. Reloading
  starts without a comparison baseline. These are indexed, not fixed-block
  ownership snapshots; they do not identify independent people or insiders.
- Rule thresholds are screening conventions. Missing/partial evidence is
  explicitly unresolved rather than favorable. Public explorer links provide
  context; the latest holder page may differ from an earlier snapshot. Shared
  v4 manager links are labeled as all-pool events, not pool-filtered history.

Core explanations and limitations support English, Korean and Japanese.
Regression tests run with the existing `npm run test-arc-radar` command.

## v4 readiness (2026-09-14)

The v4 adapter verifies the configured log emitter, raw event ABI, transaction
and log identity, and the pool ID computed from its Initialize pool key.
Prices use sqrtPriceX96 with currency ordering and token decimals. Swap
direction follows signed caller deltas; the PoolManager sender may be a
router and is not presented as the trader. Hook adjustments are not included
in these pool-event amounts. Hook behavior is not audited.

Arc native USDC (zero-address currency, 18 decimals) and ERC-20 USDC
(6 decimals) are handled separately. A native-USDC/ERC-20-USDC pair is
not listed as a meme-token market. The two representations are not summed
as independent wallet balances. This adapter reads pool events, not the
native and ERC-20 Transfer streams.

Per-pool liquidity, LP ownership, and exit estimates remain unavailable
for v4. Shared PoolManager balances and ModifyLiquidity units are not used
as token reserves or TVL. Missing metrics display `--`, not zero; no v2
exit curve is applied. Concurrent identical API reads share a request.

v4 links use `pool=v4:<manager>:<poolId>`. Only configured managers are
accepted. Initialization lookup is bounded to ten manager-log pages;
older pools outside that window fail explicitly, rather than substituting
the manager's creation transaction. Scalable pool-ID indexing, position
valuation, and hook-specific analysis remain follow-up work.

Do not enable a v4 source until its Arc deployment and index response
shape have been verified. `poolManagerAddress` must be explicit and match
the source's legacy `factoryAddress` field. Test fixtures are synthetic;
they are not deployment addresses or live price evidence.

References: [Uniswap deployments](https://developers.uniswap.org/docs/protocols/v4/deployments),
[PoolManager](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol),
[Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses).

Run `npm run test-arc-radar` and `npm run build-arc-radar`.

Color theme is independent of market loading: Light / Dark / System is stored
locally as `arcrow:theme`, defaults to the OS preference, and syncs across tabs.
Blocked storage falls back to the current tab. The small pre-CSS script applies
the initial theme before market code loads. Semantic CSS tokens cover controls,
charts, and state colors. The original full-color ARCROW emblem is preserved on
a fixed light ground; it is not inverted. No theme setting leaves the browser.

Language selection supports English, Korean, and Japanese for core navigation, filters,
market labels, and key warnings. The `arcrow:language` browser preference takes
precedence over the browser language and syncs across tabs. Only explicitly
marked application copy is translated; token identity, addresses, numbers, and
external data remain literal. Some detailed technical descriptions and raw errors
remain English. Switching language preserves the active view and does not refetch
market data or use a translation API. Preferences remain local to the browser.
Pool pricing, transfer interpretation, LP ownership, and holder-coverage notes are
included in both translations. The stacked detail view links back to the market
list in the same page without clearing filters or requesting fresh data.

# Shareable pool detail and watchlist digest

The same static HTML supports `?network=arc-testnet&pool=0x...` for a focused
detail page. Full details / Copy link preserve the deployment path but remove
preview parameters. Pool addresses identify the trading venue; this is not yet
a token-wide aggregate across multiple pools. No server rewrite is required.

v2 direct links resolve the address's creation transaction and inspect at most four
log pages for a matching PairCreated event emitted by a configured factory.
They do not depend on the most recent 15 discovered pools. Invalid/unverified
links fail explicitly without substituting another token. Missing index data may
prevent a legitimate pool from resolving. This is source verification, not a
security audit. Public SEO metadata/server rendering remain future work.

The homepage digest summarizes up to 12 material observations since the explicit
review marker, or recent saved observations in Recent history, excluding Watch
started records. Reloading does not acknowledge unseen changes. Mark all reviewed
acknowledges existing records through the click time, including records outside
the displayed 12. Legacy last-visit timestamps seed the marker once. Browser
storage is used where available with a current-tab memory fallback.

While visible, the homepage checks at most three loaded watched pools per minute,
oldest check first, with a two-minute detail cooldown. Failures also cool down;
concurrent requests for the same pool/scope share a request. Opening details may
make additional reads. Unloaded watched tokens are explicitly outside coverage.
In-flight reads may finish after the tab becomes hidden, but new background reads
are not started. This is not continuous monitoring while the browser is closed.
No server indexer, wallet connection, or external notification service is added.
A copied localhost link works only on that machine.

## Token grouping and sell observations

The market list groups eligible pools by chain ID and token contract address,
never by symbol/name. Each row shows one representative pool, preferring
a usable price, non-stale data, then highest liquidity and latest observed trade.
A cached priced pool retains its cached label even when an empty fresh pool is
available; selection never ranks by the highest price or FDV. All numeric and
activity filters apply after grouping to the same displayed representative.
Row metrics and their summary describe representatives, not token-wide totals.
The market pulse still covers all loaded pools. The detail panel's pool selector
compares all currently loaded pools for the token, including pools outside the
active filter. Direct pool links load just their requested pool; they do not
discover every alternative pool. Changing metric filters cannot substitute a
secondary pool to pass a threshold. Protocol selection and exact pool search can
change the pool scope and thus the representative.

Sell observations use transaction hash plus log index, scoped to the saved pool.
The first observation, including migration from count-only records, establishes
a baseline without historical notifications. New unseen events trigger an info
alert even if the rolling sell count is unchanged or lower. Delayed indexing may
surface old trades, so the alert does not claim they just happened or that the
token is safe. Missing transaction hashes/log indices are ignored.

Up to 2,000 event identities are retained per tracked pool. When older identities
are evicted, an inclusive timestamp floor prevents them being reported again;
newly indexed events at or before that floor are deliberately ignored. Unseen
events outside fetched history cannot be detected. This is bounded local
observation, not a complete on-chain transaction monitor.

## Detail data quality

The header's Checked time is the time the browser checked, not a new trade.
Each pool preserves its price-event timestamp independently from the oldest
fetch timestamp of the data used for pricing. Cache hits and offline fallback
retain that original fetch time. Prices with no event for over 15 minutes are
labeled accordingly; quiet trading is not claimed to prove indexer delay.
Balance fallback has no verified price-event time. Invalid/future event times
are excluded and mark the history partial. Malformed log-page responses fail
instead of appearing as zero activity. No extra background RPC polling is used.

Holder, LP, contract, creator, transfer, and transaction-sender reads retain
fresh/cached/unavailable status. Fresh means within the local API cache TTL,
not guaranteed real-time indexing. Failed holder reads never become zero
concentration. Partial holder pages leave absent balances and burn totals
unknown; top-N is shown only if enough non-pool positions were loaded or the
holder page is complete. Rankings exclude burn addresses and all loaded
same-chain, same-token pools. Undiscovered pools may still appear as holders.

Ownership alerts preserve prior valid metrics when a read is stale or missing.
Changes to the known-pool exclusion set establish a new concentration baseline
without claiming ownership moved. Legacy ownership baselines are discarded once;
other saved watch history is retained. Detail cache entries expire after two
minutes and are rebuilt when the known-pool set changes.

Transfers into/out of pools are not automatically called buys, sells, or full
exits. Absence from the first holder page does not prove a zero balance. BUY/SELL
in the trade tape still comes from decoded Swap events. Missing transaction
sender data may display the Swap recipient explicitly as Recipient instead.

Window returns need an indexed price at or before the requested start time;
otherwise they display `--`, including newly created pools. A current balance
fallback is never assigned a fabricated pool-creation timestamp. Counts and
volume remain limited to fetched event pages, as indicated by history coverage.

Liquidity totals and screening use every decoded event in the fetched pages;
only the visible event list is capped at eight rows. The UI reports displayed and
fetched counts and flags truncated history. The 24H sum excludes events outside
the time window, including future timestamps. Missing or invalid total supply,
decimals, or a usable price makes FDV unavailable; a genuine zero supply remains
distinct from missing data.

If discovery finds pools but none can be loaded, the refresh fails explicitly.
Previous rows remain marked cached, while an initial failure shows unknown
activity instead of zero volume. Partial failures identify the omitted pool count
and scope of the totals. A successful empty discovery remains a valid empty result.

## Evidence-first product view

The coverage line identifies the configured factories, loaded pool count,
cached/partial data, and testnet-only scope. These are selected markets, not the
whole Arc ecosystem. Mainnet demand and ad revenue are not validated by testnet
activity. Advertising remains an optional local preview, outside all rankings.

Changes to review uses explicit screening rules: indexed liquidity removal of
at least 10% of prior quote reserve, then calculated 1H reserve-price moves of at
least 30% with complete fetched history and a recent trade, then new pools with
indexed trades. Stale pools are excluded. One result per chain/token, up to six;
within each category the newest record wins. This is not an alpha or safety score.
Event records link to source transactions; price calculations link to pool details.

Capability checks retain matching ABI names and explorer proxy indicators as
unverified evidence. Names alone do not prove ownership renunciation, simulate a
sale, or establish that a control remains executable. Optional getter reads are
displayed separately and do not upgrade ABI-name findings to confirmed capabilities.
No matching function name is not a clean bill of health. The UI no longer sums
flags into a red/green risk grade. It separates indexed, calculated, and unverified
findings and provides source links. PairCreated transaction senders can be relayers
and must not be assumed to identify the token's team.

## Optional contract-state snapshot

Contract state / Read state makes read-only calls to the configured public Arc
Testnet RPC (`https://rpc.testnet.arc.io`), without an injected wallet provider,
account, API key, signature, transaction, or gas spending. The endpoint and chain
ID follow [Arc connection documentation](https://docs.arc.io/arc/references/connect-to-arc).

Each explicit request fetches uncached explorer verification metadata and ABI.
Only exact view/pure signatures for owner, pendingOwner, paused, cap, totalSupply,
DEFAULT_ADMIN_ROLE, MINTER_ROLE, getRoleMemberCount, and getRoleMember are eligible.
Absent or unverified ABI functions remain unexamined, not absent or harmless.
Supply amounts use exact integer base units, not potentially stale token decimals.
Enumerable role members are capped at five per role with coverage/failure counts.
Non-enumerable roles do not imply an empty membership list. Other/custom roles,
role admins, allowlists, and hidden or nonstandard controls are not inventoried.

An explorer-reported single verified implementation may supply an ABI, but calls
always target the token/proxy address. The implementation mapping is not checked
against proxy storage; an upgrade can make this ABI obsolete. Matching getter
values are contract-reported data, not proof that each function enforces them.

RPC chain ID must match. Reads share one block height, whose hash is rechecked
before showing results. A block over five minutes from the local clock, wrong
chain, or changed block rejects the snapshot. Individual failures remain unknown,
never zero/false. Unsupported reads and unavailable metadata are explicit. A zero
owner, false paused flag, empty role, or cap value is not a safety/sellability verdict.

The block link/time and read time stay attached to the result; it is never labeled
live. Snapshots remain only in tab memory, keyed by chain/token, separate from
watchlist baselines. Market auto-refresh does not run or freshen these reads.
Only one snapshot request runs at a time, with a per-token 60-second attempt
cooldown, no retries, at most two concurrent RPC calls, eight-second HTTP timeouts,
and a 30-second overall deadline. A failed retry removes the prior displayed result.

## Fast Mainnet List

On return visits, the list re-decodes locally saved factory pages and cached
token/log inputs before making RPC calls. Up to 150 pools are restored together;
cache entries must be from this network and at most 24 hours old. Restored rows
are labeled cached, retain source fetch/event timestamps, and do not create new
observation alerts. Missing, malformed or inaccessible storage falls back to live
loading. No snapshot is uploaded or shared with other visitors.
On a storage-quota error, only this network's disposable API response cache is
evicted (older cursor pages first). Watchlists, observation journals, preferences,
other networks and unrelated application storage are never removed.

Mainnet list refreshes read one recent log page per pool instead of four. These
remain explicitly partial samples, not complete 24-hour volume. Dedicated pool
and token pages retain the four-page history budget. Verified live v3 factory
events reuse their decoded pool identity, avoiding six redundant getter calls;
cached events and direct pool links still require independent pool verification.
First visits and unseen pools still need RPC reads. This is not a full-chain index.

## Token Name Search

The minimum FDV selector filters loaded representative-token rows, including
name-search results, by price times latest total supply in USDC. The 10M threshold
is inclusive. It is not circulating market cap, a chain-wide large-cap search,
or a liquidity/sellability claim. Missing and non-finite values cannot pass.
Saved identities without market data are withheld while metric, activity or
protocol filters require information that has not been loaded,
but submitting search can still fetch them before checking the threshold. Pool
representative selection precedes the FDV check to avoid promoting an otherwise
ineligible token solely on an idle pool's inflated price. Cached rows retain
their cached labels; the filter does not make their price current.
The filter reports FDV-known, below-threshold and unknown counts for the current
search scope, alongside the result count after all selected conditions. Unknown
liquidity is not zero; when none of the scoped markets has a liquidity value,
a positive minimum shows an explicit exclusion notice. FDV sorting is numeric,
descending, with unavailable values last; filtering uses unrounded values.
The row FDV tooltip exposes the unabridged numeric value. Reset clears search
and market filters without changing networks or protocol selection.

Protocol changes retain up to 150 previously loaded pools in memory and restore
only the selected sources, including older directly searched v3 pools. Stored
raw cache restores cannot overwrite a newer in-memory market. A protocol with
known in-memory pools switches immediately without a network reload; Refresh,
Load more and normal background updates continue live reads. A protocol without
loaded pools still needs initial discovery.

After initial mainnet refresh, up to three recently viewed tokens with saved pool
references, seen within 24 hours and absent from the restored factory list, are
revalidated and loaded in place. This restores address/name lookups such as older
v3 pools without trusting stored computed prices or scanning all saved names.
It runs once per page load; manual Refresh can retry, but automatic refresh does
not loop on failures. An active search takes priority, and restoration does not
change an already selected token. Pool and RPC limits still apply.
Explicitly searched or opened tokens have a separately validated, cross-tab
merged view timestamp. Restoration prioritizes these ahead of background metadata
updates without increasing the three-token lookup budget; no prices are stored
in this priority record.

Name and symbol search uses a separate browser-local token directory, independent
of the currently loaded market list and its filters. Matching is case-insensitive
and supports partial names; exact symbols rank ahead of partial matches. Results
show the full address because duplicate names are not token verification.
Search results share the Arc meme markets list: matching loaded markets retain
their prices and volumes, followed by saved-only tokens labeled as not loaded.
Tokens already loaded (including those excluded by market filters) are not
repeated as saved-only entries. Saved-only results never pass metric filters on
missing data; watchlist membership is checked before the search result cap.
Submitting search scrolls to the market
board; clearing search restores the regular list.

The directory imports this network's saved token metadata and remembers tokens
as markets load. It retains up to 2,000 identities for 90 days, isolated by chain,
and shows up to 20 matches. It is not a full-chain index; clearing browser storage
removes the directory. Storage failures retain in-tab search with an explicit
notice. Typing does not issue RPC calls. A selected result opens a saved pool;
mainnet identities without a saved pool use the existing v3 address lookup,
while testnet identities without a pool open ArcScan. Unknown names still require
a token address or prior discovery. Pool data is fetched again after navigation.

Submitting a name search queues the first three missing identities for in-place
market loading, after any current market refresh. Mainnet lookup uses the
configured v3 factory's checked USDC fee tiers and saved/configured v4 pools;
testnet uses known pool references. Up to six pools per token use the existing
one-page, partial-history market reader, at most two pools concurrently. Results
replace metadata-only rows without navigation. Query changes discard obsolete
results; market refresh and protocol changes cannot overlap the search batch.
Failures and absent pools in the supported lookup are distinct, retryable states,
not claims of no markets anywhere. The 150-pool session cap still applies.

## Browser Discovery Journal

`src/arc-radar-observations.ts` reuses loaded pool data without additional API
requests, wallet access, or an AI service. The discovery strip shows up to six
loaded pools, newest browser observation first (creation time breaks ties).
Its filters distinguish locally observed pools, on-chain creation within 24h
(newest creation first), and swaps in at least three distinct five-minute
intervals in the trailing hour (most occupied intervals first).
Positive activity evidence may be partial; windows are not independent traders,
organic demand, a recommendation, or evidence of wash trading. Newly observed
does not mean newly launched. Loading more markets changes the observed coverage.

An initial snapshot and latest read are retained per chain/pool, with up to 24
intermediate five-minute checkpoints and 32 indexed Swap/Mint/Burn events.
The earliest retained swap is preserved, not asserted to be the first-ever trade.
Event identity is transaction hash plus log index within a pool; malformed,
future, pre-creation and conflicting current events are withheld. Chain event
time and the browser observation time are displayed separately. v4 identities
include manager and pool ID, and never use shared reserves or v2 liquidity events.

Fresh market inputs are required: a read no older than two minutes and original
source fetches no older than five minutes. Price and quote-reserve comparisons
also require a non-fallback price event within 15 minutes. Top-10 comparisons
require complete fresh holder reads with matching pool exclusions. Missing data
is not zero. The timeline shows observed price changes of at least 5%, reserve
changes of at least 10%, holder address count changes, and same-scope top-10
changes of at least 3 percentage points between retained reads. Reserve changes
are not necessarily liquidity additions/removals or net capital inflows.

Storage is browser-local, not shared with a server: at most 150 pool records,
evicting least recently observed pools and records last read over 30 days ago.
The first baseline survives while its pool record is retained. Reload retains
history; clearing browser storage removes it. Storage errors fall back to tab
memory with an explicit notice. Concurrent tabs are best-effort, not a coordinated
indexer. Snapshots/log samples have coverage gaps, are not reorg-verified or a
complete audit ledger, and do not backfill activity while the browser is closed.
The visible timeline retains the oldest two and newest ten entries when longer.

## FDV Inputs for Quiet Pools

Mainnet V3 and V4 prices also use read-only pool state at a checked block, so an
empty recent Swap window no longer forces FDV to be unknown. V3 reads slot0 after
canonical factory registration; V4 uses the configured manager's extsload with
Uniswap StateLibrary's pool mapping slot (6). Token ordering and native/ ERC-20
USDC decimals remain distinct. FDV still requires actual totalSupply and decimals;
no fixed assumed supply or zero substitution is used.

State prices are labeled with their block and observation time. They are not
trade events and do not add swaps, volume, holder data, or candles. Missing/failing
state reads retain an available event price or unknown; cached state is labeled
cached and cannot overwrite a newer event. Filters apply to loaded representative
pools, not a chain-wide token index, and exclude unknown FDV values.
Where all of a token's pools lack measured liquidity, actual trades within 15 minutes take
precedence over an idle pool's newly fetched state quote when choosing the token's
representative. Cached inputs stay labeled cached; ranking never maximizes FDV.

## Launch Platform Attribution

The selected token's launch origin is separate from its trading DEX. Currently
only ArcPad on chain 5042 is configured, using the platform-published deployment
and `TokenCreated` ABI at https://arcpad.meme/docs (checked 2026-09-16).
The result attributes the launch contract, not the frontend website used, and
does not endorse a token, prove safety, or imply Circle affiliation.

Verification requires a successful receipt, exact token and allowlisted emitter,
canonical block hash, and the matching V3 factory PoolCreated event in the same
transaction. Metadata, images, names and third-party token APIs are not evidence.
The reader first checks an available pool-creation transaction, then searches at
most 1,000 recent blocks with an exact token topic. Older origins, other platforms,
and later pools may remain unconfirmed. Missing evidence never means direct
deployment. Provider failures remain unavailable, distinct from an empty search.

Lookups run only for the selected token and do not block market rendering. Results
are tab-memory cached per chain/token (up to 256): verified 1h, unknown 5m, failures
30s, with in-flight deduplication. No wallet access, signing or additional API keys.
Rows retain the checked token's result; unselected tokens show not checked.

Next release gates: verify deployed mainnet DEX protocols before integration;
extend local event checkpoints with independently verified block continuity and
late-indexing backfill, and add deployment-specific launchpad lifecycle adapters;
validate the watch-and-review workflow with actual traders before adding paid data,
public analytics, or real advertising. These gates have not been completed.

## Local Size Quotes

The selected-token panel can request read-only KyberSwap Arc mainnet quotes for
100, 1,000 and 10,000 USDC, or sell a user-entered token quantity and its 10x/100x
multiples for USDC. Sell quantities are parsed exactly at the selected token's
decimals, with no rounding or floating-point scaling. No quantity implies a wallet
balance. Requests are manual, independent of market collection,
and served only by the loopback `/api/arcrow/quotes` endpoint. No wallet, approvals,
transaction construction, execution or ARCROW fee collection is implemented.
Public deployments and testnet do not call this endpoint or fall back to another
chain. Token decimals must be known before the panel is enabled.

The endpoint accepts a token address, the exact mainnet network ID, and optionally
`side=sell&amount=<raw token units>` (bounded so all three sizes fit uint256). It
uses a fixed GET provider URL, rejects redirects and cross-origin requests, checks
response token identities, amounts, timestamps and fee settings, limits response
size and request time, and strips all transaction data. It deduplicates in-flight
queries, caches up to 32 comparisons for at most 30 seconds (5 seconds on partial
failure), permits one batch at a time and six new batches per minute, and backs
off for 60 seconds after provider rate limiting. Cache identities include direction
and quantity. Local contention, local quota and provider throttling have separate
error codes and retry deadlines. No secret or user address is sent.

Clients requesting `application/x-ndjson` receive bounded validated snapshots as
each size completes. The default response remains JSON. This preserves sequential
provider requests without holding the first result for slower sizes. The UI retains
partial results, distinguishes all-failed/partial/interrupted states, and never
automatically retries quotes. Changing token, direction or quantity cancels the UI
request; a shared server batch may finish and briefly occupy its single slot.

Output quantities and route pools are provider estimates, not verified execution
or sellability, including when a sell quote is returned. Rate differences compare
output per input against the first size in the selected direction, not against an
independent market price. Sequential reads may use different
prices/routes; they are not a controlled price-impact simulation. Pool costs are
embedded in quotes, gas is additional, zero/missing gas estimates remain unknown,
and KyberSwap may retain positive slippage. No-route, timeout, invalid data and
provider errors remain distinct. Old quotes keep their original timestamps and
are visibly marked expired; expired rate comparisons are withheld.

Local direct pool/token links reuse matching checked server snapshots before RPC.
Stale snapshots keep their original time, and an absent snapshot falls back to
one-page direct reads while queuing the address for future collection. New or
uncached pools still depend on upstream RPC; this is not whole-chain coverage.

Provider reference: https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps
Commercial terms, public quote-only usage limits and chain-specific transaction
security remain release gates before any public or trading integration.
The provider documentation now recommends an API-key gateway; the existing public
endpoint remains rate limited. Gateway credentials and public deployment are not
configured by this local-only change.

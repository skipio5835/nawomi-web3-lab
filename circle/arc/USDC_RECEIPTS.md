# USDC Receipt Ledger

The read-only ledger in `public/arc-usdc-tools.html` accepts an Arc Testnet
transaction hash and optional wallet filter. The standalone
`public/arc-usdc-receipt.html` supports Arc Mainnet (5042) and Arc Testnet
(5042002), with Mainnet selected by default. It needs no wallet connection,
signature, API key, or database. Memo and batch sends also start a receipt
lookup after confirmation. This is receipt-scoped, not a wallet-history index
and not an invoice settlement system. The standalone page contains no send, approve,
or wallet-connect controls; the existing memo and batch tools stay testnet-only.

`src/arc-usdc-events.ts` uses the native system Transfer stream as the canonical
movement list. ERC-20 USDC events are matched one-for-one by addresses, exact
amount, and order to preceding system events. Repeated equal payments remain
separate; duplicate copies of the same log are removed. All totals use bigint
18-decimal base units. Foreign token transfers never count as USDC.

The reader verifies chain ID, transaction hash, canonical block hash, receipt
status, transaction identity, block membership, and log identity. Successful
native-value sends must include their matching system movement. Missing mirrors, legacy pre-Zero5 system events,
malformed logs, or conflicting log copies do not produce trusted totals.
Zero/self transfers are excluded. Gas is shown separately from movements and
wallet net flow. Native and ERC-20 balance views read the same block and are
not added together.

RPC responses are trusted data from the configured provider, not independently
verified cryptographic proofs. A receipt match is not proof of a unique invoice
payment or a complete wallet balance change. Failed lookups and changed inputs
clear prior displayed results. Switching networks or inputs cancels standalone
lookups; late replies cannot overwrite the current selection. An unavailable
receipt is not labeled a failed transaction. A reverted receipt reports gas
separately and never claims funds were delivered.

Inputs are not saved or uploaded to an application backend. The configured
public RPC receives the transaction hash; wallet filtering happens locally.
The read-only page has a restrictive CSP, fixed RPC/explorer endpoints and no
API keys. The optional JSON download retains raw 18-decimal units, network,
timestamps and incomplete-coverage flags. It is not a legal receipt.

No contract deployment, mainnet transaction or gas payment is needed to run this
viewer. Mainnet lookup support does not imply public web hosting is deployed.

Verification: `npm run test-security-js`, `npm run typecheck`,
`npm run build-arc-usdc-tools`, `npm run build-arc-usdc-receipt`.

Reference: [Arc USDC system events](https://docs.arc.io/arc/references/usdc-system-events).
Network settings: [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc)
(checked 2026-09-28).

## Recipient and amount comparison

The standalone page optionally compares an expected positive USDC amount with
the recipient's net explicit movements in one transaction. Blank expected amount
keeps ordinary receipt lookup and optional address filtering. Amounts are parsed
exactly (up to 18 decimals); exponent notation, separators, rounding, zero,
negative amounts and values above uint256 are rejected before RPC work.

Comparison states are exact match, short, over, no incoming movement, reverted,
incomplete, or manual review. Any outgoing movement or mint/burn involving the
recipient requires manual review, even if the net amount matches. A temporary
inflow that is forwarded or returned must not be presented as a completed payment.
Incomplete events withhold comparison totals. Gas and block rewards are outside
the compared movement amount; the gas payer is not necessarily the token sender.

`src/arc-usdc-receipt-check.ts` owns this pure comparison and report schema.
Expected recipient and amount are never sent to RPC, placed in URLs, or persisted.
Changing any input invalidates the prior result and its export/print actions.
JSON exports include the comparison snapshot with exact base units. The print
view includes the network, transaction, amounts, time zone, and limitations, and
can be saved as PDF using the browser. No server-side report storage is added.

An exact match only describes user-supplied conditions in a single transaction.
It does not authenticate a sender, prove a particular invoice was settled,
detect reuse of a transaction for multiple claims, or establish current balance.
There is no automatic crediting or refund action.

Design reference: [Arc Portal](https://portal.arc.io/) for task-focused navigation
and separation of app discovery from execution. The page is explicitly independent
of Circle; the Portal link is external, not an SDK integration or endorsement.
Implementation references: [USDC system events](https://docs.arc.io/arc/references/usdc-system-events)
and [Index Arc events](https://docs.arc.io/integrate/infrastructure/indexing-events)
(reviewed 2026-09-28). Portal Help Center was not retrievable during this review;
no undocumented Portal API or wallet behavior is assumed.

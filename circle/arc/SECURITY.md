# Arc Contract Security

The contracts in this repository are experimental Arc testnet software. They are not externally audited and must not hold production funds until an independent audit and deployment review are complete.

## Local verification

Run the complete contract gate from the repository root:

```powershell
npm.cmd run security:contracts
```

The gate compiles every custom contract, runs the Foundry security regression suite, and runs Foundry's high/medium/low Solidity lints.

## Security assumptions

- Arc's native gas token is treated as the payment asset by these contracts.
- Merchant, organizer, seller, treasury, worker, beneficiary, and payer roles are explicit trust boundaries.
- Settlement is restricted to earned funds and configured recipients where the workflow promises escrow protection.
- External native-token refunds use checks-effects-interactions. Auction outbid and cancellation refunds use pull payments to prevent denial of service by rejecting recipients.
- IDs must be generated with sufficient entropy. Human-readable or predictable global IDs can be claimed by another account first.

## Remaining production work

- Obtain an independent audit and add invariant/fuzz testing for every balance-holding contract.
- Define dispute authorities, deadlines, return windows, emergency pause behavior, and upgrade or migration policy per product.
- Decide whether contracts should remain native-token only or use explicit ERC-20 `SafeERC20` transfers.
- Use multisig-controlled administration for contracts with owner powers.
- Pin deployment bytecode, compiler settings, constructor arguments, and verified source for every release.
- Monitor deposits, settlements, failed withdrawals, and role changes after deployment.

## Known design limitations

- `ArcEscrow` uses the buyer as the dispute resolver. A production escrow needs an agreed arbiter or a deterministic dispute module.
- Marketplace return records do not themselves reverse a settled payment. A production marketplace needs per-order settlement and an explicit return window.
- Rental damage assessment is controlled by the rental owner. A production rental flow needs renter confirmation or dispute resolution.
- Streaming cancellation and atomic revenue splitting can fail when a recipient contract rejects the native token. A production version should use recipient-controlled pull withdrawals throughout.
- The contracts do not currently implement a global emergency pause or migration mechanism.
- Do not expose the compiler process as a public service or compile untrusted input.

## JavaScript dependency review (2026-09-11)

- Anchor's transitive `toml` dependency is overridden to `4.2.0` (Node.js 20+).
  This fixes [prototype pollution](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j)
  and [unbounded parser recursion](https://github.com/advisories/GHSA-82x6-q7mm-w9cf).
  `npm run test-dependency-security` covers Anchor-style string/Buffer parsing,
  isolated malicious-input regression tests, SDK loading, and ARCROW dependency isolation.
- `stream-json` is removed. Solana web3.js uses only Jayson's browser client, so a
  [local browser-only subset](vendor/README.md) retains that original implementation
  without Node server/transports or the vulnerable parser. This eliminates the
  [filter DoS dependency](https://github.com/advisories/GHSA-528h-pc64-c93x) instead
  of forcing an incompatible stream-json major version. Server APIs are unavailable.
- `elliptic` is removed along with the unused ethers v5 signer/provider/transaction
  chain. `@ethersproject/hash` needed it only indirectly for two TypeScript interfaces.
  Its local subset preserves all original runtime code and keeps those interfaces
  locally. No cryptographic implementation is replaced or modified to address the
  [signing advisory](https://github.com/advisories/GHSA-848j-6mx2-7j84).
- The npm workspaces have explicit local version suffixes and scoped overrides for
  the installed ABI and Solana consumers. Retained MIT sources and licenses, upstream
  archive integrity, and per-file runtime hashes are recorded under `vendor`.
  These are maintained local subsets, not official patched upstream releases.
- Regression tests reject vulnerable package reintroduction, check retained runtime
  integrity and strict declarations, compare hashing/ABI results against ethers v6,
  and exercise actual Solana RPC calls with mocked transport. ARCROW's browser graph
  still excludes the flagged SDK dependencies. No wallet signatures are needed.
- `npm audit --audit-level=low` now reports zero advisories. CI blocks low or higher
  findings, without an allowlist, severity suppression, or forced SDK downgrade.
  This is a dependency-audit result, not proof that all application or contract
  vulnerabilities are absent. Local subsets require manual upstream advisory review;
  replace them with official compatible releases when available.

Report security issues privately to the repository owner. Do not include private keys, entity secrets, API keys, or live exploit details in a public issue.

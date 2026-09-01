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
- `npm audit` reports one remaining high-severity issue through the local `solc` toolchain's `tmp` dependency. The suggested automatic fix downgrades `solc` to `0.5.0` and is intentionally not applied. Do not expose the compiler process as a public service or compile untrusted input.

Report security issues privately to the repository owner. Do not include private keys, entity secrets, API keys, or live exploit details in a public issue.

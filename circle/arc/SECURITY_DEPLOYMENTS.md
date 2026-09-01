# Arc Security Deployments

## 2026-08-31 to 2026-09-01 Hardened Releases

- Network: Arc Testnet (chain ID `5042002`)
- Deployer: `0xD0C8B6025789aA6AB05d171AB0a6776fEAA6D1fc`
- Validation: all deployment receipts succeeded, every new address returned non-empty runtime code, and each runtime bytecode matched the local release artifact
- Source verification: fully verified on ArcScan with Solidity `v0.8.35+commit.47b9dedd`
- Recheck command: `npm run verify-security-deployments`

| Contract | Previous address | Hardened address | Deployment transaction |
| --- | --- | --- | --- |
| ArcExpenseSplitter | `0xccd4bad1f974fda2167a7060942916bf3c148d93` | `0x746ec074273f916b6a74d1db117a77ff6bdbd860` | `0x30039db61003c9d6c3d1cd18fd54b0897289154b7d7d68bcc6789096da662c12` |
| ArcEventTickets | `0xca0ef47f4ab7be8d0a290186666f8b37af9856d7` | `0xd2b0af66cb7f9b41e620defa4f40c64de8723d43` | `0xa1a6c726f197a3c925f54db0f291253b7e00c8ba1e4e7d86b9d18556ecc5b57a` |
| ArcMarketplaceOrders | `0x899b12725e72e343d442a3ff628117cdda353b87` | `0xaa0f773d76cc6f52c88f889d0defad5afbb6a753` | `0x58c788a64f265fefab1132583ea090ff42216c7bb1eb0e93d8fd86af1f4694e1` |
| ArcServiceBookings | `0x1f99c4b86918d1b3ae6635392800dd1ecadf6352` | `0xa7a17b35c1a5e85a98513e63134983d2eed0e72b` | `0x13f466c37d798c26f32a47413ba0c6e226bf6939e418416f2697b13bfb0eba0c` |
| ArcDonationJar | `0x9a677c873ca846c55175aad7c0be8a299e325870` | `0x53998bd1060dbe9950019719087088eda9eaa3ae` | `0x1b9607e130856c85a11e42579467ffeaa673dae7a52a559a5783dfb44b38c1d7` |
| ArcPreorderStore | `0x7c97d3eff8681ea4c7bb3354d1b4d827141934e9` | `0x3128486261a2222147fa1deb473e35aebe08d069` | `0x845dc59383b9cc2febaa8fb93539e8a5b746e63e482ebb69bca8c57d8c013913` |
| ArcRefundableDeposit | `0xcad7f2503eb90e38063aa2385fc4616db0e9f147` | `0xf307c49d66189849e9cf2ee5a370af030614c936` | `0x755c1440564f0bf79789d1597eed3a2b01769bc7a3db5b1275c354ebb03c4ead` |
| ArcAuctionHouse | none recorded | `0x239d4963e7df648204b912621f8d0f823b55399b` | `0xdeb98c0d505afcedb2083e62c2399e09bdd459ddc4f4e0f1bf71c2682de586c5` |
| ArcRentalEscrow | `0x69177a3ce61b80e28709a1a9f873ec1a23d77076` | `0x62592aa9af5edd5a72f01ea23366cdb001e99217` | `0x51dc4aa2abb52551c2c160990cd50080f9b79b7213d4ba642c801588ae1e9829` |
| ArcAirdropCampaign | `0xd4eed3efcd2f5f0a5005ee90e5b7de77786b718f` | `0x5E67aB874F36897f559F141D47Fc0d4bCDe70209` | `0x8220982abb5ad64da8e8d1f2a017d240a51be5102103320eea9d0a3484a2f663` |

Previous deployments remain immutable on-chain. They held zero native USDC at migration time and should no longer be used by the local UI or routine scripts.

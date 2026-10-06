import type { RadarNetwork } from "./arc-radar-networks.js";

export type VenueReference = {
  id: string; name: string; network: string; kind: "dex" | "launchpad";
  status: "configured" | "announced"; evidence: "indexed" | "arc-announcement" | "self-announcement" | "official-deployment";
  sourceId?: string; url: string; checkedAt: string;
  deployment?: { emitter: string; protocol: string };
};

// Announcements are references only. They cannot enable an adapter or a trading link.
export const VENUE_REFERENCES: readonly VenueReference[] = [
  { id: "arc-usdc-v2", name: "Arc USDC v2-style pools", network: "arc-testnet", kind: "dex", status: "configured", evidence: "indexed",
    sourceId: "arc-usdc-v2", deployment: { emitter: "0x7483847D46Db2920DD64eFa676CF72dcF765814f", protocol: "uniswap-v2" },
    url: "https://testnet.arcscan.app/address/0x7483847D46Db2920DD64eFa676CF72dcF765814f", checkedAt: "2026-09-15" },
  { id: "uniswap-arc", name: "Uniswap v4", network: "arc-mainnet", kind: "dex", status: "configured", evidence: "official-deployment",
    sourceId: "uniswap-v4-arc", deployment: { emitter: "0x8366a39CC670B4001A1121B8F6A443A643e40951", protocol: "uniswap-v4" },
    url: "https://developers.uniswap.org/docs/protocols/v4/deployments#arc-5042", checkedAt: "2026-09-16" },
  { id: "uniswap-v3-arc", name: "Uniswap v3", network: "arc-mainnet", kind: "dex", status: "configured", evidence: "official-deployment",
    sourceId: "uniswap-v3-arc", deployment: { emitter: "0xf0db7b58379503491d857db50ac9ece64c653918", protocol: "uniswap-v3" },
    url: "https://github.com/Uniswap/contracts/blob/main/deployments/json/5042.json", checkedAt: "2026-09-16" },
  { id: "parabola-arc", name: "Parabola", network: "arc-mainnet", kind: "launchpad", status: "announced", evidence: "self-announcement",
    url: "https://parabola.meme/", checkedAt: "2026-09-15" },
];

export function configuredVenue(network: RadarNetwork, sourceId: string): VenueReference | undefined {
  return VENUE_REFERENCES.find(venue => venue.status === "configured" && venue.network === network.id && venue.sourceId === sourceId
    && network.sources.some(source => source.id === sourceId && source.protocol === venue.deployment?.protocol
      && source.factoryAddress.toLowerCase() === venue.deployment?.emitter.toLowerCase()));
}

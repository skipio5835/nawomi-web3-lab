type PoolIdentity = { pairAddress: string; v4?: { poolId: string } };

export function poolRef(pool: PoolIdentity): string {
  return pool.v4 ? `v4:${pool.pairAddress}:${pool.v4.poolId}`.toLowerCase() : pool.pairAddress.toLowerCase();
}

export function validPoolRef(value: string): boolean {
  return /^(?:0x[\da-f]{40}|v4:0x[\da-f]{40}:0x[\da-f]{64})$/i.test(value);
}

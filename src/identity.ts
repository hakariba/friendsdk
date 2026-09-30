import { isAddress, parseAbi, type Address, type PublicClient } from "viem";
import { GENERATION_SPRITE_MANIFEST } from "./generation-sprites.js";

export const GENERATION_ELIGIBILITY_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function generation(uint256 tokenId) view returns (uint8)",
]);
export type GenerationIdentityClient = Pick<PublicClient, "readContract" | "getChainId" | "getBlockNumber">;
export type GenerationDeployment = Readonly<{
  chainId: number;
  generations: Address;
  /** First possible Transfer block. Omit only when the deployment block is unknown. */
  transferStartBlock?: bigint;
}>;

/** Fresh ownership of a hardwired Generations NFT. Artwork and activation confer no permission. */
export async function readGenerationEligibility(
  client: GenerationIdentityClient, tokenId: bigint, player?: Address,
  deployment: GenerationDeployment = GENERATION_SPRITE_MANIFEST,
) {
  if (typeof tokenId !== "bigint" || tokenId < 1n || tokenId >= 1n << 256n) throw new RangeError("Token ID must fit uint256 and be positive.");
  if (player !== undefined && !isAddress(player)) throw new TypeError("Invalid player address.");
  if (await client.getChainId() !== deployment.chainId) throw new Error(`Eligibility requires chain ${deployment.chainId}.`);
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const [owner, generation] = await Promise.all([
    client.readContract({ address: deployment.generations, abi: GENERATION_ELIGIBILITY_ABI,
      functionName: "ownerOf", args: [tokenId], blockNumber }),
    client.readContract({ address: deployment.generations, abi: GENERATION_ELIGIBILITY_ABI,
      functionName: "generation", args: [tokenId], blockNumber }),
  ]);
  const hardwired = generation >= 1;
  const ownedByPlayer = player === undefined ? null : owner.toLowerCase() === player.toLowerCase();
  return { owner, generation, hardwired, ownedByPlayer,
    eligible: ownedByPlayer === null ? null : ownedByPlayer && hardwired, blockNumber } as const;
}

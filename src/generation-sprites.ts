import { parseAbi, type Address, type PublicClient } from "viem";

/** A pinned artwork version. Generations.setRenderer can select a different version later. */
export const GENERATION_SPRITE_MANIFEST = Object.freeze({
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  generations: "0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D" as Address,
  /** First Transfer emitted by the canonical Generations collection. */
  transferStartBlock: 63_102_373n,
  metadata: "0x3A243E7f46970275CaE8375b0032e53dF91a9110" as Address,
  registry: "0x246E3E9730A7Eade94c79be0Fd78d210f89AEb8D" as Address,
  worldData: "0xB78F68992d4c61c491EDCCa7890a05e7DBeb3970" as Address,
  seededLandscape: "0x450E3a18cb4d0264C61ff6468FC988FD9F78967D" as Address,
});

export type GenerationSpriteManifest = Readonly<{
  chainId: number; rpcUrl: string; generations: Address; transferStartBlock?: bigint;
  metadata: Address; registry: Address; worldData: Address; seededLandscape: Address;
}>;
export const FAMILIES_REGISTRY_ABI = parseAbi([
  "function familyOf(uint256 tokenId) pure returns (uint8)",
  "function seedOf(uint256 tokenId) pure returns (uint32)",
  "function familyName(uint8 id) pure returns (string)",
  "function module(uint8 id) view returns (address)",
  "function portrait(uint8 id, uint32 seed) view returns (uint256)",
  "function frames(uint8 id, uint32 seed) view returns (uint256[64])",
  "function sceneFrames(uint8 id, uint32 seed) view returns (uint256[64])",
]);
export const GENERATION_FAMILY_NAMES = Object.freeze([
  "Skeleton", "Mask", "Family", "Cellular", "Asymmetry", "Hoverer", "Colossus", "Sparkling", "Hollow",
] as const);
export const SPRITE_FACINGS = Object.freeze(["down", "up", "left", "right"] as const);
export type SpriteFacing = typeof SPRITE_FACINGS[number];
export type SpriteFrame = Readonly<{ bitmap: bigint; rows: readonly string[] }>;
type SpriteClips = Readonly<Record<SpriteFacing, readonly SpriteFrame[]>>;
export type GenerationSprites = Readonly<{
  tokenId: bigint;
  familyId: number;
  familyName: typeof GENERATION_FAMILY_NAMES[number];
  seed: number;
  frames: readonly bigint[];
  clips: Readonly<{ idle: SpriteClips; walk: SpriteClips }>;
  cacheKey: string;
}>;
export type GenerationSpriteClient = Pick<PublicClient, "readContract" | "getChainId">;

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_CACHE_ENTRIES = 64;

function validateTokenId(tokenId: bigint) {
  if (typeof tokenId !== "bigint" || tokenId < 1n || tokenId > MAX_UINT256) {
    throw new RangeError("Token ID must be an integer from 1 through uint256 max.");
  }
}

async function assertChain(client: GenerationSpriteClient, manifest: GenerationSpriteManifest) {
  if (await client.getChainId() !== manifest.chainId) {
    throw new Error(`Sprites require chain ${manifest.chainId}.`);
  }
}

/** Bit 0 is the top-left pixel; bit 255 is the bottom-right. No mirroring or cropping. */
export function decodeSpriteBitmap(bitmap: bigint): SpriteFrame {
  if (typeof bitmap !== "bigint" || bitmap < 0n || bitmap > MAX_UINT256) {
    throw new RangeError("A sprite bitmap must fit uint256.");
  }
  const rows = Array.from({ length: 16 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => bitmap & (1n << BigInt(y * 16 + x)) ? "#" : ".").join(""));
  return Object.freeze({ bitmap, rows: Object.freeze(rows) });
}

export function generationSpriteCacheKey(tokenId: bigint, manifest: GenerationSpriteManifest = GENERATION_SPRITE_MANIFEST) {
  validateTokenId(tokenId);
  return `${manifest.chainId}:${manifest.registry.toLowerCase()}:${tokenId}`;
}

/** Build all eight clips without inventing the missing Colossus directions. */
export function decodeGenerationSprites(
  tokenId: bigint, familyId: number, seed: number, bitmaps: readonly bigint[],
  manifest: GenerationSpriteManifest = GENERATION_SPRITE_MANIFEST,
): GenerationSprites {
  validateTokenId(tokenId);
  if (!Number.isInteger(familyId) || familyId < 0 || familyId >= GENERATION_FAMILY_NAMES.length) {
    throw new RangeError("Unknown sprite family.");
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError("Seed must fit uint32.");
  if (bitmaps.length !== 64) throw new RangeError("The registry must return exactly 64 frames.");
  const decoded = bitmaps.map(decodeSpriteBitmap);
  const clips = (offset: number): SpriteClips => Object.freeze(Object.fromEntries(
    SPRITE_FACINGS.map((facing, index) => [facing, Object.freeze(decoded.slice(offset + index * 8, offset + index * 8 + 8))]),
  ) as Record<SpriteFacing, readonly SpriteFrame[]>);
  return Object.freeze({
    tokenId, familyId, familyName: GENERATION_FAMILY_NAMES[familyId], seed,
    frames: Object.freeze([...bitmaps]), clips: Object.freeze({ idle: clips(0), walk: clips(32) }),
    cacheKey: generationSpriteCacheKey(tokenId, manifest),
  });
}

/** For vertical Colossus motion, retain the last horizontal direction (right by default). */
export function spriteFrame(
  sprites: GenerationSprites, facing: SpriteFacing, walking: boolean, frame: number,
  sideFallback: "left" | "right" = "right",
) {
  if (!SPRITE_FACINGS.includes(facing)) throw new RangeError("Unknown sprite direction.");
  if (!Number.isInteger(frame) || frame < 0 || frame > 7) throw new RangeError("Frame must be from 0 through 7.");
  if (sideFallback !== "left" && sideFallback !== "right") throw new RangeError("Fallback must face left or right.");
  const usedFallback = sprites.familyId === 6 && (facing === "down" || facing === "up");
  const resolvedFacing = usedFallback ? sideFallback : facing;
  return { frame: sprites.clips[walking ? "walk" : "idle"][resolvedFacing][frame],
    requestedFacing: facing, resolvedFacing, usedFallback } as const;
}

/** Inject a viem public client. Only immutable art is cached; errors are retryable. */
export function createGenerationSpriteReader(
  client: GenerationSpriteClient, manifest: GenerationSpriteManifest = GENERATION_SPRITE_MANIFEST,
) {
  const cache = new Map<string, Promise<GenerationSprites>>();
  return {
    async read(tokenId: bigint): Promise<GenerationSprites> {
      const key = generationSpriteCacheKey(tokenId, manifest);
      // Check even on cache hits, since an injected wallet transport may change chain.
      await assertChain(client, manifest);
      let result = cache.get(key);
      if (result) {
        cache.delete(key);
        cache.set(key, result);
        return result;
      }
      result = (async () => {
        const [familyId, seed] = await Promise.all([
          client.readContract({ address: manifest.registry, abi: FAMILIES_REGISTRY_ABI, functionName: "familyOf", args: [tokenId] }),
          client.readContract({ address: manifest.registry, abi: FAMILIES_REGISTRY_ABI, functionName: "seedOf", args: [tokenId] }),
        ]);
        const frames = await client.readContract({ address: manifest.registry, abi: FAMILIES_REGISTRY_ABI,
          functionName: "frames", args: [familyId, seed] });
        return decodeGenerationSprites(tokenId, familyId, seed, frames, manifest);
      })();
      cache.set(key, result);
      void result.catch(() => { if (cache.get(key) === result) cache.delete(key); });
      if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      return result;
    },
    clear() { cache.clear(); },
  };
}

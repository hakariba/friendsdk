import { isAddress, parseAbi, parseAbiItem, zeroAddress, type Address, type PublicClient } from "viem";
import { GENERATION_SPRITE_MANIFEST } from "./generation-sprites.js";
import type { GenerationDeployment } from "./identity.js";

export type OwnedFriendsClient = Pick<PublicClient, "getLogs" | "readContract" | "getBlockNumber" | "getChainId">;
export type OwnedFriend = Readonly<{
  id: bigint; label: string; kind: "owned"; walletAddress: Address; generation: number;
}>;
export type OwnedFriendsOptions = Readonly<{
  deployment?: GenerationDeployment;
  signal?: AbortSignal;
}>;

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function generation(uint256 tokenId) view returns (uint8)",
  "function tokenBoundAccount(uint256 tokenId) view returns (address)",
]);
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const validAddress = (value: unknown): value is Address => typeof value === "string" && isAddress(value) && !equal(value, zeroAddress);
const validId = (value: unknown): value is bigint => typeof value === "bigint" && value > 0n && value < 1n << 256n;
const MAX_TRANSFER_LOGS = 100_000;
const MAX_OWNED_FRIENDS = 10_000;
/** The public Robinhood RPC accepts at most ten million inclusive blocks per log query. */
const MAX_TRANSFER_BLOCKS_PER_QUERY = 10_000_000n;

/**
 * Read-only discovery using paginated indexed, owner-filtered Transfer queries. The
 * canonical Generations contract has no ERC721Enumerable owner enumeration.
 * Only currently held IDs are read; totalMinted and global token scans are never
 * used. Providers must support the filtered history query without truncation.
 * Failures remain errors, never an empty/ineligible result or a scan fallback.
 *
 * This selection snapshot is not lasting authorization. The trusted wrapper
 * must freshly call readGenerationEligibility before enabling the selected game.
 */
export async function readOwnedFriends(
  client: OwnedFriendsClient, account: Address, options: OwnedFriendsOptions = {},
): Promise<Readonly<{ friends: readonly OwnedFriend[]; blockNumber: bigint; hiddenCount: number }>> {
  const deployment = options.deployment ?? GENERATION_SPRITE_MANIFEST;
  if (!validAddress(account)) throw new TypeError("Owned Friend discovery requires a nonzero connected account.");
  if (!validAddress(deployment.generations) || !Number.isSafeInteger(deployment.chainId) || deployment.chainId < 1) {
    throw new TypeError("Invalid Generations deployment.");
  }
  const transferStartBlock = deployment.transferStartBlock ?? 0n;
  if (typeof transferStartBlock !== "bigint" || transferStartBlock < 0n) {
    throw new TypeError("Invalid Generations transfer start block.");
  }
  const active = () => options.signal?.throwIfAborted();
  async function checkChain() {
    active();
    if (await client.getChainId() !== deployment.chainId) throw new Error(`Friend discovery requires chain ${deployment.chainId}.`);
    active();
  }
  await checkChain();
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  active();
  if (transferStartBlock > blockNumber) throw new Error("Generations transfer history starts after the discovery snapshot.");
  const balance = await client.readContract({ address: deployment.generations, abi: ABI,
    functionName: "balanceOf", args: [account], blockNumber });
  active();
  if (typeof balance !== "bigint" || balance < 0n || balance > BigInt(MAX_OWNED_FRIENDS)) {
    throw new Error(`Friend discovery supports up to ${MAX_OWNED_FRIENDS} NFTs per connected account.`);
  }
  if (balance === 0n) {
    await checkChain();
    return Object.freeze({ friends: Object.freeze([]), blockNumber, hiddenCount: 0 });
  }

  const pages = [];
  try {
    for (let fromBlock = transferStartBlock; fromBlock <= blockNumber; fromBlock += MAX_TRANSFER_BLOCKS_PER_QUERY) {
      active();
      const pageEnd = fromBlock + MAX_TRANSFER_BLOCKS_PER_QUERY - 1n;
      const toBlock = pageEnd < blockNumber ? pageEnd : blockNumber;
      const query = { address: deployment.generations, event: TRANSFER, fromBlock, toBlock, strict: true } as const;
      pages.push(await Promise.all([
        client.getLogs({ ...query, args: { to: account } }),
        client.getLogs({ ...query, args: { from: account } }),
      ]));
      active();
    }
  } catch (cause) {
    active();
    throw new Error("Could not load this account's Friend transfers. Retry with an RPC that supports owner-filtered history; the SDK will not scan the collection.", { cause });
  }
  const received = pages.flatMap(([page]) => page);
  const sent = pages.flatMap(([, page]) => page);
  active();
  if (received.length + sent.length > MAX_TRANSFER_LOGS) {
    throw new Error("This account's Friend transfer history exceeds the discovery limit; use an indexed account provider.");
  }
  // A transfer to self appears in both queries. Deduplicate by its chain position.
  const events = new Map<string, typeof received[number]>();
  for (const log of [...received, ...sent]) {
    const { from, to, tokenId } = log.args;
    if (!equal(log.address, deployment.generations) || log.removed ||
        log.blockNumber === null || log.blockNumber < 0n || log.blockNumber > blockNumber ||
        log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 ||
        !isAddress(from) || !isAddress(to) || !validId(tokenId) ||
        (!equal(from, account) && !equal(to, account))) {
      throw new Error("RPC returned invalid owner-filtered Friend transfer history. Retry discovery.");
    }
    const key = `${log.blockNumber}:${log.logIndex}`;
    const previous = events.get(key);
    if (previous && (previous.args.tokenId !== tokenId || !equal(previous.args.from, from) || !equal(previous.args.to, to))) {
      throw new Error("RPC returned conflicting Friend transfer history. Retry discovery.");
    }
    events.set(key, log);
  }
  const ordered = [...events.values()].sort((a, b) =>
    a.blockNumber! === b.blockNumber! ? a.logIndex! - b.logIndex! : a.blockNumber! < b.blockNumber! ? -1 : 1);
  const held = new Set<bigint>();
  for (const log of ordered) {
    if (equal(log.args.to, account)) held.add(log.args.tokenId);
    else held.delete(log.args.tokenId);
  }
  if (BigInt(held.size) !== balance) {
    throw new Error("Friend transfer history is incomplete or changed. Retry with a complete owner-filtered RPC history.");
  }

  const ids = [...held].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const friends: OwnedFriend[] = [];
  // Bound concurrent RPC reads even for accounts with many owned NFTs.
  for (let offset = 0; offset < ids.length; offset += 8) {
    active();
    const group = await Promise.all(ids.slice(offset, offset + 8).map(async id => {
      const [owner, generation] = await Promise.all([
        client.readContract({ address: deployment.generations, abi: ABI, functionName: "ownerOf", args: [id], blockNumber }),
        client.readContract({ address: deployment.generations, abi: ABI, functionName: "generation", args: [id], blockNumber }),
      ]);
      active();
      if (!validAddress(owner) || !equal(owner, account)) throw new Error("Friend ownership changed or transfer history is inconsistent. Retry discovery.");
      if (!Number.isInteger(generation) || generation < 0 || generation > 255) throw new Error("RPC returned an invalid Friend generation.");
      if (generation < 1) return null;
      const walletAddress = await client.readContract({ address: deployment.generations, abi: ABI,
        functionName: "tokenBoundAccount", args: [id], blockNumber });
      active();
      if (!validAddress(walletAddress)) throw new Error("Generations returned an invalid canonical Friend wallet.");
      return Object.freeze({ id, label: `Friend #${id}`, kind: "owned" as const, walletAddress, generation });
    }));
    friends.push(...group.filter(friend => friend !== null));
  }
  await checkChain();
  return Object.freeze({ friends: Object.freeze(friends), blockNumber, hiddenCount: ids.length - friends.length });
}

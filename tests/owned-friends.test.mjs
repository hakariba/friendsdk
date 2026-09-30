import assert from 'node:assert/strict';
import test from 'node:test';
import { readOwnedFriends } from '../dist/owned-friends.js';
import { GENERATION_SPRITE_MANIFEST } from '../dist/generation-sprites.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const WALLET = '0x3333333333333333333333333333333333333333';
const ZERO = '0x0000000000000000000000000000000000000000';
const COLLECTION = GENERATION_SPRITE_MANIFEST.generations;
const START = GENERATION_SPRITE_MANIFEST.transferStartBlock;
const PAGE_BLOCKS = 10_000_000n;
const event = (id, from, to, blockNumber, logIndex = 0) => ({
  address: COLLECTION, args: { tokenId: id, from, to }, blockNumber, logIndex, removed: false,
});

function fixture() {
  const state = { chain: 4663, block: START + 100n, balance: 3n, owner: OWNER, badWallet: false, logError: null,
    logs: [event(1n, ZERO, OWNER, START + 1n), event(2n, ZERO, OWNER, START + 2n),
      event(1n, OWNER, OTHER, START + 3n), event(3n, ZERO, OWNER, START + 4n),
      event(2n, OWNER, OWNER, START + 5n), event(4n, ZERO, OWNER, START + 6n)],
    generations: new Map([[2n, 2], [3n, 0], [4n, 1]]) };
  const calls = [];
  const client = {
    async getChainId() { return state.chain; },
    async getBlockNumber(options) { assert.equal(options.cacheTime, 0); return state.block; },
    async getLogs(call) {
      calls.push({ method: 'getLogs', ...call });
      if (state.logError) throw state.logError;
      assert.equal(call.address, COLLECTION);
      assert.equal(call.event.name, 'Transfer');
      assert.equal(call.strict, true);
      assert.equal(Object.keys(call.args).length, 1);
      assert.equal(Object.values(call.args)[0], OWNER);
      return state.logs.filter(log => log.blockNumber >= call.fromBlock && log.blockNumber <= call.toBlock &&
        Object.entries(call.args).every(([field, value]) => log.args[field] === value)).reverse();
    },
    async readContract(call) {
      calls.push({ method: 'readContract', ...call });
      assert.equal(call.blockNumber, state.block);
      assert.equal(call.address, COLLECTION);
      if (call.functionName === 'balanceOf') { assert.deepEqual(call.args, [OWNER]); return state.balance; }
      if (call.functionName === 'ownerOf') return state.owner;
      if (call.functionName === 'generation') return state.generations.get(call.args[0]);
      if (call.functionName === 'tokenBoundAccount') return state.badWallet ? ZERO : WALLET;
      throw new Error('Unexpected full-collection or state-changing operation');
    },
  };
  return { state, calls, client };
}

test('discovers only owner-filtered held IDs, handles self transfers, excludes generation zero, and uses canonical wallets', async () => {
  const f = fixture();
  const result = await readOwnedFriends(f.client, OWNER);
  assert.equal(result.blockNumber, START + 100n);
  assert.equal(result.hiddenCount, 1);
  assert.deepEqual(result.friends, [
    { id: 2n, label: 'Friend #2', kind: 'owned', walletAddress: WALLET, generation: 2 },
    { id: 4n, label: 'Friend #4', kind: 'owned', walletAddress: WALLET, generation: 1 },
  ]);
  const logs = f.calls.filter(call => call.method === 'getLogs');
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map(call => [call.fromBlock, call.toBlock]), [[START, START + 100n], [START, START + 100n]]);
  assert.deepEqual(logs.map(call => call.args), [{ to: OWNER }, { from: OWNER }]);
  assert.deepEqual(f.calls.filter(call => call.functionName === 'ownerOf').map(call => call.args[0]), [2n, 3n, 4n]);
  assert.deepEqual(f.calls.filter(call => call.functionName === 'tokenBoundAccount').map(call => call.args[0]), [2n, 4n]);
  assert.throws(() => result.friends.push({}), TypeError);
});

test('paginates canonical owner-filtered history at the public RPC block limit', async () => {
  const f = fixture();
  f.state.block = START + PAGE_BLOCKS + 5n;
  f.state.logs[2] = event(1n, OWNER, OTHER, START + PAGE_BLOCKS + 1n);
  const result = await readOwnedFriends(f.client, OWNER);
  assert.deepEqual(result.friends.map(friend => friend.id), [2n, 4n]);
  const logs = f.calls.filter(call => call.method === 'getLogs');
  assert.deepEqual(logs.map(call => [call.fromBlock, call.toBlock, call.args]), [
    [START, START + PAGE_BLOCKS - 1n, { to: OWNER }],
    [START, START + PAGE_BLOCKS - 1n, { from: OWNER }],
    [START + PAGE_BLOCKS, START + PAGE_BLOCKS + 5n, { to: OWNER }],
    [START + PAGE_BLOCKS, START + PAGE_BLOCKS + 5n, { from: OWNER }],
  ]);
});

test('custom deployments without a known transfer start retain block-zero discovery', async () => {
  const f = fixture();
  f.state.block = 100n;
  f.state.logs = f.state.logs.map(log => ({ ...log, blockNumber: log.blockNumber - START }));
  const result = await readOwnedFriends(f.client, OWNER, {
    deployment: { chainId: GENERATION_SPRITE_MANIFEST.chainId, generations: COLLECTION },
  });
  assert.deepEqual(result.friends.map(friend => friend.id), [2n, 4n]);
  assert.deepEqual(f.calls.filter(call => call.method === 'getLogs').map(call => [call.fromBlock, call.toBlock]),
    [[0n, 100n], [0n, 100n]]);
});

test('zero NFT balance requires no history or per-token reads', async () => {
  const f = fixture(); f.state.balance = 0n;
  const result = await readOwnedFriends(f.client, OWNER);
  assert.deepEqual(result.friends, []);
  assert.equal(result.hiddenCount, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].functionName, 'balanceOf');
});

test('refused log range and truncated history remain errors without collection scan fallback', async () => {
  const f = fixture(); f.state.logError = new Error('RPC range too wide');
  await assert.rejects(readOwnedFriends(f.client, OWNER), /owner-filtered history/);
  assert.equal(f.calls.filter(call => call.method === 'getLogs').length, 2);
  assert.equal(f.calls.filter(call => call.functionName === 'ownerOf').length, 0);
  f.state.logError = null; f.state.logs = [];
  await assert.rejects(readOwnedFriends(f.client, OWNER), /incomplete/);
  assert.equal(f.calls.filter(call => call.functionName === 'ownerOf').length, 0);
});

test('fresh calls reread eligibility and reject ownership, wallet, and network failures', async () => {
  const f = fixture();
  await readOwnedFriends(f.client, OWNER);
  f.state.owner = OTHER;
  await assert.rejects(readOwnedFriends(f.client, OWNER), /ownership changed/);
  f.state.owner = OWNER; f.state.badWallet = true;
  await assert.rejects(readOwnedFriends(f.client, OWNER), /canonical Friend wallet/);
  f.state.badWallet = false; f.state.chain = 1;
  await assert.rejects(readOwnedFriends(f.client, OWNER), /chain 4663/);
});

test('invalid addresses, malformed events and aborted discovery fail closed', async () => {
  const f = fixture();
  for (const account of [ZERO, '0x123', undefined]) await assert.rejects(readOwnedFriends(f.client, account), /connected account/);
  assert.equal(f.calls.length, 0);
  f.state.logs[0] = { ...f.state.logs[0], removed: true };
  await assert.rejects(readOwnedFriends(f.client, OWNER), /invalid owner-filtered/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readOwnedFriends(f.client, OWNER, { signal: abort.signal }), { name: 'AbortError' });
});

test('cancellation while discovery is pending never returns an old account result', async () => {
  const f = fixture(), abort = new AbortController();
  const original = f.client.getLogs;
  f.client.getLogs = async call => { const logs = await original(call); abort.abort(); return logs; };
  await assert.rejects(readOwnedFriends(f.client, OWNER, { signal: abort.signal }), { name: 'AbortError' });
  assert.equal(f.calls.filter(call => call.functionName === 'ownerOf').length, 0);
});

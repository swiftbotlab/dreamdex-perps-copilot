/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Trading-key mode: a bot key that trades FOR a DreamDEX account.
//
// The app's wallet widget links a bot key to one account (wallet → Link a bot →
// Perps). That writes an operator grant to the OperatorPermissionsRegistry for
// three functions on every perp pool: placeOrderFor, cancelOrderFor and
// reduceOrderFor. The key then sends `placeOrderFor(owner, …)` and the order is
// the account's: its margin locks from the account's MarginBank balance and
// every fill settles to the account. The key pays gas and nothing else, and it
// cannot withdraw.
//
// The markets SDK has no perp `…For` writes, so the three calls are sent here
// with viem. Reads stay on the SDK, pointed at the owner's address.

import {
  contractErrorsAbi,
  decodePlaceOrder,
  type OrderFill,
} from "@somnia-chain/markets-sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  type Chain,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** The three selectors a trading key is granted, as the registry keys them. */
export const TRADING_KEY_SELECTOR = {
  placeOrderFor: "0x80054449",
  cancelOrderFor: "0xe37b444b",
  reduceOrderFor: "0x364c2587",
} as const;

const OPERATOR_ABI = [
  ...parseAbi([
    "function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
    "function cancelOrderFor(address owner, uint128 orderId)",
    "function reduceOrderFor(address owner, uint128 orderId, uint256 newQuantityRemaining)",
    "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
  ]),
  // The pool reverts with named errors (`ImmediateOrCancelNoFill`,
  // `PostOnlyWouldCross`, `OnlyApprovedContracts`, …). With them in the ABI the
  // simulation error carries the name, which the order path matches on.
  ...contractErrorsAbi,
] as const;

/** The same gas the SDK sends a perp order with. Somnia bills gas used, not the limit. */
const ORDER_GAS = 10_000_000n;

/** The SDK's resting-order expiry: fifty years out, in nanoseconds. */
function farFutureNs(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 50 * 365 * 24 * 3600) * 1_000_000_000n;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** A bot key acting for one account. */
export interface TradingKey {
  /** The DreamDEX account the orders belong to. */
  owner: `0x${string}`;
  /** The bot key's own address: the operator the account granted. */
  operator: `0x${string}`;
  account: PrivateKeyAccount;
  publicClient: PublicClient;
  walletClient: WalletClient;
  /**
   * The nonce after this key's last transaction that a node accepted (kept by `send()`). The node's pending
   * count wins when it is higher; cleared when a post or a receipt wait fails, so the node decides again.
   */
  nextNonce?: number;
}

export function createTradingKey(opts: {
  owner: `0x${string}`;
  privateKey: `0x${string}`;
  chain: Chain;
  rpcUrl: string;
}): TradingKey {
  const account = privateKeyToAccount(opts.privateKey);
  if (account.address.toLowerCase() === opts.owner.toLowerCase()) {
    throw new Error(
      "OWNER_ADDRESS is this key's own address. Leave OWNER_ADDRESS blank to trade the key's own account, " +
        "or set it to the DreamDEX account this bot key is linked to.",
    );
  }
  // Both clients keep viem's default retries for reads (chain id, nonce, fees, simulation, receipts). The
  // signed transaction itself is posted by `send()` with `sendRawTransaction`, which viem never retries
  // (`retryCount: 0` per request), so one signed order is posted at most once.
  return {
    owner: opts.owner,
    operator: account.address,
    account,
    publicClient: createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) }) as PublicClient,
    walletClient: createWalletClient({ account, chain: opts.chain, transport: http(opts.rpcUrl) }),
  };
}

export interface LinkStatus {
  place: boolean;
  cancel: boolean;
  reduce: boolean;
}

/** What the pool itself says this key may do for the owner. The pool's answer is the one it enforces. */
export async function linkStatus(key: TradingKey, pool: `0x${string}`): Promise<LinkStatus> {
  const ask = (selector: `0x${string}`) =>
    key.publicClient.readContract({
      address: pool,
      abi: OPERATOR_ABI,
      functionName: "isOperatorAuthorized",
      args: [key.owner, key.operator, selector],
    }) as Promise<boolean>;
  const [place, cancel, reduce] = await Promise.all([
    ask(TRADING_KEY_SELECTOR.placeOrderFor),
    ask(TRADING_KEY_SELECTOR.cancelOrderFor),
    ask(TRADING_KEY_SELECTOR.reduceOrderFor),
  ]);
  return { place, cancel, reduce };
}

/** One line saying what to do when the key is not linked, or undefined when it is. */
export function linkProblem(key: TradingKey, status: LinkStatus, market: string): string | undefined {
  if (status.place && status.cancel) return undefined;
  const missing = [
    status.place ? undefined : "place",
    status.cancel ? undefined : "cancel",
    status.reduce ? undefined : "reduce",
  ].filter(Boolean);
  return (
    `This bot key (${key.operator}) cannot ${missing.join("/")} orders for ${key.owner} on ${market}. ` +
    "In the DreamDEX app open the wallet, choose Link a bot, tick Perps and paste this key's address. " +
    "A market listed after you linked needs the same address added again, which covers the new ones. " +
    "Check that OWNER_ADDRESS is the account you linked it on, and that NETWORK matches the app's network."
  );
}

/** Where a write failed. "simulate" and "prepare" mean nothing was posted. */
export type SendPhase = "simulate" | "prepare" | "send" | "wait" | "reverted" | "decode";

/**
 * A failed write, labelled with the step that failed:
 * - "simulate": the eth_call said it would revert; nothing was sent;
 * - "prepare": reading the nonce, fees or chain id, or signing, failed; nothing was posted;
 * - "send": posting the signed transaction failed; it may or may not have reached the chain (`hash` is known);
 * - "wait": the transaction was posted (`hash`) but its receipt did not arrive in time;
 * - "reverted": the receipt arrived with status reverted (`hash`);
 * - "decode": the transaction succeeded (`hash`) but its events could not be decoded.
 */
export class SendError extends Error {
  constructor(
    readonly phase: SendPhase,
    message: string,
    readonly hash?: `0x${string}`,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SendError";
  }
}

const RECEIPT_TIMEOUT_MS = 60_000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Serialises, per key, the part of a send that picks the nonce and posts; the receipt wait runs outside it. */
export type PostLock = <T>(f: () => Promise<T>) => Promise<T>;
const noLock: PostLock = (f) => f();

/**
 * Send a write the way the SDK does: simulate first, so a revert arrives as its named error. Then pick the
 * nonce, sign locally and hash the signed bytes BEFORE posting, so every outcome after the post carries the
 * transaction hash. `lock` covers simulate -> post only; waiting for the receipt does not hold it.
 */
async function send(
  key: TradingKey,
  pool: `0x${string}`,
  functionName: "placeOrderFor" | "cancelOrderFor" | "reduceOrderFor",
  args: readonly unknown[],
  lock: PostLock = noLock,
) {
  const hash = await lock(async () => {
    try {
      await key.publicClient.simulateContract({
        address: pool,
        abi: OPERATOR_ABI,
        functionName,
        args: args as never,
        account: key.account,
        gas: ORDER_GAS,
      });
    } catch (e) {
      throw new SendError("simulate", errText(e), undefined, { cause: e });
    }
    let serialized: `0x${string}`;
    let nonce: number;
    try {
      const pending = await key.publicClient.getTransactionCount({ address: key.operator, blockTag: "pending" });
      nonce = key.nextNonce !== undefined && key.nextNonce > pending ? key.nextNonce : pending;
      const request = await key.walletClient.prepareTransactionRequest({
        account: key.account,
        chain: key.walletClient.chain,
        to: pool,
        data: encodeFunctionData({ abi: OPERATOR_ABI, functionName, args: args as never }),
        gas: ORDER_GAS,
        nonce,
      } as never);
      // signTransaction also checks that the RPC's chain id is the configured chain's.
      serialized = (await key.walletClient.signTransaction({ ...(request as object), account: key.account, chain: key.walletClient.chain } as never)) as `0x${string}`;
    } catch (e) {
      throw new SendError("prepare", errText(e), undefined, { cause: e });
    }
    const h = keccak256(serialized);
    try {
      await key.walletClient.sendRawTransaction({ serializedTransaction: serialized });
    } catch (e) {
      key.nextNonce = undefined;
      throw new SendError("send", errText(e), h, { cause: e });
    }
    key.nextNonce = nonce + 1;
    return h;
  });
  let receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
  try {
    receipt = await key.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  } catch (e) {
    key.nextNonce = undefined;
    throw new SendError("wait", errText(e), hash, { cause: e });
  }
  if (receipt.status !== "success") {
    throw new SendError("reverted", `${functionName} REVERTED on-chain (tx ${hash}).`, hash);
  }
  return { hash, receipt };
}

export interface OperatorPlacement {
  hash: `0x${string}`;
  orderId?: bigint;
  fills: OrderFill[];
}

/** `placeOrderFor` on a perp pool, decoded the way the SDK decodes `placeOrder`. */
export async function placeFor(
  key: TradingKey,
  p: { pool: `0x${string}`; isBid: boolean; price: bigint; quantity: bigint; orderType: number },
  lock?: PostLock,
): Promise<OperatorPlacement> {
  const { hash, receipt } = await send(key, p.pool, "placeOrderFor", [
    key.owner,
    p.isBid,
    0n,
    p.price,
    p.quantity,
    farFutureNs(),
    p.orderType,
    0,
    ZERO_ADDRESS,
    0n,
  ], lock);
  try {
    const { orderId, fills } = decodePlaceOrder(receipt, p.pool);
    return { hash, orderId, fills };
  } catch (e) {
    throw new SendError("decode", errText(e), hash, { cause: e });
  }
}

/** `cancelOrderFor`: the order's collateral goes back to the owner, never to the key. */
export async function cancelFor(key: TradingKey, pool: `0x${string}`, orderId: bigint): Promise<`0x${string}`> {
  return (await send(key, pool, "cancelOrderFor", [key.owner, orderId])).hash;
}

/** `reduceOrderFor`: shrink a resting order to `newQuantityRemaining` without losing its queue place. */
export async function reduceFor(
  key: TradingKey,
  pool: `0x${string}`,
  orderId: bigint,
  newQuantityRemaining: bigint,
): Promise<`0x${string}`> {
  return (await send(key, pool, "reduceOrderFor", [key.owner, orderId, newQuantityRemaining])).hash;
}

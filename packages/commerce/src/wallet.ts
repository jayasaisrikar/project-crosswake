import { createHash } from 'node:crypto';
import { z } from 'zod';

export const authorizationRequestSchema = z
  .object({
    requirement: z
      .object({
        network: z.string(),
        asset: z.string(),
        payTo: z.string(),
        amount: z.string(),
        extra: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
    validAfter: z.number().int().nonnegative(),
    validBefore: z.number().int().positive(),
    nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  })
  .strict();
export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;

/** EIP-3009 `TransferWithAuthorization`, the scheme x402 `exact` uses on Base. */
export const authorizationSchema = z
  .object({
    from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    value: z.string(),
    validAfter: z.string(),
    validBefore: z.string(),
    nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  })
  .strict();
export type Authorization = z.infer<typeof authorizationSchema>;

export interface SignedPayment {
  signature: string;
  authorization: Authorization;
  /** Address that signed. */
  payer: string;
}

export interface WalletAdapter {
  readonly address: string;
  readonly network: string;
  balanceUsdc(): Promise<bigint>;
  signAuthorization(request: AuthorizationRequest): Promise<SignedPayment>;
}

/**
 * Deterministic in-process wallet for mock mode: no keys, no network, no chain.
 * It cannot be accidentally mistaken for on-chain money because mock settlement
 * evidence is labelled `source: 'mock'`.
 */
export function createMockWallet(
  label = 'crosswake-mock',
  balance: bigint = 5_000_000n,
): WalletAdapter {
  const address = `0x${createHash('sha256').update(label).digest('hex').slice(0, 40)}`;
  return {
    address,
    network: 'eip155:84532',
    async balanceUsdc() {
      return balance;
    },
    async signAuthorization(request) {
      const parsed = authorizationRequestSchema.parse(request),
        req = parsed.requirement,
        signed: Authorization = {
          from: address,
          to: String(req.payTo),
          value: String(req.amount),
          validAfter: String(parsed.validAfter),
          validBefore: String(parsed.validBefore),
          nonce: parsed.nonce,
        };
      return {
        authorization: signed,
        payer: address,
        signature: `0x${createHash('sha256')
          .update(
            JSON.stringify({
              address,
              authorization: signed,
              network: req.network,
              asset: req.asset,
            }),
          )
          .digest('hex')}1b`,
      };
    },
  };
}

/**
 * The EIP-712 typed data x402 `exact` signs on Base (EIP-3009
 * `TransferWithAuthorization`). Exported so the test suite can verify a
 * signature against the real structure rather than a copy of it.
 */
export function eip3009TypedData(input: {
  chainId: number;
  token: `0x${string}`;
  authorization: Authorization;
}) {
  return {
    domain: {
      name: 'USDC',
      version: '2',
      chainId: input.chainId,
      verifyingContract: input.token,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization' as const,
  };
}

export interface ViemWalletOptions {
  privateKey: `0x${string}`;
  network: 'eip155:84532' | 'eip155:8453';
  rpcUrl: string;
}

/**
 * Live wallet: EIP-712 typed-data signing for EIP-3009 via viem, plus an
 * ERC-20 `balanceOf` read. The private key is read from the environment by the
 * caller and never logged, traced, or handed to a model.
 *
 * Verified by the test suite: the derived address for a known test key, and the
 * EIP-712 domain and type list, by recovering the signer from the signature.
 * NOT verified: an on-chain settlement, which needs a funded testnet wallet and
 * a funded seller (see docs/agentic-commerce/testing.md).
 */
export async function createViemWallet(
  options: ViemWalletOptions,
): Promise<WalletAdapter> {
  const [{ privateKeyToAccount }, { createPublicClient, http, erc20Abi }] =
    await Promise.all([import('viem/accounts'), import('viem')]);
  const account = privateKeyToAccount(options.privateKey),
    chainId = Number(options.network.split(':')[1]),
    client = createPublicClient({ transport: http(options.rpcUrl) });
  const usdc = (network: string) =>
    network === 'eip155:84532'
      ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
      : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  return {
    address: account.address,
    network: options.network,
    async balanceUsdc() {
      const balance = await client.readContract({
        address: usdc(options.network) as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      return balance as bigint;
    },
    async signAuthorization(request) {
      const parsed = authorizationRequestSchema.parse(request),
        req = parsed.requirement,
        token = (req.asset ??
          usdc(parsed.requirement.network)) as `0x${string}`,
        signed: Authorization = {
          from: account.address,
          to: String(req.payTo),
          value: String(req.amount),
          validAfter: String(parsed.validAfter),
          validBefore: String(parsed.validBefore),
          nonce: parsed.nonce,
        },
        signature = await account.signTypedData({
          ...eip3009TypedData({ chainId, token, authorization: signed }),
          message: {
            from: account.address,
            to: req.payTo as `0x${string}`,
            value: BigInt(req.amount),
            validAfter: BigInt(parsed.validAfter),
            validBefore: BigInt(parsed.validBefore),
            nonce: parsed.nonce as `0x${string}`,
          },
        });
      return { signature, payer: account.address, authorization: signed };
    },
  };
}

/** Mainnet requires its own key, so a testnet key can never spend real money. */
export function mainnetPrivateKey(
  env: NodeJS.ProcessEnv = process.env,
): `0x${string}` | null {
  const key = env.COMMERCE_MAINNET_WALLET_PRIVATE_KEY?.trim();
  return key ? (key as `0x${string}`) : null;
}

export function testnetPrivateKey(
  env: NodeJS.ProcessEnv = process.env,
): `0x${string}` | null {
  const key = env.COMMERCE_TESTNET_WALLET_PRIVATE_KEY?.trim();
  return key ? (key as `0x${string}`) : null;
}

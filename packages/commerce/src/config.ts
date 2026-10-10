import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  commerceModeSchema,
  providerRegistrySchema,
  spendPolicySchema,
  type CommerceMode,
  type ProviderRegistry,
  type SpendPolicy,
} from './types.js';

export interface CommerceEnv {
  mode: CommerceMode;
  mainnetEnabled: boolean;
  dataDir: string;
  policyPath: string;
  registryPath: string;
}

export const DEFAULT_POLICY_PATH = 'configs/commerce/policy.json';
export const DEFAULT_REGISTRY_PATH = 'configs/commerce/providers.json';

/**
 * Mainnet is deliberately unreachable from configuration alone: it needs the
 * mode, the explicit enable flag, a separate mainnet key (checked by the wallet
 * factory) and a per-purchase human approval. Anything unset means mock.
 */
export function commerceEnv(env: NodeJS.ProcessEnv = process.env): CommerceEnv {
  const requested = commerceModeSchema.safeParse(env.COMMERCE_MODE ?? 'mock');
  if (!requested.success)
    throw new Error(`COMMERCE_MODE must be mock, testnet or mainnet`);
  const mainnetEnabled = env.COMMERCE_MAINNET_ENABLED === 'true';
  return {
    mode: requested.data,
    mainnetEnabled,
    dataDir: resolve(env.DATA_DIR ?? './data'),
    policyPath: resolve(env.COMMERCE_POLICY ?? DEFAULT_POLICY_PATH),
    registryPath: resolve(env.COMMERCE_REGISTRY ?? DEFAULT_REGISTRY_PATH),
  };
}

export async function loadPolicy(path: string): Promise<SpendPolicy> {
  return spendPolicySchema.parse(
    JSON.parse(await readFile(path, 'utf8')),
  ) as SpendPolicy;
}

export async function loadRegistry(path: string): Promise<ProviderRegistry> {
  return providerRegistrySchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

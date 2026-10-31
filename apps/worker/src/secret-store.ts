import type { RealtimeFanout, SecretStore } from "@rakazo/adapter-kit";
import type { VaultwardenStoreOptions } from "@rakazo/adapters";
import { createSecretStore } from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core";

/** Worker composition without starting job hosts or database connections. */
export async function createWorkerSecretStore(
  source: NodeJS.ProcessEnv,
  realtime?: RealtimeFanout,
  vaultwarden?: VaultwardenStoreOptions,
): Promise<SecretStore> {
  const store = createSecretStore(resolveEncryptionKey(source), source, realtime, vaultwarden);
  await store.start();
  return store;
}

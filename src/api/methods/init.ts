import type { ApiInitArgs, OnApiUpdate } from '../types';

import { IS_LEGENDS_WALLET, NO_MFA, NO_REFERRER, NO_STAKING, NO_SWAP } from '../../config';
import { parseAccountId } from '../../util/account';
import { initWindowConnector } from '../../util/windowProvider/connector';
import * as ton from '../chains/ton';
import { fetchStoredAccounts } from '../common/accounts';
import { callBackendPost, fetchBackendReferrer } from '../common/backend';
import { connectUpdater, disconnectUpdater, tryMigrateStorage } from '../common/helpers';
import { initClientId } from '../common/other';
import { getProtocolManager, initProtocolManager } from '../dappProtocols';
import { setEnvironment } from '../environment';
import { addHooks } from '../hooks';
import { configureStorage, createStorage, withStorage } from '../storages';
import { destroyPolling } from './polling';
import * as methods from '.';

export default async function init(onUpdate: OnApiUpdate, args: ApiInitArgs) {
  const runtimeStorage = createStorage(args.storage);

  configureStorage(args.storage);
  connectUpdater(onUpdate);

  const environment = setEnvironment(args);
  initWindowConnector();

  if (args.langCode) {
    await runtimeStorage.setItem('langCode', args.langCode);
  }

  await withStorage(runtimeStorage, async () => {
    await initClientId();
    await tryMigrateStorage(onUpdate, ton, args.accountIds);
  });

  methods.initAccounts(onUpdate);
  methods.initAuth(onUpdate);
  if (!NO_MFA) methods.initMfa(onUpdate);
  methods.initPolling(onUpdate);
  methods.initTransfer(onUpdate);
  methods.initTokens(onUpdate);
  if (!NO_STAKING) methods.initStaking();
  if (!NO_SWAP) methods.initSwap(onUpdate);
  methods.initNfts(onUpdate);

  if (IS_LEGENDS_WALLET) {
    void identifyWalletAccounts(args.accountIds);
  }

  await initProtocolManager(onUpdate, environment);

  if (environment.isDappSupported) {
    methods.initDapps(onUpdate);
  }

  const protocolManager = getProtocolManager();

  addHooks({
    onDappDisconnected: protocolManager.closeRemoteConnection.bind(protocolManager),
    onDappsChanged: protocolManager.resetupRemoteConnection.bind(protocolManager),
  });

  if (!NO_REFERRER) {
    void saveReferrer(args, runtimeStorage);
  }
}

async function identifyWalletAccounts(accountIds: string[] | undefined) {
  const accounts = await fetchStoredAccounts();
  await Promise.allSettled((accountIds ?? []).map(async (accountId) => {
    const account = accounts[accountId];
    if (!account?.byChain.tron || account.type === 'view') return;
    const { network } = parseAccountId(accountId);
    await callBackendPost<{ ok: true }>(
      `${network === 'testnet' ? '/testnet' : ''}/wallet-client/identify`,
      { address: account.byChain.tron.address },
      { timeout: 3_000 },
    );
  }));
}

export function destroy() {
  void destroyPolling();
  disconnectUpdater();
}

async function saveReferrer(args: ApiInitArgs, runtimeStorage: ReturnType<typeof createStorage>) {
  const referrer = args.referrer ?? await fetchBackendReferrer();

  if (referrer) {
    await runtimeStorage.setItem('referrer', referrer);
    await withStorage(runtimeStorage, async () => {
      await initClientId();
    });
  }
}

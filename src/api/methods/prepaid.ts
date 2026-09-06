import type { Types } from 'tronweb';

import type {
  ApiWalletBalanceIntegrationAuth,
  ApiWalletBalanceIntegrationProjects,
  ApiWalletPrepaidCoverageMode,
  ApiWalletPrepaidOverview,
} from '../types';

import { BRILLIANT_API_BASE_URL, TRX } from '../../config';
import { parseAccountId } from '../../util/account';
import { fetchJson } from '../../util/fetch';
import { pause } from '../../util/schedulers';
import { fetchPrivateKeyString } from '../chains/tron/auth';
import { ensureSponsoredTransactionTtl } from '../chains/tron/sponsorship';
import { getTronClient } from '../chains/tron/util/tronweb';
import { fetchStoredChainAccount } from '../common/accounts';
import { getTokenBySlug } from '../common/tokens';
import { ApiServerError } from '../errors';
import { storage } from '../storages';

type TopupQuote = {
  ok: true;
  quote_id: string;
  transaction: Types.Transaction;
};

type BalanceIntegrationChallenge = {
  challenge_id: string;
  memo: string;
  proof_address: string;
};

type PrepaidAccessChallenge = {
  challenge: string;
  memo: string;
  proof_address: string;
  expires_at: number;
};

type PrepaidAccessSession = {
  access_token: string;
  expires_at: number;
  refresh_token?: string;
  refresh_expires_at?: number;
};

const TOPUP_CONFIRMATION_POLL_MS = 2_000;
const TOPUP_CONFIRMATION_ATTEMPTS = 30;
const TERMINAL_TOPUP_FAILURES = new Set(['needs_review', 'failed', 'expired', 'refunded']);
const PREPAID_ACCESS_STORAGE_KEY = 'walletPrepaidAccessSessions';
const PREPAID_ACCESS_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const prepaidAccessSessions = new Map<string, PrepaidAccessSession>();
const prepaidAccessRequests = new Map<string, Promise<void>>();
let prepaidAccessStorageMutation = Promise.resolve();

function prepaidUrl(accountId: string, endpoint: string) {
  const { network } = parseAccountId(accountId);
  return `${BRILLIANT_API_BASE_URL}${network === 'testnet' ? '/testnet' : ''}/wallet-prepaid/${endpoint}`;
}

function fetchPrepaidJson<T extends AnyLiteral>(
  accountId: string,
  endpoint: string,
  data?: Parameters<typeof fetchJson>[1],
  init?: RequestInit,
  options?: Parameters<typeof fetchJson>[3],
) {
  const url = prepaidUrl(accountId, endpoint);
  return fetchJson<T>(url, data, init, { ...options, bucketKey: url });
}

async function getTronAccount(accountId: string) {
  const account = await fetchStoredChainAccount(accountId, 'tron');
  return { account, address: account.byChain.tron.address };
}

async function createWalletProof(
  accountId: string,
  enclaveToken: string,
  recipient: string,
  memo: string,
) {
  const { network } = parseAccountId(accountId);
  const { account, address } = await getTronAccount(accountId);
  if (account.type === 'view' || account.type === 'ledger') throw new Error('UnsupportedAccountType');
  const tronWeb = getTronClient(network);
  const initial = await tronWeb.transactionBuilder.sendTrx(recipient, 1, address);
  const withMemo = await tronWeb.transactionBuilder.addUpdateData(initial, memo, 'utf8');
  const transaction = await ensureSponsoredTransactionTtl(tronWeb, withMemo);
  const privateKey = await fetchPrivateKeyString(accountId, enclaveToken, account);
  if (!privateKey) throw new Error('InvalidPassword');
  return tronWeb.trx.sign(transaction, privateKey);
}

export async function fetchWalletPrepaidOverview(accountId: string): Promise<ApiWalletPrepaidOverview | undefined> {
  const { address } = await getTronAccount(accountId);
  const { session, didRefresh } = await resolvePrepaidAccessSession(accountId, address);
  if (!session) return undefined;
  let failedAccessToken = session.access_token;

  try {
    return await fetchPrepaidJson<ApiWalletPrepaidOverview>(accountId, 'overview', { address }, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch (error) {
    if (!isPrepaidAccessError(error)) throw error;
    if (!didRefresh) {
      try {
        const refreshedSession = await refreshPrepaidAccessSession(accountId, address, session);
        if (refreshedSession) {
          failedAccessToken = refreshedSession.access_token;
          return await fetchPrepaidJson<ApiWalletPrepaidOverview>(accountId, 'overview', { address }, {
            headers: { Authorization: `Bearer ${refreshedSession.access_token}` },
          });
        }
      } catch (refreshError) {
        if (!isPrepaidAccessError(refreshError)) throw refreshError;
      }
    }
    await removePrepaidAccessSession(accountId, failedAccessToken);
    return undefined;
  }
}

export async function getWalletPrepaidAccessToken(accountId: string) {
  const { address } = await getTronAccount(accountId);
  const { session } = await resolvePrepaidAccessSession(accountId, address);
  return session?.access_token;
}

export function clearWalletPrepaidAccessSession(accountId: string, expectedAccessToken?: string) {
  return removePrepaidAccessSession(accountId, expectedAccessToken);
}

async function resolvePrepaidAccessSession(accountId: string, address: string) {
  let session = await getPrepaidAccessSession(accountId);
  let didRefresh = false;
  if (!session) return { session, didRefresh };

  if (session.expires_at * 1000 - Date.now() <= PREPAID_ACCESS_REFRESH_THRESHOLD_MS) {
    try {
      const refreshedSession = await refreshPrepaidAccessSession(accountId, address, session);
      if (refreshedSession) {
        session = refreshedSession;
        didRefresh = true;
      }
    } catch (error) {
      if (isPrepaidAccessError(error)) {
        await removePrepaidAccessSession(accountId, session.access_token);
        return { session: undefined, didRefresh };
      }
      if (session.expires_at * 1000 <= Date.now()) throw error;
    }
  }

  return { session, didRefresh };
}

async function refreshPrepaidAccessSession(
  accountId: string,
  address: string,
  session: PrepaidAccessSession,
) {
  if (!hasValidPrepaidRefreshToken(session)) return undefined;
  const refreshedSession = await fetchPrepaidJson<PrepaidAccessSession>(
    accountId,
    'access/refresh',
    undefined,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.refresh_token}`,
      },
      body: JSON.stringify({ address }),
    },
  );
  await savePrepaidAccessSession(accountId, refreshedSession);
  return refreshedSession;
}

function hasValidPrepaidRefreshToken(session: PrepaidAccessSession) {
  return typeof session.refresh_token === 'string'
    && Number.isFinite(session.refresh_expires_at)
    && session.refresh_expires_at! * 1000 > Date.now();
}

function isPrepaidAccessError(error: unknown) {
  return error instanceof ApiServerError && (error.statusCode === 401 || error.statusCode === 403);
}

export async function authorizeWalletPrepaid(accountId: string, enclaveToken: string) {
  const { address } = await getTronAccount(accountId);
  await createPrepaidAccessSession(accountId, enclaveToken, address);
  const overview = await fetchWalletPrepaidOverview(accountId);
  if (!overview) throw new Error('WalletPrepaidAuthorizationFailed');
  return overview;
}

export function ensureWalletPrepaidAccess(accountId: string, enclaveToken: string) {
  let request = prepaidAccessRequests.get(accountId);
  if (!request) {
    request = ensureWalletPrepaidAccessInternal(accountId, enclaveToken).finally(() => {
      prepaidAccessRequests.delete(accountId);
    });
    prepaidAccessRequests.set(accountId, request);
  }
  return request;
}

async function ensureWalletPrepaidAccessInternal(accountId: string, enclaveToken: string) {
  const { address } = await getTronAccount(accountId);
  const session = await getPrepaidAccessSession(accountId);
  if (session) {
    if (session.expires_at * 1000 - Date.now() > PREPAID_ACCESS_REFRESH_THRESHOLD_MS) return;

    try {
      if (await refreshPrepaidAccessSession(accountId, address, session)) return;
    } catch (error) {
      if (!isPrepaidAccessError(error) && session.expires_at * 1000 > Date.now()) return;
      if (!isPrepaidAccessError(error)) throw error;
      await removePrepaidAccessSession(accountId, session.access_token);
    }
  }

  await createPrepaidAccessSession(accountId, enclaveToken, address);
}

async function createPrepaidAccessSession(accountId: string, enclaveToken: string, address: string) {
  const challenge = await fetchPrepaidJson<PrepaidAccessChallenge>(
    accountId,
    'access/challenge',
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    },
  );
  const proof = await createWalletProof(
    accountId,
    enclaveToken,
    challenge.proof_address,
    challenge.memo,
  );
  const session = await fetchPrepaidJson<PrepaidAccessSession>(
    accountId,
    'access/complete',
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: challenge.challenge, proof }),
    },
  );
  await savePrepaidAccessSession(accountId, session);
}

async function getPrepaidAccessSession(accountId: string) {
  let session = prepaidAccessSessions.get(accountId);
  if (!session) {
    const stored = await storage.getItem(PREPAID_ACCESS_STORAGE_KEY) as
      Record<string, PrepaidAccessSession> | undefined;
    session = prepaidAccessSessions.get(accountId) ?? stored?.[accountId];
  }
  if (!session || typeof session.access_token !== 'string' || !Number.isFinite(session.expires_at)) {
    return undefined;
  }
  if (session.expires_at * 1000 <= Date.now() && !hasValidPrepaidRefreshToken(session)) {
    await removePrepaidAccessSession(accountId, session.access_token);
    return undefined;
  }

  prepaidAccessSessions.set(accountId, session);
  return session;
}

async function savePrepaidAccessSession(accountId: string, session: PrepaidAccessSession) {
  prepaidAccessSessions.set(accountId, session);
  await mutateStoredPrepaidAccessSessions((stored) => ({ ...stored, [accountId]: session }));
}

async function removePrepaidAccessSession(accountId: string, expectedAccessToken?: string) {
  const currentSession = prepaidAccessSessions.get(accountId);
  if (expectedAccessToken && currentSession && currentSession.access_token !== expectedAccessToken) return;

  prepaidAccessSessions.delete(accountId);
  const remove = (stored: Record<string, PrepaidAccessSession> = {}) => {
    if (expectedAccessToken && stored[accountId]?.access_token !== expectedAccessToken) return stored;

    const next = { ...stored };
    delete next[accountId];
    return next;
  };
  await mutateStoredPrepaidAccessSessions(remove);
}

async function mutateStoredPrepaidAccessSessions(
  mutate: (stored: Record<string, PrepaidAccessSession>) => Record<string, PrepaidAccessSession>,
) {
  const mutation = prepaidAccessStorageMutation.then(async () => {
    if (storage.mutateItem) {
      await storage.mutateItem(
        PREPAID_ACCESS_STORAGE_KEY,
        (stored: Record<string, PrepaidAccessSession> = {}) => mutate(stored),
      );
      return;
    }

    const stored = await storage.getItem(PREPAID_ACCESS_STORAGE_KEY) as
      Record<string, PrepaidAccessSession> | undefined;
    await storage.setItem(PREPAID_ACCESS_STORAGE_KEY, mutate(stored ?? {}));
  });
  prepaidAccessStorageMutation = mutation.catch(() => undefined);
  await mutation;
}

export async function setWalletPrepaidCoverageMode(
  accountId: string,
  enclaveToken: string,
  mode: ApiWalletPrepaidCoverageMode,
): Promise<ApiWalletPrepaidOverview> {
  const { address } = await getTronAccount(accountId);
  const challenge = await fetchPrepaidJson<{
    challenge_id: string;
    memo: string;
    proof_address: string;
  }>(accountId, 'preferences/challenge', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, coverage_mode: mode }),
  });
  const proof = await createWalletProof(accountId, enclaveToken, challenge.proof_address, challenge.memo);
  return fetchPrepaidJson<ApiWalletPrepaidOverview>(accountId, 'preferences', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challenge.challenge_id, coverage_mode: mode, proof }),
  });
}

export async function topUpWalletPrepaid(
  accountId: string,
  enclaveToken: string,
  tokenSlug: string,
  amountBaseUnits: bigint,
) {
  const { network } = parseAccountId(accountId);
  const { account, address } = await getTronAccount(accountId);
  if (account.type === 'view' || account.type === 'ledger') return { error: 'UnsupportedAccountType' };
  const overview = await fetchWalletPrepaidOverview(accountId)
    ?? await authorizeWalletPrepaid(accountId, enclaveToken);
  if (!overview.enabled || !overview.deposit_address) return { error: 'WalletPrepaidUnavailable' };
  const token = getTokenBySlug(tokenSlug);
  if (!token || token.chain !== TRX.chain) return { error: 'WalletPrepaidUnsupportedAsset' };
  const topupAsset = overview.topup_assets.find((asset) => (
    asset.asset_code === token.symbol
    && (asset.token_contract || undefined) === (token.tokenAddress || undefined)
  ));
  if (!topupAsset || topupAsset.decimals !== token.decimals) return { error: 'WalletPrepaidUnsupportedAsset' };
  const tronWeb = getTronClient(network);
  const transaction = token.tokenAddress
    ? (await tronWeb.transactionBuilder.triggerSmartContract(
      token.tokenAddress,
      'transfer(address,uint256)',
      { feeLimit: 100_000_000 },
      [
        { type: 'address', value: overview.deposit_address },
        { type: 'uint256', value: amountBaseUnits.toString() },
      ],
      address,
    )).transaction
    : await tronWeb.transactionBuilder.sendTrx(overview.deposit_address, Number(amountBaseUnits), address);
  const extendedTransaction = await ensureSponsoredTransactionTtl(tronWeb, transaction);
  const quote = await fetchPrepaidJson<TopupQuote>(accountId, 'topups/quote', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: extendedTransaction }),
  });
  if (quote.transaction.txID !== extendedTransaction.txID
    || quote.transaction.raw_data_hex !== extendedTransaction.raw_data_hex) {
    return { error: 'WalletPrepaidQuoteChanged' };
  }
  const privateKey = await fetchPrivateKeyString(accountId, enclaveToken, account);
  if (!privateKey) return { error: 'InvalidPassword' };
  const signedTransaction = await tronWeb.trx.sign(quote.transaction, privateKey);
  const result = await fetchPrepaidJson<{
    ok: true; result: boolean; txid: string; quote_id: string; status: string;
  }>(
    accountId,
    'topups/broadcast',
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote_id: quote.quote_id, transaction: signedTransaction }),
    },
    { retries: 1, timeouts: 275_000 },
  );
  if (result.status === 'completed') return result;

  for (let attempt = 0; attempt < TOPUP_CONFIRMATION_ATTEMPTS; attempt++) {
    await pause(TOPUP_CONFIRMATION_POLL_MS);
    let pendingTopup: ApiWalletPrepaidOverview['topups'][number] | undefined;
    try {
      pendingTopup = (await fetchWalletPrepaidOverview(accountId))?.topups.find(({ id }) => id === quote.quote_id);
    } catch {
      continue;
    }
    if (!pendingTopup) return { ...result, status: 'completed' };
    if (TERMINAL_TOPUP_FAILURES.has(pendingTopup.status)) {
      return { error: `WalletPrepaidTopup:${pendingTopup.status}` };
    }
  }

  return result;
}

export async function linkWalletPrepaidAccounts(
  primaryAccountId: string,
  candidateAccountId: string,
  enclaveToken: string,
) {
  const primary = await getTronAccount(primaryAccountId);
  const candidate = await getTronAccount(candidateAccountId);
  const primaryNetwork = parseAccountId(primaryAccountId).network;
  if (primaryNetwork !== parseAccountId(candidateAccountId).network) return { error: 'WalletNetworkMismatch' };
  if ([primary.account.type, candidate.account.type].some((type) => type === 'view' || type === 'ledger')) {
    return { error: 'UnsupportedAccountType' };
  }
  const challenge = await fetchPrepaidJson<{
    challenge_id: string;
    memo: string;
  }>(primaryAccountId, 'link/challenge', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      primary_address: primary.address,
      candidate_address: candidate.address,
    }),
  });
  const tronWeb = getTronClient(primaryNetwork);

  async function createProof(
    accountId: string,
    address: string,
    recipient: string,
    account: typeof primary.account,
  ) {
    if (account.type === 'view' || account.type === 'ledger') throw new Error('UnsupportedAccountType');
    const initial = await tronWeb.transactionBuilder.sendTrx(recipient, 1, address);
    const withMemo = await tronWeb.transactionBuilder.addUpdateData(initial, challenge.memo, 'utf8');
    const extended = await ensureSponsoredTransactionTtl(tronWeb, withMemo);
    const privateKey = await fetchPrivateKeyString(accountId, enclaveToken, account);
    if (!privateKey) throw new Error('InvalidPassword');
    return tronWeb.trx.sign(extended, privateKey);
  }

  const primaryProof = await createProof(
    primaryAccountId, primary.address, candidate.address, primary.account,
  );
  const candidateProof = await createProof(
    candidateAccountId, candidate.address, primary.address, candidate.account,
  );
  return fetchPrepaidJson<ApiWalletPrepaidOverview>(primaryAccountId, 'link/complete', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challenge_id: challenge.challenge_id,
      primary_proof: primaryProof,
      candidate_proof: candidateProof,
    }),
  });
}

export async function connectWalletBotBalance(
  accountId: string,
  enclaveToken: string,
  auth: ApiWalletBalanceIntegrationAuth,
) {
  const { address } = await getTronAccount(accountId);
  const challenge = await fetchPrepaidJson<BalanceIntegrationChallenge>(
    accountId,
    'integration/challenge',
    undefined,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth.type === 'api_key' ? { 'X-API-Key': auth.apiKey } : {}),
      },
      body: JSON.stringify({
        address,
        ...(auth.type === 'telegram_mini_app' ? {
          telegram_init_data: auth.initData,
          bot_code: auth.botCode,
          project_id: auth.projectId,
        } : {}),
      }),
    },
  );
  const proof = await createWalletProof(
    accountId,
    enclaveToken,
    challenge.proof_address,
    challenge.memo,
  );
  return fetchPrepaidJson<ApiWalletPrepaidOverview>(accountId, 'integration/complete', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challenge.challenge_id, proof }),
  }, { retries: 1 });
}

export async function fetchWalletBotBalanceProjects(
  accountId: string,
  auth: ApiWalletBalanceIntegrationAuth,
) {
  return fetchPrepaidJson<ApiWalletBalanceIntegrationProjects>(
    accountId,
    'integration/projects',
    undefined,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth.type === 'api_key' ? { 'X-API-Key': auth.apiKey } : {}),
      },
      body: JSON.stringify(auth.type === 'telegram_mini_app' ? {
        telegram_init_data: auth.initData,
        bot_code: auth.botCode,
      } : {}),
    },
  );
}

export async function disconnectWalletBotBalance(accountId: string, enclaveToken: string) {
  const { address } = await getTronAccount(accountId);
  const challenge = await fetchPrepaidJson<BalanceIntegrationChallenge>(
    accountId,
    'integration/disconnect/challenge',
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    },
  );
  const proof = await createWalletProof(
    accountId,
    enclaveToken,
    challenge.proof_address,
    challenge.memo,
  );
  return fetchPrepaidJson<ApiWalletPrepaidOverview>(accountId, 'integration/disconnect', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challenge.challenge_id, proof }),
  });
}

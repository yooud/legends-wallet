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
import {
  ensureSponsoredTransactionTtl,
  rememberWalletSponsorshipActivityLink,
} from '../chains/tron/sponsorship';
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
  proof_type?: 'message_v2';
  expires_at: number;
};

type PrepaidAccessMessageProof = {
  type: 'message_v2';
  signature: string;
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
const PREPAID_ACCESS_REQUEST_RETRIES = 3;
const PREPAID_ACCESS_REQUEST_TIMEOUTS = [3_000, 5_000, 7_000];
const PREPAID_ACCESS_REVOKE_TIMEOUT_MS = 2_000;
const prepaidAccessSessions = new Map<string, PrepaidAccessSession>();
const prepaidAccessRequests = new Map<string, Promise<void>>();
const prepaidRefreshRequests = new Map<string, Promise<PrepaidAccessSession | undefined>>();
const prepaidAccessGenerations = new Map<string, number>();
let prepaidAccessStorageMutation = Promise.resolve();

export function resetPrepaidAccessCacheForTests() {
  prepaidAccessSessions.clear();
  prepaidAccessRequests.clear();
  prepaidRefreshRequests.clear();
  prepaidAccessGenerations.clear();
  prepaidAccessStorageMutation = Promise.resolve();
}

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

async function createWalletAccessProof(
  accountId: string,
  enclaveToken: string,
  challenge: PrepaidAccessChallenge,
): Promise<Types.Transaction | PrepaidAccessMessageProof> {
  if (challenge.proof_type !== 'message_v2') {
    return createWalletProof(accountId, enclaveToken, challenge.proof_address, challenge.memo);
  }

  const { account } = await getTronAccount(accountId);
  if (account.type === 'view' || account.type === 'ledger') throw new Error('UnsupportedAccountType');
  const privateKey = await fetchPrivateKeyString(accountId, enclaveToken, account);
  if (!privateKey) throw new Error('InvalidPassword');
  const { network } = parseAccountId(accountId);
  const signature = getTronClient(network).trx.signMessageV2(challenge.memo, privateKey);
  return { type: 'message_v2', signature };
}

export async function fetchWalletPrepaidOverview(accountId: string): Promise<ApiWalletPrepaidOverview | undefined> {
  const { account, address } = await getTronAccount(accountId);
  if (account.type === 'view') return undefined;

  return callWithWalletPrepaidAccess(accountId, address, (accessToken) => (
    fetchPrepaidJson<ApiWalletPrepaidOverview>(accountId, 'overview', { address }, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  ));
}

async function callWithWalletPrepaidAccess<T>(
  accountId: string,
  address: string,
  request: (accessToken: string) => Promise<T>,
): Promise<T | undefined> {
  const { session, didRefresh } = await resolvePrepaidAccessSession(accountId, address);
  if (!session) return undefined;
  let failedAccessToken = session.access_token;

  try {
    return await request(session.access_token);
  } catch (error) {
    if (!isPrepaidAccessError(error)) throw error;
    if (!didRefresh) {
      try {
        const refreshedSession = await refreshPrepaidAccessSession(accountId, address, session);
        if (refreshedSession) {
          failedAccessToken = refreshedSession.access_token;
          return await request(refreshedSession.access_token);
        }
      } catch (refreshError) {
        if (!isPrepaidAccessError(refreshError)) throw refreshError;
      }
    }
    await removePrepaidAccessSession(accountId, address, failedAccessToken);
    return undefined;
  }
}

export async function getWalletPrepaidAccessToken(accountId: string) {
  const { account, address } = await getTronAccount(accountId);
  if (account.type === 'view') return undefined;
  const { session } = await resolvePrepaidAccessSession(accountId, address);
  return session?.access_token;
}

export function clearWalletPrepaidAccessSession(accountId: string, expectedAccessToken?: string) {
  return getTronAccount(accountId).then(({ address }) => (
    removePrepaidAccessSession(accountId, address, expectedAccessToken)
  ));
}

export async function revokeWalletPrepaidAccessSession(accountId: string) {
  invalidatePrepaidAccessOperations(accountId);
  try {
    const { account, address } = await getTronAccount(accountId);
    if (account.type === 'view') return;
    const session = await getPrepaidAccessSession(accountId, address);
    if (!session) return;

    await removePrepaidAccessSession(accountId, address, session.access_token);
    if (!hasValidPrepaidRefreshToken(session)) return;

    await revokePrepaidAccessSessionRemotely(accountId, address, session);
  } catch {
    // The account may already be partially removed; stale local sessions are cleared by the caller.
  }
}

export async function clearWalletPrepaidAccessSessionsForNetwork(network: string) {
  const prefix = `${network}:`;
  for (const sessionKey of prepaidAccessSessions.keys()) {
    if (sessionKey.startsWith(prefix)) prepaidAccessSessions.delete(sessionKey);
  }
  await mutateStoredPrepaidAccessSessions((stored) => Object.fromEntries(
    Object.entries(stored).filter(([sessionKey]) => !sessionKey.startsWith(prefix)),
  ));
}

export async function clearAllWalletPrepaidAccessSessions() {
  prepaidAccessSessions.clear();
  prepaidAccessRequests.clear();
  prepaidRefreshRequests.clear();
  await storage.removeItem(PREPAID_ACCESS_STORAGE_KEY);
}

async function resolvePrepaidAccessSession(accountId: string, address: string) {
  let session = await getPrepaidAccessSession(accountId, address);
  let didRefresh = false;
  const pendingAccessRequest = prepaidAccessRequests.get(accountId);
  if (!session && pendingAccessRequest) {
    try {
      await pendingAccessRequest;
    } catch {
      // The caller will fall back to the normal authorization state if background access failed.
    }
    session = await getPrepaidAccessSession(accountId, address);
  }
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
        await removePrepaidAccessSession(accountId, address, session.access_token);
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
  const sessionKey = getPrepaidAccessSessionKey(accountId, address);
  let request = prepaidRefreshRequests.get(sessionKey);
  if (!request) {
    request = refreshPrepaidAccessSessionInternal(accountId, address, session).finally(() => {
      if (prepaidRefreshRequests.get(sessionKey) === request) prepaidRefreshRequests.delete(sessionKey);
    });
    prepaidRefreshRequests.set(sessionKey, request);
  }
  return request;
}

async function refreshPrepaidAccessSessionInternal(
  accountId: string,
  address: string,
  session: PrepaidAccessSession,
) {
  const generation = getPrepaidAccessGeneration(accountId);
  const currentSession = await getPrepaidAccessSession(accountId, address);
  if (currentSession && currentSession.access_token !== session.access_token) return currentSession;
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
    { retries: 1, timeouts: PREPAID_ACCESS_REQUEST_TIMEOUTS[0] },
  );
  if (generation !== getPrepaidAccessGeneration(accountId)) {
    await revokePrepaidAccessSessionRemotely(accountId, address, refreshedSession);
    return undefined;
  }
  await savePrepaidAccessSession(accountId, address, refreshedSession);
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
  const { account, address } = await getTronAccount(accountId);
  if (account.type === 'view') throw new Error('UnsupportedAccountType');
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
  const { account, address } = await getTronAccount(accountId);
  if (account.type === 'view') return;
  const session = await getPrepaidAccessSession(accountId, address);
  if (session) {
    if (session.expires_at * 1000 - Date.now() > PREPAID_ACCESS_REFRESH_THRESHOLD_MS) return;

    try {
      if (await refreshPrepaidAccessSession(accountId, address, session)) return;
    } catch (error) {
      if (!isPrepaidAccessError(error) && session.expires_at * 1000 > Date.now()) return;
      if (!isPrepaidAccessError(error)) throw error;
      await removePrepaidAccessSession(accountId, address, session.access_token);
    }
  }

  await createPrepaidAccessSession(accountId, enclaveToken, address);
}

async function createPrepaidAccessSession(accountId: string, enclaveToken: string, address: string) {
  const generation = getPrepaidAccessGeneration(accountId);
  const challenge = await fetchPrepaidJson<PrepaidAccessChallenge>(
    accountId,
    'access/challenge',
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    },
    { retries: PREPAID_ACCESS_REQUEST_RETRIES, timeouts: PREPAID_ACCESS_REQUEST_TIMEOUTS },
  );
  const proof = await createWalletAccessProof(accountId, enclaveToken, challenge);
  const session = await fetchPrepaidJson<PrepaidAccessSession>(
    accountId,
    'access/complete',
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: challenge.challenge, proof }),
    },
    { retries: PREPAID_ACCESS_REQUEST_RETRIES, timeouts: PREPAID_ACCESS_REQUEST_TIMEOUTS },
  );
  if (generation !== getPrepaidAccessGeneration(accountId)) {
    await revokePrepaidAccessSessionRemotely(accountId, address, session);
    return;
  }
  await savePrepaidAccessSession(accountId, address, session);
}

async function revokePrepaidAccessSessionRemotely(
  accountId: string,
  address: string,
  session: PrepaidAccessSession,
) {
  if (!hasValidPrepaidRefreshToken(session)) return;
  try {
    await fetchPrepaidJson<{ revoked: boolean }>(accountId, 'access/revoke', undefined, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.refresh_token}`,
      },
      body: JSON.stringify({ address }),
      keepalive: true,
    }, { retries: 1, timeouts: PREPAID_ACCESS_REVOKE_TIMEOUT_MS });
  } catch {
    // Local wallet removal must remain available when the API cannot be reached.
  }
}

function getPrepaidAccessGeneration(accountId: string) {
  return prepaidAccessGenerations.get(accountId) ?? 0;
}

function invalidatePrepaidAccessOperations(accountId: string) {
  prepaidAccessGenerations.set(accountId, getPrepaidAccessGeneration(accountId) + 1);
}

async function getPrepaidAccessSession(accountId: string, address: string) {
  const sessionKey = getPrepaidAccessSessionKey(accountId, address);
  let session = prepaidAccessSessions.get(sessionKey);
  let shouldMigrate = false;
  if (!session) {
    const stored = await storage.getItem(PREPAID_ACCESS_STORAGE_KEY) as
      Record<string, PrepaidAccessSession> | undefined;
    session = prepaidAccessSessions.get(sessionKey) ?? stored?.[sessionKey] ?? stored?.[accountId];
    shouldMigrate = !stored?.[sessionKey] && Boolean(stored?.[accountId]);
  }
  if (!session || typeof session.access_token !== 'string' || !Number.isFinite(session.expires_at)) {
    return undefined;
  }
  if (session.expires_at * 1000 <= Date.now() && !hasValidPrepaidRefreshToken(session)) {
    await removePrepaidAccessSession(accountId, address, session.access_token);
    return undefined;
  }

  prepaidAccessSessions.set(sessionKey, session);
  if (shouldMigrate) await migrateStoredPrepaidAccessSession(accountId, sessionKey, session);
  return session;
}

async function savePrepaidAccessSession(accountId: string, address: string, session: PrepaidAccessSession) {
  const sessionKey = getPrepaidAccessSessionKey(accountId, address);
  prepaidAccessSessions.set(sessionKey, session);
  await mutateStoredPrepaidAccessSessions((stored) => {
    const next = { ...stored, [sessionKey]: session };
    delete next[accountId];
    return next;
  });
}

async function removePrepaidAccessSession(accountId: string, address: string, expectedAccessToken?: string) {
  const sessionKey = getPrepaidAccessSessionKey(accountId, address);
  const currentSession = prepaidAccessSessions.get(sessionKey);
  if (expectedAccessToken && currentSession && currentSession.access_token !== expectedAccessToken) return;

  prepaidAccessSessions.delete(sessionKey);
  const remove = (stored: Record<string, PrepaidAccessSession> = {}) => {
    const storedSession = stored[sessionKey] ?? stored[accountId];
    if (expectedAccessToken && storedSession?.access_token !== expectedAccessToken) return stored;

    const next = { ...stored };
    delete next[sessionKey];
    delete next[accountId];
    return next;
  };
  await mutateStoredPrepaidAccessSessions(remove);
}

function getPrepaidAccessSessionKey(accountId: string, address: string) {
  return `${parseAccountId(accountId).network}:${address}`;
}

async function migrateStoredPrepaidAccessSession(
  accountId: string,
  sessionKey: string,
  session: PrepaidAccessSession,
) {
  await mutateStoredPrepaidAccessSessions((stored) => {
    if (!stored[accountId]) return stored;

    const next = { ...stored, [sessionKey]: stored[sessionKey] ?? session };
    delete next[accountId];
    return next;
  });
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
  mode: ApiWalletPrepaidCoverageMode,
): Promise<ApiWalletPrepaidOverview> {
  const { account, address } = await getTronAccount(accountId);
  if (account.type === 'view') throw new Error('UnsupportedAccountType');

  const overview = await callWithWalletPrepaidAccess(accountId, address, (accessToken) => (
    fetchPrepaidJson<ApiWalletPrepaidOverview>(accountId, 'preferences', undefined, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ address, coverage_mode: mode }),
    })
  ));
  if (!overview) throw new Error('WalletPrepaidAuthorizationFailed');
  return overview;
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
  if (result.result && result.txid) {
    rememberWalletSponsorshipActivityLink(network, address, {
      quote_id: result.quote_id || quote.quote_id,
      main_txid: result.txid,
      purpose: 'prepaid_topup',
    });
  }
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

export async function unlinkWalletPrepaidAccount(
  accountId: string,
  enclaveToken: string,
) {
  const { address, account } = await getTronAccount(accountId);
  if (account.type === 'view' || account.type === 'ledger') return { error: 'UnsupportedAccountType' };
  const challenge = await fetchPrepaidJson<{
    challenge_id: string;
    memo: string;
  }>(accountId, 'unlink/challenge', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const tronWeb = getTronClient(parseAccountId(accountId).network);
  const initial = await tronWeb.transactionBuilder.sendTrx(address, 1, address);
  const withMemo = await tronWeb.transactionBuilder.addUpdateData(initial, challenge.memo, 'utf8');
  const extended = await ensureSponsoredTransactionTtl(tronWeb, withMemo);
  const privateKey = await fetchPrivateKeyString(accountId, enclaveToken, account);
  if (!privateKey) throw new Error('InvalidPassword');
  const proof = await tronWeb.trx.sign(extended, privateKey);

  return fetchPrepaidJson<ApiWalletPrepaidOverview>(accountId, 'unlink/complete', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challenge.challenge_id, proof }),
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

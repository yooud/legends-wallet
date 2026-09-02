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

function prepaidUrl(accountId: string, endpoint: string) {
  const { network } = parseAccountId(accountId);
  return `${BRILLIANT_API_BASE_URL}${network === 'testnet' ? '/testnet' : ''}/wallet-prepaid/${endpoint}`;
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
  let session = await getPrepaidAccessSession(accountId);
  if (!session) return undefined;

  let didRefresh = false;
  if (session.expires_at * 1000 - Date.now() <= PREPAID_ACCESS_REFRESH_THRESHOLD_MS) {
    try {
      const refreshedSession = await refreshPrepaidAccessSession(accountId, address, session);
      if (refreshedSession) {
        session = refreshedSession;
        didRefresh = true;
      }
    } catch (error) {
      if (isPrepaidAccessError(error)) {
        await removePrepaidAccessSession(accountId);
        return undefined;
      }
      if (session.expires_at * 1000 <= Date.now()) throw error;
    }
  }

  try {
    return await fetchJson<ApiWalletPrepaidOverview>(prepaidUrl(accountId, 'overview'), { address }, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch (error) {
    if (!isPrepaidAccessError(error)) throw error;
    if (!didRefresh) {
      try {
        const refreshedSession = await refreshPrepaidAccessSession(accountId, address, session);
        if (refreshedSession) {
          return await fetchJson<ApiWalletPrepaidOverview>(prepaidUrl(accountId, 'overview'), { address }, {
            headers: { Authorization: `Bearer ${refreshedSession.access_token}` },
          });
        }
      } catch (refreshError) {
        if (!isPrepaidAccessError(refreshError)) throw refreshError;
      }
    }
    await removePrepaidAccessSession(accountId);
    return undefined;
  }
}

async function refreshPrepaidAccessSession(
  accountId: string,
  address: string,
  session: PrepaidAccessSession,
) {
  if (!hasValidPrepaidRefreshToken(session)) return undefined;
  const refreshedSession = await fetchJson<PrepaidAccessSession>(
    prepaidUrl(accountId, 'access/refresh'),
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
  const challenge = await fetchJson<PrepaidAccessChallenge>(
    prepaidUrl(accountId, 'access/challenge'),
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
  const session = await fetchJson<PrepaidAccessSession>(
    prepaidUrl(accountId, 'access/complete'),
    undefined,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: challenge.challenge, proof }),
    },
  );
  await savePrepaidAccessSession(accountId, session);
  const overview = await fetchWalletPrepaidOverview(accountId);
  if (!overview) throw new Error('WalletPrepaidAuthorizationFailed');
  return overview;
}

async function getPrepaidAccessSession(accountId: string) {
  let session = prepaidAccessSessions.get(accountId);
  if (!session) {
    const stored = await storage.getItem(PREPAID_ACCESS_STORAGE_KEY) as
      Record<string, PrepaidAccessSession> | undefined;
    session = stored?.[accountId];
  }
  if (!session || typeof session.access_token !== 'string' || !Number.isFinite(session.expires_at)) {
    return undefined;
  }
  if (session.expires_at * 1000 <= Date.now() && !hasValidPrepaidRefreshToken(session)) {
    await removePrepaidAccessSession(accountId);
    return undefined;
  }

  prepaidAccessSessions.set(accountId, session);
  return session;
}

async function savePrepaidAccessSession(accountId: string, session: PrepaidAccessSession) {
  prepaidAccessSessions.set(accountId, session);
  if (storage.mutateItem) {
    await storage.mutateItem(PREPAID_ACCESS_STORAGE_KEY, (stored: Record<string, PrepaidAccessSession> = {}) => ({
      ...stored,
      [accountId]: session,
    }));
    return;
  }

  const stored = await storage.getItem(PREPAID_ACCESS_STORAGE_KEY) as Record<string, PrepaidAccessSession> | undefined;
  await storage.setItem(PREPAID_ACCESS_STORAGE_KEY, { ...stored, [accountId]: session });
}

async function removePrepaidAccessSession(accountId: string) {
  prepaidAccessSessions.delete(accountId);
  const remove = (stored: Record<string, PrepaidAccessSession> = {}) => {
    const next = { ...stored };
    delete next[accountId];
    return next;
  };
  if (storage.mutateItem) {
    await storage.mutateItem(PREPAID_ACCESS_STORAGE_KEY, remove);
    return;
  }

  const stored = await storage.getItem(PREPAID_ACCESS_STORAGE_KEY) as Record<string, PrepaidAccessSession> | undefined;
  await storage.setItem(PREPAID_ACCESS_STORAGE_KEY, remove(stored));
}

export async function setWalletPrepaidCoverageMode(
  accountId: string,
  enclaveToken: string,
  mode: ApiWalletPrepaidCoverageMode,
): Promise<ApiWalletPrepaidOverview> {
  const { address } = await getTronAccount(accountId);
  const challenge = await fetchJson<{
    challenge_id: string;
    memo: string;
    proof_address: string;
  }>(prepaidUrl(accountId, 'preferences/challenge'), undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, coverage_mode: mode }),
  });
  const proof = await createWalletProof(accountId, enclaveToken, challenge.proof_address, challenge.memo);
  return fetchJson<ApiWalletPrepaidOverview>(prepaidUrl(accountId, 'preferences'), undefined, {
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
  const quote = await fetchJson<TopupQuote>(prepaidUrl(accountId, 'topups/quote'), undefined, {
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
  const result = await fetchJson<{ ok: true; result: boolean; txid: string; quote_id: string; status: string }>(
    prepaidUrl(accountId, 'topups/broadcast'),
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
  const challenge = await fetchJson<{
    challenge_id: string;
    memo: string;
  }>(prepaidUrl(primaryAccountId, 'link/challenge'), undefined, {
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
  return fetchJson<ApiWalletPrepaidOverview>(prepaidUrl(primaryAccountId, 'link/complete'), undefined, {
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
  const challenge = await fetchJson<BalanceIntegrationChallenge>(
    prepaidUrl(accountId, 'integration/challenge'),
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
  return fetchJson<ApiWalletPrepaidOverview>(prepaidUrl(accountId, 'integration/complete'), undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challenge.challenge_id, proof }),
  }, { retries: 1 });
}

export async function fetchWalletBotBalanceProjects(
  accountId: string,
  auth: ApiWalletBalanceIntegrationAuth,
) {
  return fetchJson<ApiWalletBalanceIntegrationProjects>(
    prepaidUrl(accountId, 'integration/projects'),
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
  const challenge = await fetchJson<BalanceIntegrationChallenge>(
    prepaidUrl(accountId, 'integration/disconnect/challenge'),
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
  return fetchJson<ApiWalletPrepaidOverview>(prepaidUrl(accountId, 'integration/disconnect'), undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id: challenge.challenge_id, proof }),
  });
}

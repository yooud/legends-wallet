import React, { memo, useEffect, useMemo, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type {
  ApiBaseCurrency,
  ApiCurrencyRates,
  ApiStakingState,
  ApiTokenWithPrice,
  ApiTransactionActivity,
  ApiWalletPrepaidOverview,
} from '../../api/types';
import type { Theme } from '../../global/types';

import { ANIMATED_STICKER_BIG_SIZE_PX, TRX } from '../../config';
import {
  selectCurrentAccountId,
  selectCurrentAccountSettings,
  selectEnclaveToken,
  selectIsCurrentAccountViewMode,
  selectIsEnclaveSessionValid,
} from '../../global/selectors';
import { ACCENT_COLORS } from '../../util/accentColor/constants';
import buildClassName from '../../util/buildClassName';
import { formatHumanDay, formatTime, getDayStartAt } from '../../util/dateFormat';
import { fromDecimal } from '../../util/decimals';
import { logDebugError } from '../../util/logs';
import { shortenAddress } from '../../util/shortenAddress';
import { callApiWithThrow } from '../../api';
import { ANIMATED_STICKERS_PATHS } from '../ui/helpers/animatedAssets';

import useAppTheme from '../../hooks/useAppTheme';
import useHistoryBack from '../../hooks/useHistoryBack';
import useInterval from '../../hooks/useInterval';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useScrolledState from '../../hooks/useScrolledState';

import BackHeader from '../common/BackHeader';
import { ActionButton } from '../main/sections/Actions/TopActions';
import Activity from '../main/sections/Content/Activity';
import AnimatedIconWithPreview from '../ui/AnimatedIconWithPreview';
import Modal from '../ui/Modal';
import PasswordForm from '../ui/PasswordForm';
import PrepaidTopupModal from './PrepaidTopupModal';

import activitiesStyles from '../main/sections/Content/Activities.module.scss';
import styles from './Prepaid.module.scss';

interface OwnProps {
  isActive?: boolean;
}

interface StateProps {
  currentAccountId?: string;
  theme: Theme;
  accentColorIndex?: number;
  tokensBySlug: Record<string, ApiTokenWithPrice>;
  baseCurrency: ApiBaseCurrency;
  currencyRates: ApiCurrencyRates;
  isSensitiveDataHidden?: true;
  enclaveToken?: string;
  isEnclaveSessionValid: boolean;
  isViewMode: boolean;
}

type HistoryItem = {
  id: string;
  type: string;
  amount: string;
  asset?: string;
  txHash?: string;
  description?: string;
  createdAt: string;
  status: string;
};

const EMPTY_STAKING_STATE_BY_SLUG: Record<string, ApiStakingState> = {};

function Prepaid({
  isActive,
  currentAccountId,
  theme,
  accentColorIndex,
  tokensBySlug,
  baseCurrency,
  currencyRates,
  isSensitiveDataHidden,
  enclaveToken,
  isEnclaveSessionValid,
  isViewMode,
}: OwnProps & StateProps) {
  const { closePrepaid, openTransactionInfo, releaseEnclaveSession } = getActions();
  const lang = useLang();
  const appTheme = useAppTheme(theme);
  const stickerPaths = ANIMATED_STICKERS_PATHS[appTheme];
  const accentColor = accentColorIndex !== undefined ? ACCENT_COLORS[appTheme][accentColorIndex] : undefined;
  const [overview, setOverview] = useState<ApiWalletPrepaidOverview>();
  const [error, setError] = useState('');
  const [topupOpen, setTopupOpen] = useState(false);
  const [isAuthorizationOpen, setIsAuthorizationOpen] = useState(false);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const { handleScroll, isScrolled } = useScrolledState();

  const showRequestError = useLastCallback((context: string, requestError: unknown) => {
    logDebugError(context, requestError);
    setError(lang('$prepaid_unavailable'));
  });

  const cancelAuthorization = useLastCallback(() => {
    setIsAuthorizationOpen(false);
    setError('');
    closePrepaid();
  });

  const authorize = useLastCallback(async (token: string, shouldRelease = true) => {
    if (!currentAccountId) {
      if (shouldRelease) releaseEnclaveSession({ enclaveToken: token });
      return false;
    }
    setIsAuthorizing(true);
    setError('');
    try {
      setOverview(await callApiWithThrow('authorizeWalletPrepaid', currentAccountId, token));
      setIsAuthorizationOpen(false);
      return true;
    } catch (authorizationError) {
      showRequestError('Prepaid authorization', authorizationError);
      return false;
    } finally {
      setIsAuthorizing(false);
      if (shouldRelease) releaseEnclaveSession({ enclaveToken: token });
    }
  });

  const load = useLastCallback(async () => {
    if (!currentAccountId || isAuthorizing || isViewMode) return;
    try {
      const result = await callApiWithThrow('fetchWalletPrepaidOverview', currentAccountId);
      if (result) {
        setOverview(result);
        setError('');
        setIsAuthorizationOpen(false);
        return;
      }

      const didAuthorize = isEnclaveSessionValid && enclaveToken
        ? await authorize(enclaveToken, false)
        : false;
      if (!didAuthorize) setIsAuthorizationOpen(true);
    } catch (loadError) {
      showRequestError('Prepaid overview', loadError);
    }
  });

  useEffect(() => {
    if (isActive && !isViewMode) void load();
  }, [currentAccountId, isActive, isViewMode]);
  useInterval(load, isActive && !isViewMode ? 10_000 : undefined);
  useHistoryBack({ isActive, onBack: closePrepaid });

  const history = useMemo<HistoryItem[]>(() => {
    if (!overview) return [];
    return [
      ...overview.entries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        amount: entry.amount_trx,
        asset: entry.asset_amount ? `${entry.asset_amount} ${entry.asset_code}` : undefined,
        txHash: entry.tx_hash,
        description: entry.description,
        createdAt: entry.created_at,
        status: 'completed',
      })),
      ...overview.topups.map((topup) => ({
        id: topup.id,
        type: 'topup',
        amount: String(Number(topup.credited_trx) - Number(topup.resource_charge_trx)),
        asset: `${topup.amount} ${topup.asset_code}`,
        txHash: topup.tx_hash,
        description: 'Prepaid top-up',
        createdAt: topup.created_at,
        status: topup.status,
      })),
    ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }, [overview]);

  const historyGroups = useMemo(() => {
    const groups: Array<{ day: number; items: HistoryItem[] }> = [];
    history.forEach((item) => {
      const day = getDayStartAt(Date.parse(item.createdAt));
      const currentGroup = groups[groups.length - 1];
      if (currentGroup?.day === day) {
        currentGroup.items.push(item);
      } else {
        groups.push({ day, items: [item] });
      }
    });
    return groups;
  }, [history]);

  const startTopup = useLastCallback(() => {
    setError('');
    setTopupOpen(true);
  });

  const handleActivityClick = useLastCallback((id: string) => {
    const item = history.find((historyItem) => getPrepaidActivityId(historyItem) === id);
    if (!item?.txHash) return;

    openTransactionInfo({ txHash: item.txHash, chain: TRX.chain });
  });

  if (isViewMode) {
    return (
      <div className={styles.root}>
        <BackHeader title={lang('Prepaid')} withBackButton={false} onBackClick={closePrepaid} />
        <div className={styles.unavailable}>
          {lang('$prepaid_watch_only_unavailable')}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <BackHeader
        title={lang('Prepaid')}
        withBackButton={false}
        withNotchOnScroll
        isScrolled={isScrolled}
        onBackClick={closePrepaid}
      />
      <div className={buildClassName(styles.body, 'custom-scroll')} onScroll={handleScroll}>
        <section className={styles.summary}>
          <div className={styles.balanceSection}>
            <span className={styles.eyebrow}>{lang('Available balance')}</span>
            <strong className={buildClassName(styles.balance, 'rounded-font')}>
              {formatTrx(overview?.available_trx)} <small>TRX</small>
            </strong>
            {overview?.integration && (
              <span className={styles.reserved}>
                {lang('Bot Balance')}
                {overview.integration.has_multiple_projects !== false
                  && ` · ${overview.integration.project_name}`}
              </span>
            )}
            {Number(overview?.reserved_trx || 0) > 0 && (
              <span className={styles.reserved}>
                {lang('$prepaid_reserved', { amount: formatTrx(overview?.reserved_trx) })}
              </span>
            )}
          </div>

          <div className={styles.actions}>
            <ActionButton
              label={lang('Top Up')}
              tgsUrl={stickerPaths.iconAdd}
              previewUrl={stickerPaths.preview.iconAdd}
              accentColor={accentColor}
              isDisabled={!overview?.enabled}
              onClick={startTopup}
            />
          </div>
        </section>

        {error && <div className={styles.notice}>{error}</div>}
        {!overview?.enabled && overview && <div className={styles.notice}>{lang('$prepaid_unavailable')}</div>}

        <section className={styles.activity}>
          <div className={buildClassName(activitiesStyles.listGroup, activitiesStyles.listGroupExternalScroll)}>
            {historyGroups.length ? historyGroups.map(({ day, items }) => (
              <div key={day}>
                <div className={activitiesStyles.date}>{formatHumanDay(lang, day)}</div>
                {items.map((item, index) => {
                  const activity = buildPrepaidActivity(item);

                  return (
                    <Activity
                      key={activity.id}
                      activity={activity}
                      isLast={index === items.length - 1}
                      tokensBySlug={tokensBySlug}
                      swapTokensBySlug={undefined}
                      appTheme={appTheme}
                      nftsByAddress={undefined}
                      currentAccountId={currentAccountId || ''}
                      stakingStateBySlug={EMPTY_STAKING_STATE_BY_SLUG}
                      savedAddresses={undefined}
                      accounts={undefined}
                      baseCurrency={baseCurrency}
                      currencyRates={currencyRates}
                      isSensitiveDataHidden={isSensitiveDataHidden}
                      displayOverrides={{
                        title: getPrepaidHistoryTitle(lang, item),
                        subheaderStart: (
                          <>
                            {item.txHash ? `${shortenAddress(item.txHash, 5)} · ` : ''}
                            {formatTime(activity.timestamp)}
                          </>
                        ),
                        subheaderEnd: item.asset || getPrepaidHistoryStatus(lang, item.status),
                      }}
                      onClick={item.txHash ? handleActivityClick : undefined}
                    />
                  );
                })}
              </div>
            )) : (
              <div className={activitiesStyles.emptyList}>
                <AnimatedIconWithPreview
                  play={isActive}
                  tgsUrl={ANIMATED_STICKERS_PATHS.hello}
                  previewUrl={ANIMATED_STICKERS_PATHS.helloPreview}
                  size={ANIMATED_STICKER_BIG_SIZE_PX}
                  className={activitiesStyles.sticker}
                  noLoop={false}
                  nonInteractive
                />
                <p className={activitiesStyles.emptyListTitle}>{lang('No Activity')}</p>
              </div>
            )}
          </div>
        </section>
      </div>

      {currentAccountId && (
        <PrepaidTopupModal
          isOpen={topupOpen}
          accountId={currentAccountId}
          onClose={() => setTopupOpen(false)}
          onSuccess={load}
        />
      )}
      <Modal
        isOpen={isAuthorizationOpen}
        title={lang('Prepaid')}
        hasCloseButton
        onClose={cancelAuthorization}
      >
        <PasswordForm
          isActive={isAuthorizationOpen}
          isLoading={isAuthorizing}
          operationType="passcode"
          error={error}
          submitLabel={lang('Continue')}
          onAuthorize={authorize}
          onCancel={cancelAuthorization}
          onUpdate={() => setError('')}
        />
      </Modal>
    </div>
  );
}

function formatTrx(value?: string) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(Number(value || 0));
}

function titleCase(value: string) {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function getPrepaidHistoryTitle(lang: ReturnType<typeof useLang>, item: HistoryItem) {
  const keys: Record<string, string> = {
    topup: '$prepaid_history_topup',
    topup_credit: '$prepaid_history_topup',
    topup_resource_debit: '$prepaid_history_topup_resources',
    sponsorship_debit: '$prepaid_history_fee_coverage',
    activation_debit: '$prepaid_history_activation',
    refund_debit: '$prepaid_history_refund',
    admin_credit: '$prepaid_history_adjustment',
    admin_debit: '$prepaid_history_adjustment',
    balance_merge_in: '$prepaid_history_balance_received',
    balance_merge_out: '$prepaid_history_balance_moved',
    bot_balance_transfer_out: '$prepaid_history_bot_transfer',
  };

  return keys[item.type] ? lang(keys[item.type]) : item.description || titleCase(item.type);
}

function getPrepaidHistoryStatus(lang: ReturnType<typeof useLang>, status: string) {
  if (status === 'completed' || status === 'credited' || status === 'refunded') return lang('Completed');
  if (status === 'failed' || status === 'rejected' || status === 'expired') return lang('Failed');
  return lang('Pending');
}

function getPrepaidActivityId(item: HistoryItem) {
  return `prepaid:${item.type}:${item.id}`;
}

function buildPrepaidActivity(item: HistoryItem): ApiTransactionActivity {
  const amount = fromDecimal(item.amount, TRX.decimals);

  return {
    id: getPrepaidActivityId(item),
    kind: 'transaction',
    timestamp: Date.parse(item.createdAt),
    fromAddress: '',
    toAddress: '',
    amount,
    slug: TRX.slug,
    isIncoming: amount > 0n,
    normalizedAddress: '',
    fee: 0n,
    status: getPrepaidActivityStatus(item.status),
  };
}

function getPrepaidActivityStatus(status: string): ApiTransactionActivity['status'] {
  if (status === 'failed' || status === 'rejected' || status === 'expired') return 'failed';
  if (status === 'completed' || status === 'credited' || status === 'refunded') return 'completed';

  return 'pending';
}

export default memo(withGlobal<OwnProps>((global): StateProps => ({
  currentAccountId: selectCurrentAccountId(global),
  theme: global.settings.theme,
  accentColorIndex: selectCurrentAccountSettings(global)?.accentColorIndex,
  tokensBySlug: global.tokenInfo.bySlug,
  baseCurrency: global.settings.baseCurrency,
  currencyRates: global.currencyRates,
  isSensitiveDataHidden: global.settings.isSensitiveDataHidden,
  enclaveToken: selectEnclaveToken(global),
  isEnclaveSessionValid: selectIsEnclaveSessionValid(global),
  isViewMode: selectIsCurrentAccountViewMode(global),
}))(Prepaid));

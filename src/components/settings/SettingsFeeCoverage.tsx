import React, { memo, useEffect, useMemo, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type {
  ApiWalletBalanceIntegrationAuth,
  ApiWalletBalanceIntegrationProject,
  ApiWalletPrepaidCoverageMode,
  ApiWalletPrepaidOverview,
} from '../../api/types';
import type { Account } from '../../global/types';

import { IS_TELEGRAM_APP } from '../../config';
import {
  selectCurrentAccountId,
  selectEnclaveToken,
  selectIsEnclaveSessionValid,
  selectNetworkAccounts,
} from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { logDebugError } from '../../util/logs';
import { shortenAddress } from '../../util/shortenAddress';
import { getTelegramApp } from '../../util/telegram';
import { callApiWithThrow } from '../../api';

import useHistoryBack from '../../hooks/useHistoryBack';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useScrolledState from '../../hooks/useScrolledState';

import Button from '../ui/Button';
import IconWithTooltip from '../ui/IconWithTooltip';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import PasswordForm from '../ui/PasswordForm';
import Radio from '../ui/Radio';
import SettingsHeader from './SettingsHeader';

import styles from './Settings.module.scss';
import localStyles from './SettingsFeeCoverage.module.scss';

interface OwnProps {
  isActive?: boolean;
  onBackClick: NoneToVoidFunction;
}

interface StateProps {
  accountId?: string;
  accounts?: Record<string, Account>;
  enclaveToken?: string;
  isEnclaveSessionValid: boolean;
}

const options: Array<{ mode: ApiWalletPrepaidCoverageMode; title: string; description: string }> = [
  {
    mode: 'auto',
    title: 'Automatic',
    description: '$prepaid_auto_help',
  },
  {
    mode: 'prepaid',
    title: 'Prepaid only',
    description: '$prepaid_only_help',
  },
  {
    mode: 'direct',
    title: 'Pay with TRX',
    description: '$prepaid_direct_help',
  },
];

function SettingsFeeCoverage({
  isActive,
  accountId,
  accounts,
  enclaveToken,
  isEnclaveSessionValid,
  onBackClick,
}: OwnProps & StateProps) {
  const { releaseEnclaveSession } = getActions();
  const lang = useLang();
  const [overview, setOverview] = useState<ApiWalletPrepaidOverview>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isAuthorizationOpen, setIsAuthorizationOpen] = useState(false);
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);
  const [candidateAccountId, setCandidateAccountId] = useState('');
  const [isIntegrationModalOpen, setIsIntegrationModalOpen] = useState(false);
  const [isDisconnectModalOpen, setIsDisconnectModalOpen] = useState(false);
  const [isDisconnectConfirmed, setIsDisconnectConfirmed] = useState(false);
  const [integrationAuth, setIntegrationAuth] = useState<ApiWalletBalanceIntegrationAuth>();
  const [integrationProjects, setIntegrationProjects] = useState<ApiWalletBalanceIntegrationProject[]>();
  const [apiKey, setApiKey] = useState('');
  const { isScrolled, handleScroll } = useScrolledState();

  const showRequestError = useLastCallback((context: string, requestError: unknown) => {
    logDebugError(context, requestError);
    setError(lang('$prepaid_unavailable'));
  });

  const cancelOverviewAuthorization = useLastCallback(() => {
    setIsAuthorizationOpen(false);
    setError('');
    onBackClick();
  });

  const authorizeOverview = useLastCallback(async (token: string, shouldRelease = true) => {
    if (!accountId || isLoading) {
      if (shouldRelease) releaseEnclaveSession({ enclaveToken: token });
      return false;
    }
    setIsLoading(true);
    setError('');
    try {
      setOverview(await callApiWithThrow('authorizeWalletPrepaid', accountId, token));
      setIsAuthorizationOpen(false);
      return true;
    } catch (authorizationError) {
      showRequestError('Fee coverage authorization', authorizationError);
      return false;
    } finally {
      setIsLoading(false);
      if (shouldRelease) releaseEnclaveSession({ enclaveToken: token });
    }
  });

  const load = useLastCallback(async () => {
    if (!accountId || isLoading) return;
    try {
      const result = await callApiWithThrow('fetchWalletPrepaidOverview', accountId);
      if (result) {
        setOverview(result);
        setError('');
        setIsAuthorizationOpen(false);
        return;
      }

      const didAuthorize = isEnclaveSessionValid && enclaveToken
        ? await authorizeOverview(enclaveToken, false)
        : false;
      if (!didAuthorize) setIsAuthorizationOpen(true);
    } catch (loadError) {
      showRequestError('Fee coverage overview', loadError);
    }
  });

  useHistoryBack({ isActive, onBack: onBackClick });
  useEffect(() => {
    if (isActive) void load();
  }, [accountId, isActive]);

  const linkedAddresses = useMemo(() => new Set(overview?.addresses.map(({ address }) => address)), [overview]);
  const candidates = useMemo(() => Object.entries(accounts ?? {}).filter(([candidateId, account]) => {
    const address = account.byChain.tron?.address;
    if (!address) return false;
    return candidateId !== accountId
      && account.type !== 'view'
      && !linkedAddresses.has(address);
  }), [accounts, accountId, linkedAddresses]);

  const accountByAddress = useMemo(() => Object.values(accounts ?? {}).reduce<Record<string, Account>>(
    (result, account) => {
      const address = account.byChain.tron?.address;
      if (address) result[address] = account;
      return result;
    },
    {},
  ), [accounts]);

  const selectMode = useLastCallback(async (mode: ApiWalletPrepaidCoverageMode) => {
    if (!accountId || !overview || isLoading || overview.coverage_mode === mode) return;
    const previousOverview = overview;
    setOverview({ ...overview, coverage_mode: mode });
    setIsLoading(true);
    setError('');
    try {
      setOverview(await callApiWithThrow('setWalletPrepaidCoverageMode', accountId, mode));
    } catch (updateError) {
      setOverview(previousOverview);
      showRequestError('Fee coverage mode', updateError);
    } finally {
      setIsLoading(false);
    }
  });

  const selectLinkCandidate = useLastCallback((candidateId: string) => {
    setCandidateAccountId(candidateId);
    setError('');
  });

  const closeLinkModal = useLastCallback(() => {
    setCandidateAccountId('');
    setIsLinkModalOpen(false);
    setError('');
  });

  const authorizeLink = useLastCallback(async (enclaveToken: string) => {
    if (!accountId || !candidateAccountId || isLoading) {
      releaseEnclaveSession({ enclaveToken });
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const result = await callApiWithThrow(
        'linkWalletPrepaidAccounts', accountId, candidateAccountId, enclaveToken,
      );
      if (result && 'error' in result) throw new Error(result.error);
      setOverview(result);
      closeLinkModal();
    } catch (linkError) {
      showRequestError('Fee coverage wallet link', linkError);
      setCandidateAccountId('');
    } finally {
      setIsLoading(false);
      releaseEnclaveSession({ enclaveToken });
    }
  });

  const closeIntegrationModal = useLastCallback(() => {
    setIsIntegrationModalOpen(false);
    setIntegrationAuth(undefined);
    setIntegrationProjects(undefined);
    setApiKey('');
    setError('');
  });

  const selectTelegramIntegration = useLastCallback(async () => {
    const initData = getTelegramApp()?.initData;
    if (!accountId || !initData || isLoading) return;
    const auth: ApiWalletBalanceIntegrationAuth = { type: 'telegram_mini_app', initData };
    setIsLoading(true);
    setError('');
    try {
      const result = await callApiWithThrow('fetchWalletBotBalanceProjects', accountId, auth);
      if (!result?.projects.length) throw new Error('No bot projects are available');
      if (result.projects.length === 1) {
        setIntegrationAuth({ ...auth, projectId: result.projects[0].id });
      } else {
        setIntegrationProjects(result.projects);
        setIntegrationAuth(auth);
      }
    } catch (projectError) {
      showRequestError('Fee coverage bot projects', projectError);
    } finally {
      setIsLoading(false);
    }
  });

  const selectIntegrationProject = useLastCallback((projectId: number) => {
    if (integrationAuth?.type !== 'telegram_mini_app') return;
    setIntegrationAuth({ ...integrationAuth, projectId });
    setError('');
  });

  const cancelIntegrationAuthorization = useLastCallback(() => {
    if (integrationAuth?.type === 'telegram_mini_app' && integrationProjects?.length) {
      setIntegrationAuth({ ...integrationAuth, projectId: undefined });
    } else {
      setIntegrationAuth(undefined);
    }
    setError('');
  });

  const selectApiKeyIntegration = useLastCallback(() => {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) return;
    setError('');
    setIntegrationAuth({ type: 'api_key', apiKey: normalizedApiKey });
  });

  const authorizeIntegration = useLastCallback(async (enclaveToken: string) => {
    if (!accountId || !integrationAuth || isLoading) {
      releaseEnclaveSession({ enclaveToken });
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      setOverview(await callApiWithThrow('connectWalletBotBalance', accountId, enclaveToken, integrationAuth));
      closeIntegrationModal();
    } catch (integrationError) {
      const currentOverview = await callApiWithThrow('fetchWalletPrepaidOverview', accountId).catch((recoveryError) => {
        logDebugError('Fee coverage bot integration recovery', recoveryError);
        return undefined;
      });
      if (currentOverview) {
        setOverview(currentOverview);
      }
      if (currentOverview?.integration) {
        closeIntegrationModal();
        return;
      }
      cancelIntegrationAuthorization();
      showRequestError('Fee coverage bot integration', integrationError);
    } finally {
      setIsLoading(false);
      releaseEnclaveSession({ enclaveToken });
    }
  });

  const authorizeDisconnect = useLastCallback(async (enclaveToken: string) => {
    if (!accountId || isLoading) {
      releaseEnclaveSession({ enclaveToken });
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      setOverview(await callApiWithThrow('disconnectWalletBotBalance', accountId, enclaveToken));
      setIsDisconnectModalOpen(false);
      setIsDisconnectConfirmed(false);
    } catch (disconnectError) {
      showRequestError('Fee coverage bot disconnect', disconnectError);
    } finally {
      setIsLoading(false);
      releaseEnclaveSession({ enclaveToken });
    }
  });

  const coverageHelp = (
    <div className={localStyles.tooltip}>
      {options.map((option) => (
        <p key={option.mode}>
          <strong>{lang(option.title)}</strong>
          {': '}{lang(option.description)}
        </p>
      ))}
    </div>
  );
  const coverageMode = overview?.coverage_mode ?? 'auto';
  const isIntegrationProjectSelection = integrationAuth?.type === 'telegram_mini_app'
    && !integrationAuth.projectId
    && Boolean(integrationProjects?.length);

  const closeDisconnectModal = useLastCallback(() => {
    setIsDisconnectModalOpen(false);
    setIsDisconnectConfirmed(false);
    setError('');
  });

  return (
    <div className={styles.slide}>
      <SettingsHeader title={lang('Fee Coverage')} isScrolled={isScrolled} onBackClick={onBackClick} />
      <div className={buildClassName(styles.content, 'custom-scroll')} onScroll={handleScroll}>
        <div className={styles.blockTitleRow}>
          <p className={styles.blockTitle}>{lang('Fee Coverage')}</p>
          <IconWithTooltip message={coverageHelp} size="small" direction="bottom" />
        </div>
        <div className={styles.block}>
          {options.map((option) => (
            <button
              type="button"
              className={buildClassName(styles.item, styles.item_small, localStyles.option)}
              disabled={isLoading || !overview?.enabled}
              onClick={() => selectMode(option.mode)}
              key={option.mode}
            >
              <span className={styles.itemTitle}>{lang(option.title)}</span>
              <Radio name="fee-coverage" value={option.mode} isChecked={coverageMode === option.mode} />
            </button>
          ))}
        </div>

        {overview && (
          <>
            <p className={styles.blockTitle}>{lang('Prepaid Balance')}</p>
            <div className={styles.block}>
              <div className={buildClassName(styles.item, styles.item_small, styles.item_nonInteractive)}>
                <span className={styles.itemTitle}>{lang('Available balance')}</span>
                <strong className={styles.itemInfo}>{formatTrx(overview.available_trx)} TRX</strong>
              </div>
            </div>

            <div className={styles.blockTitleRow}>
              <p className={styles.blockTitle}>{lang('Bot Balance')}</p>
              <IconWithTooltip message={lang('$bot_balance_help')} size="small" direction="bottom" />
            </div>
            <div className={styles.block}>
              <button
                type="button"
                className={buildClassName(styles.item, styles.item_small, localStyles.option)}
                onClick={() => {
                  setError('');
                  if (overview.integration) {
                    setIsDisconnectConfirmed(false);
                    setIsDisconnectModalOpen(true);
                  } else {
                    setIsIntegrationModalOpen(true);
                  }
                }}
              >
                <span className={styles.itemContent}>
                  <span className={overview.integration ? styles.itemTitle : styles.itemTitle_accent}>
                    {overview.integration?.project_name || lang('Connect Account')}
                  </span>
                  {overview.integration?.bot_username && (
                    <span className={styles.itemSubtitle}>
                      @{overview.integration.bot_username.replace(/^@/, '')}
                    </span>
                  )}
                </span>
                <i className={buildClassName(styles.iconChevronRight, 'icon-chevron-right')} aria-hidden />
              </button>
            </div>

            <div className={styles.blockTitleRow}>
              <p className={styles.blockTitle}>{lang('Linked Wallets')}</p>
              <IconWithTooltip message={lang('$prepaid_link_help')} size="small" direction="bottom" />
            </div>
            <div className={styles.block}>
              {overview.addresses.map((item) => {
                const account = accountByAddress[item.address];
                return (
                  <div
                    className={buildClassName(styles.item, styles.item_small, styles.item_nonInteractive)}
                    key={item.address}
                  >
                    <div className={styles.itemContent}>
                      <span className={styles.itemTitle}>
                        {account?.title || lang(item.role === 'owner' ? 'Current Wallet' : 'Linked Wallet')}
                      </span>
                      <span className={styles.itemSubtitle}>{shortenAddress(item.address, 7)}</span>
                    </div>
                  </div>
                );
              })}
              {candidates.length > 0 && (
                <button
                  type="button"
                  className={buildClassName(styles.item, styles.item_small, localStyles.option)}
                  onClick={() => {
                    setError('');
                    setIsLinkModalOpen(true);
                  }}
                >
                  <span className={buildClassName(styles.itemTitle, styles.itemTitle_accent)}>
                    {lang('Link Wallet')}
                  </span>
                  <i className={buildClassName(styles.iconChevronRight, 'icon-chevron-right')} aria-hidden />
                </button>
              )}
            </div>
          </>
        )}

        {error && !isLinkModalOpen && !isIntegrationModalOpen && !isDisconnectModalOpen && (
          <p className={localStyles.error}>{error}</p>
        )}
      </div>

      <Modal
        isOpen={isAuthorizationOpen}
        title={lang('Fee Coverage')}
        hasCloseButton
        onClose={cancelOverviewAuthorization}
      >
        <PasswordForm
          isActive={isAuthorizationOpen}
          isLoading={isLoading}
          operationType="passcode"
          error={error}
          submitLabel={lang('Continue')}
          onAuthorize={authorizeOverview}
          onCancel={cancelOverviewAuthorization}
          onUpdate={() => setError('')}
        />
      </Modal>

      <Modal
        isOpen={isIntegrationModalOpen}
        title={lang('Connect Account')}
        hasCloseButton
        onClose={closeIntegrationModal}
      >
        {isIntegrationProjectSelection ? (
          <div className={localStyles.integrationForm}>
            <p>{lang('$bot_balance_project_help')}</p>
            <div className={buildClassName(localStyles.walletPicker, localStyles.projectPicker)}>
              {integrationProjects?.map((project) => (
                <Button
                  isSimple
                  className={localStyles.walletOption}
                  onClick={() => selectIntegrationProject(project.id)}
                  key={project.id}
                >
                  <span>
                    <strong>{project.name}</strong>
                    <small>{lang('Available balance')}: {formatTrx(project.available_trx)} TRX</small>
                  </span>
                  <i className="icon-chevron-right" aria-hidden />
                </Button>
              ))}
            </div>
            {error && <p className={localStyles.pickerError}>{error}</p>}
          </div>
        ) : integrationAuth ? (
          <PasswordForm
            isActive={isIntegrationModalOpen}
            isLoading={isLoading}
            operationType="passcode"
            error={error}
            submitLabel={lang('Connect')}
            noAutoConfirm
            onAuthorize={authorizeIntegration}
            onCancel={cancelIntegrationAuthorization}
            onUpdate={() => setError('')}
          />
        ) : (
          <div className={localStyles.integrationForm}>
            <p>{lang('$bot_balance_connect_help')}</p>
            {IS_TELEGRAM_APP && getTelegramApp()?.initData && (
              <>
                <Button
                  isPrimary
                  isLoading={isLoading}
                  className={localStyles.integrationButton}
                  onClick={selectTelegramIntegration}
                >
                  {lang('Connect with Telegram')}
                </Button>
                <div className={localStyles.separator}>{lang('or')}</div>
              </>
            )}
            <Input
              type="password"
              label={lang('API Key')}
              value={apiKey}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect={false}
              onInput={setApiKey}
            />
            {error && <p className={localStyles.pickerError}>{error}</p>}
            <Button
              isPrimary
              isDisabled={!apiKey.trim()}
              className={localStyles.integrationButton}
              onClick={selectApiKeyIntegration}
            >
              {lang('Connect with API Key')}
            </Button>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isDisconnectModalOpen}
        title={lang('Disconnect Account')}
        hasCloseButton
        onClose={closeDisconnectModal}
      >
        {isDisconnectConfirmed ? (
          <PasswordForm
            isActive={isDisconnectModalOpen}
            isLoading={isLoading}
            operationType="passcode"
            error={error}
            submitLabel={lang('Disconnect')}
            noAutoConfirm
            onAuthorize={authorizeDisconnect}
            onCancel={() => setIsDisconnectConfirmed(false)}
            onUpdate={() => setError('')}
          />
        ) : (
          <div className={localStyles.disconnectConfirmation}>
            <div className={localStyles.disconnectProject}>
              <strong>{overview?.integration?.project_name}</strong>
              {overview?.integration?.bot_username && (
                <span>@{overview.integration.bot_username.replace(/^@/, '')}</span>
              )}
            </div>
            <p>{lang('$bot_balance_disconnect_warning')}</p>
            <div className={localStyles.confirmationButtons}>
              <Button onClick={closeDisconnectModal}>{lang('Cancel')}</Button>
              <Button isDestructive onClick={() => setIsDisconnectConfirmed(true)}>
                {lang('Disconnect')}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isLinkModalOpen}
        title={lang('Link Wallet')}
        hasCloseButton
        onClose={closeLinkModal}
      >
        {candidateAccountId ? (
          <PasswordForm
            isActive={isLinkModalOpen}
            isLoading={isLoading}
            operationType="passcode"
            error={error}
            extraAuthUsages={1}
            submitLabel={lang('Link Wallet')}
            noAutoConfirm
            onAuthorize={authorizeLink}
            onCancel={() => setCandidateAccountId('')}
            onUpdate={() => setError('')}
          />
        ) : (
          <>
            {error && <p className={localStyles.pickerError}>{error}</p>}
            <div className={localStyles.walletPicker}>
              {candidates.map(([candidateId, account]) => (
                <Button
                  isSimple
                  className={localStyles.walletOption}
                  onClick={() => selectLinkCandidate(candidateId)}
                  key={candidateId}
                >
                  <span>
                    <strong>{account.title || lang('Wallet')}</strong>
                    <small>{shortenAddress(account.byChain.tron!.address, 7)}</small>
                  </span>
                  <i className="icon-chevron-right" aria-hidden />
                </Button>
              ))}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

function formatTrx(value: string) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(Number(value));
}

export default memo(withGlobal<OwnProps>((global): StateProps => ({
  accountId: selectCurrentAccountId(global),
  accounts: selectNetworkAccounts(global),
  enclaveToken: selectEnclaveToken(global),
  isEnclaveSessionValid: selectIsEnclaveSessionValid(global),
}))(SettingsFeeCoverage));

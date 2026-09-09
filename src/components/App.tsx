import React, { memo, useEffect, useLayoutEffect } from '../lib/teact/teact';
import { getActions, withGlobal } from '../global';

import type { Theme } from '../global/types';
import {
  AppState,
  AuthState,
  ContentTab,
  SettingsState,
  SwapState,
  TransactionInfoState,
  TransferState,
} from '../global/types';

import {
  APP_NAME,
  INACTIVE_MARKER,
  IS_ANDROID_DIRECT,
  IS_CORE_WALLET,
  IS_EXPLORER,
  IS_FEATURE_LIMITED,
  IS_LEGENDS_WALLET,
  IS_MY_WALLET_BRAND,
} from '../config';
import {
  selectCurrentAccountId,
  selectCurrentAccountSettings,
  selectCurrentAccountState,
} from '../global/selectors';
import { useAccentColor } from '../util/accentColor';
import { setActiveTabChangeListener } from '../util/activeTabMonitor';
import buildClassName from '../util/buildClassName';
import { MINUTE } from '../util/dateFormat';
import { closeThisTab } from '../util/ledger/tab';
import { resolveRender } from '../util/renderPromise';
import resolveSlideTransitionName from '../util/resolveSlideTransitionName';
import { trackWalletScreen } from '../util/walletTelemetry';
import {
  IS_ELECTRON, IS_LEDGER_EXTENSION_TAB, IS_LINUX,
} from '../util/windowEnvironment';
import { updateSizes } from '../util/windowSize';
import { callApi } from '../api';
import { SwapActivityModal, TransactionInfoModal, TransactionModal } from './main/modals/transaction';
import IFrameBrowser from './ui/IFrameBrowser';

import { useAppIntersectionObserver } from '../hooks/useAppIntersectionObserver';
import useAppTheme from '../hooks/useAppTheme';
import useBackgroundMode from '../hooks/useBackgroundMode';
import { useDeviceScreen } from '../hooks/useDeviceScreen';
import useFlag from '../hooks/useFlag';
import useInterval from '../hooks/useInterval';
import useSyncEffect from '../hooks/useSyncEffect';
import useTimeout from '../hooks/useTimeout';

import Agent from './agent/Agent';
import AppEmpty from './AppEmpty';
import AppInactive from './AppInactive';
import AppLocked from './appLocked/AppLocked';
import Auth from './auth/Auth';
import AuthImportWalletModal from './auth/AuthImportWalletModal';
import CustomizeWalletModal from './customizeWallet/CustomizeWalletModal';
import DappConnectModal from './dapps/DappConnectModal';
import DappSignDataModal from './dapps/DappSignDataModal';
import DappTransferModal from './dapps/DappTransferModal';
import Dialogs from './Dialogs';
import ElectronHeader from './electron/ElectronHeader';
import Explore from './explore/Explore';
import LedgerModal from './ledger/LedgerModal';
import Main from './main/Main';
import BackupModal from './main/modals/BackupModal';
import NftAttributesModal from './main/modals/NftAttributesModal';
import OffRampWidgetModal from './main/modals/OffRampWidgetModal';
import OnRampWidgetModal from './main/modals/OnRampWidgetModal';
import SignatureModal from './main/modals/SignatureModal';
import UnhideNftModal from './main/modals/UnhideNftModal';
import BottomBar from './main/sections/Actions/BottomBar';
import Toasts from './main/Toasts';
import WalletRenameModal from './main/WalletRenameModal';
import MediaViewer from './mediaViewer/MediaViewer';
import MintCardModal from './mintCard/MintCardModal';
import Portfolio from './portfolio/Portfolio';
import Prepaid from './prepaid/Prepaid';
import Settings from './settings/Settings';
import SwapModal from './swap/SwapModal';
import TokenInfo from './tokenInfo/TokenInfo';
import TransferModal from './transfer/TransferModal';
import ConfettiContainer from './ui/ConfettiContainer';
import LoadingOverlay from './ui/LoadingOverlay';
import Transition from './ui/Transition';
import WalletConnectPayDataCollectionModal from './walletConnectPay/WalletConnectPayDataCollectionModal';
import WalletConnectPayModal from './walletConnectPay/WalletConnectPayModal';
import WalletConnectPayOptionSelectionModal from './walletConnectPay/WalletConnectPayOptionSelectionModal';

// import Test from './components/test/TestNoRedundancy';
import styles from './App.module.scss';

interface StateProps {
  appState: AppState;
  accountId?: string;
  isBackupWalletModalOpen?: boolean;
  isHardwareModalOpen?: boolean;
  isCustomizeWalletModalOpen?: boolean;
  isAgentOpen?: boolean;
  isExploreOpen?: boolean;
  isPortfolioOpen?: boolean;
  isPrepaidOpen?: boolean;
  currentTokenSlug?: string;
  isFullscreen: boolean;
  areSettingsOpen?: boolean;
  theme: Theme;
  accentColorIndex?: number;
  isAppReady?: boolean;
  authState: AuthState;
  activeContentTab?: ContentTab;
  transferState: TransferState;
  swapState: SwapState;
  settingsState: SettingsState;
  transactionInfoState: TransactionInfoState;
  isAppLockActive?: boolean;
}

const APP_STATES_WITH_BOTTOM_BAR = new Set([
  AppState.Main, AppState.Agent, AppState.Settings, AppState.Explore, AppState.Prepaid, AppState.TokenInfo,
]);
const APP_UPDATE_INTERVAL = (IS_ELECTRON && !IS_LINUX) || IS_ANDROID_DIRECT
  ? 5 * MINUTE
  : undefined;
const PRERENDER_MAIN_DELAY = 1200;
let mainKey = 0;

const APP_STATE_RENDER_COUNT = Object.keys(AppState).length / 2;

function App({
  appState,
  accountId,
  isBackupWalletModalOpen,
  isHardwareModalOpen,
  isCustomizeWalletModalOpen,
  isAgentOpen,
  isExploreOpen,
  isPortfolioOpen,
  isPrepaidOpen,
  currentTokenSlug,
  isFullscreen,
  areSettingsOpen,
  theme,
  accentColorIndex,
  isAppReady,
  authState,
  activeContentTab,
  transferState,
  swapState,
  settingsState,
  transactionInfoState,
  isAppLockActive,
}: StateProps) {
  const {
    closeBackupWalletModal,
    closeHardwareWalletModal,
    closeSettings,
    cancelCaching,
    checkAppVersion,
  } = getActions();

  const { isPortrait } = useDeviceScreen();

  const [isInactive, markInactive] = useFlag(false);
  const [canPrerenderMain, prerenderMain] = useFlag();

  const renderingKey = resolveRenderingKey({
    isInactive,
    areSettingsOpen,
    isAgentOpen,
    isExploreOpen,
    isPortfolioOpen,
    isPrepaidOpen,
    currentTokenSlug,
    isPortrait,
    appState,
  });
  const telemetryScreen = resolveTelemetryScreen({
    renderingKey,
    areSettingsOpen,
    currentTokenSlug,
    authState,
    activeContentTab,
    transferState,
    swapState,
    settingsState,
    transactionInfoState,
    isAppLockActive,
  });
  const withBottomBar = isPortrait && (!IS_EXPLORER || isAppReady) && APP_STATES_WITH_BOTTOM_BAR.has(renderingKey);
  // Screens sharing the bottom bar are sibling tabs, so they cross-fade into each other. Upstream
  // token screens slide in, while Legends keeps the shared shell fixed during that transition.
  const withSlide = isPortrait && (
    !withBottomBar || (!IS_LEGENDS_WALLET && renderingKey === AppState.TokenInfo)
  );
  const transitionName = withSlide ? resolveSlideTransitionName() : 'semiFade';

  useTimeout(
    prerenderMain,
    renderingKey === AppState.Auth && !canPrerenderMain ? PRERENDER_MAIN_DELAY : undefined,
  );

  // Core builds are deployed to a domain we do not own and have no store presence, so there is no version to nag about
  useInterval(checkAppVersion, IS_CORE_WALLET ? undefined : APP_UPDATE_INTERVAL);

  useEffect(() => {
    document.documentElement.classList.toggle('with-bottombar', withBottomBar);
  }, [withBottomBar]);

  useEffect(() => {
    if (IS_LEGENDS_WALLET) trackWalletScreen(telemetryScreen);
  }, [telemetryScreen]);

  useEffect(() => {
    updateSizes();
    setActiveTabChangeListener(() => {
      document.title = `${APP_NAME} ${INACTIVE_MARKER}`;

      markInactive();
      closeSettings();
      cancelCaching();
    });
  }, [markInactive]);

  useBackgroundMode(() => {
    void callApi('setIsAppFocused', false);
  }, () => {
    void callApi('setIsAppFocused', true);
  }, IS_LEDGER_EXTENSION_TAB);

  useLayoutEffect(() => {
    document.documentElement.classList.add('is-rendered');
    resolveRender();
  }, []);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('is-fullscreen', isFullscreen);
    requestAnimationFrame(updateSizes);
  }, [isFullscreen]);

  useSyncEffect(() => {
    if (accountId) {
      mainKey += 1;
    }
  }, [accountId]);

  const appTheme = useAppTheme(theme);
  useAccentColor('body', appTheme, accentColorIndex);

  useAppIntersectionObserver();

  function renderContent(isActive: boolean, isFrom: boolean, currentKey: AppState) {
    switch (currentKey) {
      case AppState.Auth:
        return <Auth />;
      case AppState.Main: {
        const slideFullClassName = buildClassName(
          styles.appSlide,
          styles.appSlideContent,
          'custom-scroll',
          'app-slide-content',
        );
        return (
          <Transition
            name={IS_LEGENDS_WALLET ? 'none' : 'semiFade'}
            activeKey={mainKey}
            shouldCleanup
            nextKey={renderingKey === AppState.Auth && canPrerenderMain ? mainKey + 1 : undefined}
            slideClassName={slideFullClassName}
          >
            <Main
              key={mainKey}
              isActive={isActive}
            />
          </Transition>
        );
      }
      case AppState.Agent:
        return <Agent isActive={isActive} />;
      case AppState.Explore:
        return <Explore isActive={isActive} />;
      case AppState.Settings:
        return <Settings isActive={isActive} />;
      case AppState.Portfolio:
        return <Portfolio isActive={isActive} />;
      case AppState.Prepaid:
        return <Prepaid isActive={isActive} />;
      case AppState.TokenInfo:
        return <TokenInfo key={accountId} isActive={isActive} />;
      case AppState.Ledger:
        return <LedgerModal isOpen noBackdropClose onClose={closeThisTab} />;
      case AppState.Inactive:
        return <AppInactive />;
      case AppState.Empty:
        return <AppEmpty />;
    }
  }

  return (
    <>
      {IS_ELECTRON && <ElectronHeader withTitle />}

      <Transition
        name={transitionName}
        activeKey={renderingKey}
        renderCount={APP_STATE_RENDER_COUNT}
        shouldCleanup={!withBottomBar}
        className={styles.transitionContainer}
        slideClassName={
          buildClassName(styles.appSlide, withBottomBar && styles.appSlide_fastTransition, 'custom-scroll')
        }
      >
        {renderContent}
      </Transition>

      <AppLocked />
      <MediaViewer />
      {!isInactive && (
        <>
          <AuthImportWalletModal />
          <LedgerModal isOpen={isHardwareModalOpen} onClose={closeHardwareWalletModal} />
          <BackupModal
            isOpen={isBackupWalletModalOpen}
            onClose={closeBackupWalletModal}
          />
          <TransferModal />
          {!IS_FEATURE_LIMITED && <SwapModal />}
          {IS_MY_WALLET_BRAND && <MintCardModal />}
          {(IS_MY_WALLET_BRAND || IS_LEGENDS_WALLET) && (
            <CustomizeWalletModal isOpen={isCustomizeWalletModalOpen} />
          )}
          <SignatureModal />
          <TransactionModal />
          <TransactionInfoModal />
          <SwapActivityModal />
          <DappConnectModal />
          <DappSignDataModal />
          <DappTransferModal />
          <OnRampWidgetModal />
          <OffRampWidgetModal />
          <WalletConnectPayModal />
          <WalletConnectPayOptionSelectionModal />
          <WalletConnectPayDataCollectionModal />
          <UnhideNftModal />
          <NftAttributesModal />
          <Toasts />
          <WalletRenameModal />
          <Dialogs />
          <ConfettiContainer />
          <IFrameBrowser />
          <LoadingOverlay />
        </>
      )}
      {withBottomBar && <BottomBar />}
    </>
  );
}

export default memo(withGlobal((global): StateProps => {
  const accountState = selectCurrentAccountState(global);
  return {
    appState: global.appState,
    accountId: selectCurrentAccountId(global),
    isBackupWalletModalOpen: global.isBackupWalletModalOpen,
    isHardwareModalOpen: global.isHardwareModalOpen,
    isCustomizeWalletModalOpen: global.isCustomizeWalletModalOpen,
    isAgentOpen: global.isAgentOpen,
    isExploreOpen: global.isExploreOpen,
    isPortfolioOpen: global.isPortfolioOpen,
    isPrepaidOpen: global.isPrepaidOpen,
    currentTokenSlug: accountState?.currentTokenSlug,
    areSettingsOpen: global.areSettingsOpen,
    isFullscreen: Boolean(global.isFullscreen),
    theme: global.settings.theme,
    accentColorIndex: selectCurrentAccountSettings(global)?.accentColorIndex,
    isAppReady: accountState?.isAppReady,
    authState: global.auth.state,
    activeContentTab: accountState?.activeContentTab,
    transferState: global.currentTransfer.state,
    swapState: global.currentSwap.state,
    settingsState: global.settings.state,
    transactionInfoState: global.currentTransactionInfo.state,
    isAppLockActive: global.isAppLockActive,
  };
})(App));

function resolveTelemetryScreen({
  renderingKey,
  areSettingsOpen,
  currentTokenSlug,
  authState,
  activeContentTab,
  transferState,
  swapState,
  settingsState,
  transactionInfoState,
  isAppLockActive,
}: Pick<
  StateProps,
  | 'areSettingsOpen'
  | 'currentTokenSlug'
  | 'authState'
  | 'activeContentTab'
  | 'transferState'
  | 'swapState'
  | 'settingsState'
  | 'transactionInfoState'
  | 'isAppLockActive'
> & { renderingKey: AppState }) {
  if (isAppLockActive) return 'AppLock';
  if (transactionInfoState !== TransactionInfoState.None) {
    const stateName = transactionInfoState === TransactionInfoState.Loading
      ? 'Loading'
      : transactionInfoState === TransactionInfoState.ActivityList ? 'List' : 'Detail';
    return `TransactionInfo.${stateName}`;
  }
  if (transferState !== TransferState.None) return `Transfer.${TransferState[transferState]}`;
  if (swapState !== SwapState.None) return `Swap.${SwapState[swapState]}`;
  if (renderingKey === AppState.Auth) return `Auth.${AuthState[authState]}`;
  if (renderingKey === AppState.Settings || areSettingsOpen) return `Settings.${SettingsState[settingsState]}`;
  if (currentTokenSlug) return 'TokenInfo';
  if (renderingKey === AppState.Main && activeContentTab !== undefined) {
    return `Main.${ContentTab[activeContentTab]}`;
  }
  return AppState[renderingKey];
}

function resolveRenderingKey({
  isInactive,
  areSettingsOpen,
  isAgentOpen,
  isExploreOpen,
  isPortfolioOpen,
  isPrepaidOpen,
  currentTokenSlug,
  isPortrait,
  appState,
}: {
  isInactive: boolean;
  areSettingsOpen?: boolean;
  isAgentOpen?: boolean;
  isExploreOpen?: boolean;
  isPortfolioOpen?: boolean;
  isPrepaidOpen?: boolean;
  currentTokenSlug?: string;
  isPortrait: boolean;
  appState: AppState;
}) {
  if (isInactive) return AppState.Inactive;
  if (areSettingsOpen && isPortrait) return AppState.Settings;
  if (isAgentOpen && isPortrait) return AppState.Agent;
  if (isExploreOpen && isPortrait) return AppState.Explore;
  if (isPortfolioOpen && isPortrait) return AppState.Portfolio;
  if (isPrepaidOpen && isPortrait) return AppState.Prepaid;
  // In landscape the token screen lives inside the main content, next to the wallet overview
  if (currentTokenSlug && isPortrait && appState === AppState.Main) return AppState.TokenInfo;
  return appState;
}

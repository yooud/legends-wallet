import type { HomeScreenStatus, Telegram, WebApp } from '@twa-dev/types';
import { getActions } from '../../global';

import type { GlobalState } from '../../global/types';

import compareVersions from '../compareVersions';
import { mapValues } from '../iteratees';
import { logDebug, logDebugError } from '../logs';
import safeExec from '../safeExec';
import { getIsMobileTelegramApp } from '../windowEnvironment';
import { updateSizes } from '../windowSize';

declare global {
  interface Window {
    Telegram: Telegram;
  }
}

let webApp: WebApp | undefined;
let isBiometricInited = false;
let hasBiometrics = false;
let isFaceIdAvailable = false;
let isTouchIdAvailable = false;
let disableSwipeRequests = 0;
let lastSafeAreaSignature = '';

export interface TelegramBiometricDiagnostics {
  managerAvailable: boolean;
  platform?: string;
  webAppVersion?: string;
  isInited?: boolean;
  isBiometricAvailable?: boolean;
  biometricType?: string;
  isAccessRequested?: boolean;
  isAccessGranted?: boolean;
  isBiometricTokenSaved?: boolean;
}

export function getTelegramBiometricDiagnostics(): TelegramBiometricDiagnostics {
  const biometricManager = webApp?.BiometricManager;

  return {
    managerAvailable: Boolean(biometricManager),
    platform: webApp?.platform,
    webAppVersion: webApp?.version,
    isInited: biometricManager?.isInited,
    isBiometricAvailable: biometricManager?.isBiometricAvailable,
    biometricType: biometricManager?.biometricType,
    isAccessRequested: biometricManager?.isAccessRequested,
    isAccessGranted: biometricManager?.isAccessGranted,
    isBiometricTokenSaved: biometricManager?.isBiometricTokenSaved,
  };
}

export function getIsTelegramBiometricTokenMissing() {
  const biometricManager = webApp?.BiometricManager;

  return biometricManager?.isInited === true
    && biometricManager.isBiometricAvailable === true
    && biometricManager.isBiometricTokenSaved === false;
}

function syncTelegramBiometricState(source: string) {
  const diagnostics = getTelegramBiometricDiagnostics();
  const {
    isBiometricAvailable, biometricType, isAccessGranted, isAccessRequested,
  } = diagnostics;

  hasBiometrics = Boolean(isBiometricAvailable && (isAccessGranted || !isAccessRequested));
  isFaceIdAvailable = webApp?.platform === 'ios' && biometricType === 'face';
  isTouchIdAvailable = webApp?.platform === 'ios' && biometricType === 'finger';

  logDebug('[telegram][biometrics] state', { source, ...diagnostics });
}

export function initTelegramApp(onBeforeReady?: NoneToVoidFunction) {
  webApp = window.Telegram?.WebApp;

  if (!webApp) {
    logDebugError('[telegram] Can\'t initialize Telegram Mini-App');

    return;
  }

  enableTelegramMiniAppSwipeToClose();

  webApp.lockOrientation();
  webApp.SecondaryButton.setParams({ position: 'bottom' });
  webApp.BackButton.hide();
  webApp.SettingsButton.hide();
  webApp.expand();

  if (getIsMobileTelegramApp()) {
    webApp.onEvent('safeAreaChanged', updateSafeAreaProperties);
    webApp.onEvent('contentSafeAreaChanged', updateSafeAreaProperties);
  }

  webApp.onEvent('viewportChanged', updateViewport);
  updateSafeAreaProperties();
  initTelegramAppBiometric();

  onBeforeReady?.();
  webApp.ready();
}

export function initTelegramWithGlobal(global: GlobalState) {
  if (global.isFullscreen) {
    webApp!.requestFullscreen();
  }

  webApp!.onEvent('fullscreenChanged', updateFullscreenState);
  webApp!.onEvent('fullscreenFailed', onFullscreenFailed);
}

export function initTelegramAppBiometric() {
  const biometricManager = webApp?.BiometricManager;
  if (!biometricManager) {
    logDebugError('[telegram][biometrics] manager unavailable', getTelegramBiometricDiagnostics());
    return;
  }
  if (isBiometricInited) return;

  isBiometricInited = true;
  logDebug('[telegram][biometrics] initializing', getTelegramBiometricDiagnostics());

  // The bundled SDK types omit Bot API 7.2 biometric events, but Telegram emits this whenever
  // permission or token state changes. Keeping the cached capability in sync also prevents stale UI.
  (webApp as any).onEvent('biometricManagerUpdated', () => {
    syncTelegramBiometricState('manager-updated');
  });

  biometricManager.init(() => syncTelegramBiometricState('initialized'));
}

export function getIsTelegramBiometricAuthSupported() {
  return hasBiometrics;
}

export function getIsTelegramFaceIdAvailable() {
  return isFaceIdAvailable;
}

export function getIsTelegramTouchIdAvailable() {
  return isTouchIdAvailable;
}

export function getIsTelegramBiometricsRestricted() {
  const biometricManager = webApp?.BiometricManager;
  if (!biometricManager) return undefined;

  const { isBiometricAvailable, isAccessGranted, isAccessRequested } = biometricManager;

  return isBiometricAvailable && isAccessRequested && !isAccessGranted;
}

export function getTelegramApp() {
  return webApp;
}

export function isInsideTelegram() {
  const { platform } = getTelegramApp() || {};

  return platform && platform !== 'unknown';
}

export function checkTelegramHomeScreenStatus(): Promise<HomeScreenStatus> {
  if (!isTelegramHomeScreenSupported()) return Promise.resolve('unsupported');

  return new Promise((resolve) => {
    webApp!.checkHomeScreenStatus(resolve);
  });
}

export function addTelegramAppToHomeScreen() {
  if (!isTelegramHomeScreenSupported()) return false;
  webApp!.addToHomeScreen();
  return true;
}

export function onTelegramHomeScreenAdded(callback: NoneToVoidFunction) {
  if (!isTelegramHomeScreenSupported()) return undefined;
  webApp!.onEvent('homeScreenAdded', callback);
  return () => webApp?.offEvent('homeScreenAdded', callback);
}

function isTelegramHomeScreenSupported() {
  return Boolean(
    webApp
    && isInsideTelegram()
    && compareVersions(webApp.version, '8.0') >= 0
    && typeof webApp.checkHomeScreenStatus === 'function'
    && typeof webApp.addToHomeScreen === 'function',
  );
}

export function getTelegramAppAsync(): Promise<WebApp | undefined> {
  return new Promise((resolve) => {
    window.addEventListener('DOMContentLoaded', () => {
      resolve(getTelegramApp());
    });
  });
}

function updateViewport({ isStateStable }: { isStateStable: boolean }) {
  if (isStateStable) {
    updateSizes();
  }
}

function updateSafeAreaProperties() {
  const {
    top, left, right, bottom,
  } = webApp!.safeAreaInset;
  const {
    top: contentTop, left: contentLeft, right: contentRight, bottom: contentBottom,
  } = webApp!.contentSafeAreaInset;

  document.documentElement.style.setProperty('--safe-area-top', `${top + contentTop}px`);
  document.documentElement.style.setProperty('--safe-area-left', `${left + contentLeft}px`);
  document.documentElement.style.setProperty('--safe-area-right', `${right + contentRight}px`);
  document.documentElement.style.setProperty('--safe-area-bottom', `${bottom + contentBottom}px`);

  const signature = [top, right, bottom, left, contentTop, contentRight, contentBottom, contentLeft].join(':');
  if (signature !== lastSafeAreaSignature) {
    lastSafeAreaSignature = signature;
    logDebug('[telegram][safe-area] updated', {
      safeAreaInset: { top, right, bottom, left },
      contentSafeAreaInset: {
        top: contentTop, right: contentRight, bottom: contentBottom, left: contentLeft,
      },
      isFullscreen: webApp!.isFullscreen,
    });
  }
}

function updateFullscreenState() {
  if (webApp!.isFullscreen) {
    getActions().openFullscreen();
    disableTelegramMiniAppSwipeToClose();
  } else {
    getActions().closeFullscreen();
    enableTelegramMiniAppSwipeToClose();
  }

  requestAnimationFrame(() => {
    updateSafeAreaProperties();
    updateSizes();
  });
}

function onFullscreenFailed(params: { error: 'UNSUPPORTED' | 'ALREADY_FULLSCREEN' }) {
  enableTelegramMiniAppSwipeToClose();
  // This error occurs when the user has requested fullscreen, but the application is already open fullscreen.
  // In this case, we just mark in the global that the application is running in fullscreen mode.
  if (params.error === 'ALREADY_FULLSCREEN') {
    getActions().openFullscreen();
    disableTelegramMiniAppSwipeToClose();

    requestAnimationFrame(() => {
      updateSafeAreaProperties();
      updateSizes();
    });
  }
}

export function disableTelegramMiniAppSwipeToClose() {
  disableSwipeRequests += 1;

  if (disableSwipeRequests === 1) {
    webApp?.disableVerticalSwipes();
  }
}

export function enableTelegramMiniAppSwipeToClose() {
  disableSwipeRequests = Math.max(0, disableSwipeRequests - 1);

  if (disableSwipeRequests === 0) {
    webApp?.enableVerticalSwipes();
  }
}

export function signCustomData(
  initDataFields: AnyLiteral,
  payload: string,
  options?: {
    shouldSignHash?: boolean;
    isPayloadBinary?: boolean;
  },
): Promise<{ result: string; resultUnsafe: AnyLiteral }> {
  const app = getTelegramApp()!;

  return new Promise((resolve, reject) => {
    (app as any).invokeCustomMethod('prepareSignedPayload', {
      init_data: app.initData,
      init_data_sign_fields: initDataFields,
      payload,
      ...(options?.shouldSignHash && { sign_sha256: true }),
      ...(options?.isPayloadBinary && { is_payload_binary: true }),
    }, (err: Error, result: string) => {
      if (result) {
        resolve({
          result,
          resultUnsafe: parseResultUnsafe(result),
        });
      } else {
        reject(err || 'Unknown Error');
      }
    });
  });
}

function parseResultUnsafe(appData: string) {
  const resultUnsafe = (window.Telegram as any).Utils.urlParseQueryString(appData);

  return mapValues(resultUnsafe, (value: string) => {
    if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
      return safeExec(() => JSON.parse(value));
    }

    return value;
  });
}

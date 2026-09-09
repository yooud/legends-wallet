import type { BiometricRequestAccessParams } from '@twa-dev/types';

import { APP_NAME } from '../../config';
import { logDebug, logDebugError } from '../../util/logs';
import { getTelegramApp, getTelegramBiometricDiagnostics } from '../../util/telegram';

function getBiometricManager() {
  const biometricManager = getTelegramApp()?.BiometricManager;
  if (!biometricManager) {
    logDebugError('[telegram][biometrics] manager unavailable during authorization',
      getTelegramBiometricDiagnostics());
    throw new Error('Telegram BiometricManager is unavailable');
  }

  return biometricManager;
}

function requestBiometricAccess(options: BiometricRequestAccessParams) {
  return new Promise((resolve, reject) => {
    const biometricManager = getBiometricManager();
    logDebug('[telegram][biometrics] access requested', getTelegramBiometricDiagnostics());

    biometricManager.requestAccess(options, (accessGranted) => {
      logDebug('[telegram][biometrics] access result', {
        accessGranted,
        ...getTelegramBiometricDiagnostics(),
      });

      if (accessGranted) {
        resolve(accessGranted);
      } else {
        reject(new Error('Access denied'));
      }
    });
  });
}

export async function setBiometricCredentials(password: string) {
  const biometricManager = getBiometricManager();
  logDebug('[telegram][biometrics] token setup started', getTelegramBiometricDiagnostics());

  if (!biometricManager.isAccessGranted) {
    const isAccessGranted = await requestBiometricAccess({ reason: APP_NAME });
    if (!isAccessGranted) {
      throw new Error('Access to biometric data has not been granted');
    }
  }

  return new Promise<void>((resolve, reject) => {
    biometricManager.updateBiometricToken(password, (isUpdated) => {
      logDebug('[telegram][biometrics] token setup result', {
        isUpdated,
        ...getTelegramBiometricDiagnostics(),
      });

      if (isUpdated) {
        resolve();
      } else {
        reject(new Error('Failed to update or save the biometric token'));
      }
    });
  });
}

export function clearBiometricCredentials() {
  const biometricManager = getBiometricManager();
  logDebug('[telegram][biometrics] token removal started', getTelegramBiometricDiagnostics());

  return new Promise<void>((resolve, reject) => {
    biometricManager.updateBiometricToken('', (isUpdated) => {
      logDebug('[telegram][biometrics] token removal result', {
        isUpdated,
        ...getTelegramBiometricDiagnostics(),
      });

      if (isUpdated) {
        resolve();
      } else {
        reject(new Error('Failed to clear the biometric token'));
      }
    });
  });
}

export async function verifyIdentity() {
  const biometricManager = getBiometricManager();
  logDebug('[telegram][biometrics] authentication started', getTelegramBiometricDiagnostics());

  if (!biometricManager.isBiometricAvailable) {
    throw new Error('Telegram biometrics are unavailable on this device');
  }

  if (!biometricManager.isAccessGranted) {
    const isAccessGranted = await requestBiometricAccess({ reason: APP_NAME });
    if (!isAccessGranted) {
      throw new Error('Biometric access was denied. Please grant access to proceed.');
    }
  }

  // Telegram explicitly requires a saved token before authenticate(). Permission can remain granted
  // after the secure token was lost due to a client reinstall, device change or biometric reset.
  if (!biometricManager.isBiometricTokenSaved) {
    throw new Error('Telegram biometric token is not saved on this device');
  }

  return new Promise<{ success: boolean; token: string }>((resolve, reject) => {
    biometricManager.authenticate(
      { reason: '' },
      // @ts-ignore Wrong type signature https://github.com/twa-dev/types/pull/12
      (success: boolean, token: string) => {
        const hasToken = typeof token === 'string' && token.length > 0;
        logDebug('[telegram][biometrics] authentication result', {
          success,
          hasToken,
          ...getTelegramBiometricDiagnostics(),
        });

        if (success && hasToken) {
          resolve({ success, token });
        } else if (success) {
          reject(new Error('Telegram biometric authentication returned an empty token'));
        } else {
          reject(new Error('Biometric authentication failed. Please try again.'));
        }
      },
    );
  });
}

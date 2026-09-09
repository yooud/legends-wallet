const mockRequestAccess = jest.fn();
const mockAuthenticate = jest.fn();
const mockUpdateBiometricToken = jest.fn();
const mockLogDebug = jest.fn();
const mockLogDebugError = jest.fn();

const mockBiometricManager = {
  isInited: true,
  isBiometricAvailable: true,
  biometricType: 'face',
  isAccessRequested: true,
  isAccessGranted: true,
  isBiometricTokenSaved: true,
  deviceId: 'not-logged',
  requestAccess: mockRequestAccess,
  authenticate: mockAuthenticate,
  updateBiometricToken: mockUpdateBiometricToken,
  openSettings: jest.fn(),
};

jest.mock('../../util/telegram', () => ({
  getTelegramApp: () => ({ BiometricManager: mockBiometricManager }),
  getTelegramBiometricDiagnostics: () => ({
    managerAvailable: true,
    isBiometricAvailable: mockBiometricManager.isBiometricAvailable,
    isAccessGranted: mockBiometricManager.isAccessGranted,
    isBiometricTokenSaved: mockBiometricManager.isBiometricTokenSaved,
  }),
}));

jest.mock('../../util/logs', () => ({
  logDebug: (...args: any[]) => mockLogDebug(...args),
  logDebugError: (...args: any[]) => mockLogDebugError(...args),
}));

import { verifyIdentity } from './telegram';

describe('Telegram biometric authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBiometricManager.isBiometricAvailable = true;
    mockBiometricManager.isAccessRequested = true;
    mockBiometricManager.isAccessGranted = true;
    mockBiometricManager.isBiometricTokenSaved = true;
  });

  it('returns a stored token after successful authentication', async () => {
    mockAuthenticate.mockImplementation((_options, callback) => callback(true, 'stored-key'));

    await expect(verifyIdentity()).resolves.toEqual({ success: true, token: 'stored-key' });
    expect(mockLogDebug).toHaveBeenCalledWith(
      '[telegram][biometrics] authentication result',
      expect.objectContaining({ success: true, hasToken: true }),
    );
  });

  it('does not request authentication when Telegram has no saved token', async () => {
    mockBiometricManager.isBiometricTokenSaved = false;

    await expect(verifyIdentity()).rejects.toThrow('Telegram biometric token is not saved');
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('rejects a successful callback without a token', async () => {
    mockAuthenticate.mockImplementation((_options, callback) => callback(true, ''));

    await expect(verifyIdentity()).rejects.toThrow('returned an empty token');
  });
});

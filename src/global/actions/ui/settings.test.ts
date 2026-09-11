import './settings';

import type { GlobalState } from '../../types';

import { enclave } from '../../../enclave';
import { addActionHandler, getGlobal, setGlobal } from '../../index';

jest.mock('../../../lib/teact/teactn', () => ({ addCallback: jest.fn() }));

jest.mock('../../index', () => ({
  addActionHandler: jest.fn(),
  getGlobal: jest.fn(),
  setGlobal: jest.fn(),
}));

jest.mock('../../../api', () => ({ callApi: jest.fn() }));

jest.mock('../../../enclave', () => ({
  enclave: { migrateAuth: jest.fn() },
}));

jest.mock('../../../util/biometrics', () => ({ getDoesUsePinPad: jest.fn(() => true) }));

type ActionHandler = (global: GlobalState, actions: AnyLiteral, payload: AnyLiteral) => Promise<void>;

function getHandler(name: string): ActionHandler {
  const call = (addActionHandler as jest.Mock).mock.calls.find(([actionName]) => actionName === name);
  return call![1] as ActionHandler;
}

describe('changePasscode', () => {
  let store: GlobalState;

  beforeEach(() => {
    jest.mocked(enclave.migrateAuth).mockReset();
    store = {
      auth: {},
      settings: {},
      authTypes: ['passcode'],
    } as GlobalState;
    jest.mocked(getGlobal).mockImplementation(() => store);
    jest.mocked(setGlobal).mockImplementation((next) => {
      store = next;
    });
  });

  it('uses the token retained by the multi-step PIN flow', async () => {
    jest.mocked(enclave.migrateAuth).mockResolvedValue({ token: 'passcode:new' });
    const actions = { releaseEnclaveSession: jest.fn(), showError: jest.fn() };
    const onSuccess = jest.fn();

    await getHandler('changePasscode')(store, actions, {
      passcode: '5678',
      enclaveToken: 'passcode:current',
      onSuccess,
    });

    expect(enclave.migrateAuth).toHaveBeenCalledWith('passcode:current', 'passcode', '5678', true);
    expect(actions.releaseEnclaveSession).toHaveBeenCalledWith({ enclaveToken: 'passcode:new' });
    expect(onSuccess).toHaveBeenCalled();
    expect(store.auth.isLoading).toBe(false);
  });

  it('reports migration failure and exits the loading state', async () => {
    jest.mocked(enclave.migrateAuth).mockRejectedValue(new Error('migration failed'));
    const actions = { releaseEnclaveSession: jest.fn(), showError: jest.fn() };
    const onError = jest.fn();

    await getHandler('changePasscode')(store, actions, {
      passcode: '5678',
      enclaveToken: 'passcode:current',
      onSuccess: jest.fn(),
      onError,
    });

    expect(actions.showError).toHaveBeenCalledWith({ error: 'migration failed' });
    expect(onError).toHaveBeenCalledWith('migration failed');
    expect(store.auth.isLoading).toBe(false);
  });
});

import './transfer';

import type { GlobalState } from '../../types';
import { TransferState } from '../../types';

import { callApiWithThrow } from '../../../api';
import { addActionHandler, getGlobal, setGlobal } from '../../index';

jest.mock('../../index', () => ({
  addActionHandler: jest.fn(),
  getGlobal: jest.fn(),
  setGlobal: jest.fn(),
}));

jest.mock('../../../api', () => ({
  callApi: jest.fn(),
  callApiWithThrow: jest.fn(),
}));

type ActionHandler = (global: GlobalState, actions: AnyLiteral, payload: AnyLiteral) => Promise<void>;

const ACCOUNT_ID = '0-tron-mainnet';
const OTHER_ACCOUNT_ID = '1-tron-mainnet';

describe('transfer Fee Balance authorization', () => {
  let store: GlobalState;
  const handler = (addActionHandler as jest.Mock).mock.calls.find(
    ([name]) => name === 'authorizeTransferFeeAccess',
  )![1] as ActionHandler;

  beforeEach(() => {
    store = {
      currentAccountId: ACCOUNT_ID,
      currentTransfer: {
        state: TransferState.Password,
        tokenSlug: 'tron',
      },
    } as GlobalState;
    (getGlobal as jest.Mock).mockImplementation(() => store);
    (setGlobal as jest.Mock).mockImplementation((next: GlobalState) => {
      store = next;
    });
    (callApiWithThrow as jest.Mock).mockReset();
  });

  it('releases authorization and loading when the account changes during the request', async () => {
    let resolveAccess!: () => void;
    (callApiWithThrow as jest.Mock).mockReturnValue(new Promise<void>((resolve) => {
      resolveAccess = resolve;
    }));
    const actions = { releaseEnclaveSession: jest.fn() };

    const request = handler(store, actions, { enclaveToken: 'passcode:aa' });
    await Promise.resolve();
    store = { ...store, currentAccountId: OTHER_ACCOUNT_ID };
    resolveAccess();
    await request;

    expect(store.currentTransfer.isLoading).toBe(false);
    expect(actions.releaseEnclaveSession).toHaveBeenCalledWith({ enclaveToken: 'passcode:aa' });
  });
});

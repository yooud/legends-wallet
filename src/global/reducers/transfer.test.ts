import { INITIAL_STATE } from '../initialState';
import { isSameTransferFeeDraft } from './transfer';

describe('isSameTransferFeeDraft', () => {
  const draft = {
    tokenSlug: 'tron-token',
    toAddress: 'TRecipient',
    amount: 1_000_000n,
  };

  it('treats empty optional form values as absent', () => {
    expect(isSameTransferFeeDraft({
      ...INITIAL_STATE.currentTransfer,
      ...draft,
      comment: undefined,
      shouldEncrypt: undefined,
    }, {
      ...draft,
      comment: '',
      shouldEncrypt: false,
    })).toBe(true);
  });

  it('rejects a response for a changed amount', () => {
    expect(isSameTransferFeeDraft({
      ...INITIAL_STATE.currentTransfer,
      ...draft,
      amount: 2_000_000n,
    }, draft)).toBe(false);
  });
});

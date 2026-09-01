import { formatTrc20Uint256 } from './tokens';

describe('formatTrc20Uint256', () => {
  it('preserves 18-decimal token amounts outside the safe integer range', () => {
    expect(formatTrc20Uint256(1_000_000_000_000_000_000n)).toBe('1000000000000000000');
  });
});

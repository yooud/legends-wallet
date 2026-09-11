import { logDebug } from '../../util/logs';
import {
  getBackendClockOffset,
  getBackendNow,
  resetBackendClockForTests,
  updateBackendClock,
} from './backendClock';

jest.mock('../../util/logs', () => ({ logDebug: jest.fn() }));

describe('backend clock', () => {
  beforeEach(() => {
    resetBackendClockForTests();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the request midpoint to correct a slow client clock', () => {
    updateBackendClock(46_050, 10_000, 10_100);
    jest.spyOn(Date, 'now').mockReturnValue(20_000);

    expect(getBackendClockOffset()).toBe(36_000);
    expect(getBackendNow()).toBe(56_000);
    expect(logDebug).toHaveBeenCalledWith('[clock] backend offset detected', {
      offsetMs: 36_000,
      roundTripMs: 100,
    });
  });

  it('ignores samples whose round trip cannot provide a useful offset', () => {
    updateBackendClock(50_000, 10_000, 21_000);

    expect(getBackendClockOffset()).toBeUndefined();
    expect(logDebug).not.toHaveBeenCalled();
  });

  it('does not report insignificant clock differences', () => {
    updateBackendClock(10_550, 10_000, 10_100);

    expect(getBackendClockOffset()).toBe(500);
    expect(logDebug).not.toHaveBeenCalled();
  });
});

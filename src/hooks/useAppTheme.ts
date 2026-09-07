import { useEffect } from '../lib/teact/teact';

import type { AppTheme, Theme } from '../global/types';

import { resolveAppTheme, subscribeToAppThemeChange } from '../util/switchTheme';
import useForceUpdate from './useForceUpdate';

function useAppTheme(currentTheme: Theme): AppTheme {
  const forceUpdate = useForceUpdate();

  useEffect(() => {
    if (currentTheme !== 'system') return undefined;

    return subscribeToAppThemeChange(forceUpdate);
  }, [currentTheme, forceUpdate]);

  return resolveAppTheme(currentTheme);
}

export default useAppTheme;

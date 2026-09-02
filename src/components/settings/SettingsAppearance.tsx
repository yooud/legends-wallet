import React, { memo } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ApiNft } from '../../api/types';
import type { AnimationLevel, CardBackgroundId, Theme } from '../../global/types';

import {
  ANIMATION_LEVEL_MAX,
  ANIMATION_LEVEL_MIN,
  IS_LEGENDS_WALLET,
  IS_MY_WALLET_BRAND,
} from '../../config';
import { selectCurrentAccountSettings } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import switchAnimationLevel from '../../util/switchAnimationLevel';
import switchTheme from '../../util/switchTheme';
import { IS_ELECTRON, IS_WINDOWS } from '../../util/windowEnvironment';
import { DEFAULT_CARD_BACKGROUND_ID } from '../customizeWallet/legendsCardBackgrounds';

import useHistoryBack from '../../hooks/useHistoryBack';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useScrolledState from '../../hooks/useScrolledState';

import CustomCardPreview from '../main/modals/accountSelector/CustomCardPreview';
import Switcher from '../ui/Switcher';
import SettingsHeader from './SettingsHeader';

import styles from './Settings.module.scss';

import darkThemeImg from '../../assets/theme/theme_dark.png';
import lightThemeImg from '../../assets/theme/theme_light.png';
import systemThemeImg from '../../assets/theme/theme_system.png';

interface OwnProps {
  isActive?: boolean;
  theme: Theme;
  animationLevel: AnimationLevel;
  isTrayIconEnabled: boolean;
  onBackClick: NoneToVoidFunction;
  onTrayIconEnabledToggle: NoneToVoidFunction;
}

interface StateProps {
  cardBackgroundNft?: ApiNft;
  cardBackgroundId?: CardBackgroundId;
  isNftBuyingDisabled: boolean;
  isSeasonalThemingDisabled?: boolean;
}

const SWITCH_THEME_DURATION_MS = 300;
const THEME_OPTIONS = [{
  value: 'light',
  name: 'Light',
  icon: lightThemeImg,
}, {
  value: 'system',
  name: 'System',
  icon: systemThemeImg,
}, {
  value: 'dark',
  name: 'Dark',
  icon: darkThemeImg,
}];

function SettingsAppearance({
  isActive,
  theme,
  animationLevel,
  cardBackgroundNft,
  cardBackgroundId,
  isTrayIconEnabled,
  isNftBuyingDisabled,
  isSeasonalThemingDisabled,
  onTrayIconEnabledToggle,
  onBackClick,
}: OwnProps & StateProps) {
  const {
    setTheme,
    setAnimationLevel,
    openCustomizeWalletModal,
    toggleSeasonalTheming,
  } = getActions();

  const lang = useLang();

  useHistoryBack({
    isActive,
    onBack: onBackClick,
  });

  const {
    handleScroll: handleContentScroll,
    isScrolled,
  } = useScrolledState();

  const handleThemeChange = useLastCallback((newTheme: string) => {
    document.documentElement.classList.add('no-transitions');
    setTheme({ theme: newTheme as Theme });
    switchTheme(newTheme as Theme);
    setTimeout(() => {
      document.documentElement.classList.remove('no-transitions');
    }, SWITCH_THEME_DURATION_MS);
  });

  const handleAnimationLevelToggle = useLastCallback(() => {
    const level = animationLevel === ANIMATION_LEVEL_MIN ? ANIMATION_LEVEL_MAX : ANIMATION_LEVEL_MIN;
    setAnimationLevel({ level });
    switchAnimationLevel(level);
  });

  const handleSeasonalThemingToggle = useLastCallback(() => {
    toggleSeasonalTheming({ isEnabled: isSeasonalThemingDisabled });
  });

  const handleCustomizeWalletClick = useLastCallback(() => {
    openCustomizeWalletModal({ returnTo: 'settings' });
    return false;
  });

  function renderThemes() {
    return THEME_OPTIONS.map(({ name, value, icon }) => {
      return (
        <div
          key={value}
          className={buildClassName(styles.theme, value === theme && styles.theme_active)}
          onClick={() => handleThemeChange(value)}
        >
          <div className={buildClassName(styles.themeIcon, value === theme && styles.themeIcon_active)}>
            <img src={icon} alt="" className={styles.themeImg} aria-hidden />
          </div>
          <span>{lang(name)}</span>
        </div>
      );
    });
  }

  function renderPalleteIcon() {
    return (
      <div className={styles.palleteIcon}>
        <div className={styles.miniCard}>
          <CustomCardPreview
            nft={cardBackgroundNft}
            cardBackgroundId={IS_LEGENDS_WALLET ? cardBackgroundId ?? DEFAULT_CARD_BACKGROUND_ID : undefined}
            className={styles.miniCardPreview}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.slide}>
      <SettingsHeader title={lang('Appearance')} isScrolled={isScrolled} onBackClick={onBackClick} />

      <div
        className={buildClassName(styles.content, 'custom-scroll')}
        onScroll={handleContentScroll}
      >
        <p className={styles.blockTitle}>{lang('Theme')}</p>
        <div className={styles.settingsBlock}>
          <div className={styles.themeWrapper}>
            {renderThemes()}
          </div>
        </div>

        {(IS_LEGENDS_WALLET || (IS_MY_WALLET_BRAND && !isNftBuyingDisabled)) && (
          <>
            <p className={styles.blockTitle}>{lang(IS_LEGENDS_WALLET ? 'Card Background' : 'Palette and Card')}</p>
            <div className={buildClassName(styles.block, styles.settingsBlockWithDescription)}>
              <a
                role="button"
                tabIndex={0}
                className={buildClassName(styles.item, styles.itemWithFixedHeight)}
                onClick={handleCustomizeWalletClick}
              >
                {renderPalleteIcon()}

                <span className={buildClassName(styles.itemTitle, styles.itemTitle_accent)}>
                  {lang('Customize Wallet')}
                </span>

                <i className={buildClassName(styles.iconChevronRight, 'icon-chevron-right')} aria-hidden />
              </a>
            </div>
            <p className={styles.blockDescription}>
              {lang(IS_LEGENDS_WALLET
                ? 'Choose the background used for this wallet.'
                : 'Customize the wallet\'s home screen and color accents the way you like.')}
            </p>
          </>
        )}

        <p className={styles.blockTitle}>{lang('Other')}</p>
        <div className={styles.settingsBlock}>
          <div className={buildClassName(styles.item, styles.item_small)} onClick={handleAnimationLevelToggle}>
            <span className={styles.itemTitle}>{lang('Enable Animations')}</span>

            <Switcher
              className={styles.menuSwitcher}
              label={lang('Enable Animations')}
              checked={animationLevel !== ANIMATION_LEVEL_MIN}
            />
          </div>
          <div className={buildClassName(styles.item, styles.item_small)} onClick={handleSeasonalThemingToggle}>
            <span className={styles.itemTitle}>{lang('Enable Seasonal Theming')}</span>

            <Switcher
              className={styles.menuSwitcher}
              label={lang('Enable Seasonal Theming')}
              checked={!isSeasonalThemingDisabled}
            />
          </div>
          {IS_ELECTRON && IS_WINDOWS && (
            <div className={buildClassName(styles.item, styles.item_small)} onClick={() => onTrayIconEnabledToggle()}>
              {lang('Display Tray Icon')}

              <Switcher
                className={styles.menuSwitcher}
                label={lang('Display Tray Icon')}
                checked={isTrayIconEnabled}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(withGlobal<OwnProps>((global): StateProps => {
  const accountSettings = selectCurrentAccountSettings(global);

  return {
    cardBackgroundNft: accountSettings?.cardBackgroundNft,
    cardBackgroundId: accountSettings?.cardBackgroundId,
    isNftBuyingDisabled: global.restrictions.isNftBuyingDisabled,
    isSeasonalThemingDisabled: global.settings.isSeasonalThemingDisabled,
  };
})(SettingsAppearance));

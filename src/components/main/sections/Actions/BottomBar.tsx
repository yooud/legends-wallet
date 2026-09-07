import React, {
  memo, useState,
} from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import type { Theme } from '../../../../global/types';

import { IS_FEATURE_LIMITED, NO_AGENT_AND_EXPLORE } from '../../../../config';
import { selectCurrentAccountSettings, selectIsCurrentAccountViewMode } from '../../../../global/selectors';
import { ACCENT_COLORS } from '../../../../util/accentColor/constants';
import buildClassName from '../../../../util/buildClassName';
import buildStyle from '../../../../util/buildStyle';
import { ANIMATED_STICKERS_PATHS } from '../../../ui/helpers/animatedAssets';

import useAppTheme from '../../../../hooks/useAppTheme';
import useDraggablePill from '../../../../hooks/useDraggablePill';
import useEffectOnce from '../../../../hooks/useEffectOnce';
import useFlag from '../../../../hooks/useFlag';
import { getIsBottomBarHidden, subscribeToBottomBarVisibility } from '../../../../hooks/useHideBottomBar';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import Pill from '../../../common/Pill';
import AnimatedIconWithPreview from '../../../ui/AnimatedIconWithPreview';
import Button from '../../../ui/Button';

import styles from './BottomBar.module.scss';

interface StateProps {
  theme: Theme;
  areSettingsOpen?: boolean;
  isAgentOpen?: boolean;
  isExploreOpen?: boolean;
  isPrepaidOpen?: boolean;
  accentColorIndex?: number;
  isViewMode: boolean;
}

type IconKey = 'iconWallet' | 'iconAgent' | 'iconExplore' | 'iconSettings' | 'iconEarn';

interface TabConfig {
  index: number;
  label: string;
  iconKey: IconKey;
  activeIconKey: IconKey | 'iconWalletSolid' | 'iconAgentSolid' | 'iconExploreSolid' | 'iconSettingsSolid';
  onClick: NoneToVoidFunction;
}

const ICON_SIZE_PX = 38;
const ANIMATED_STICKER_SPEED = 2;

const TAB_WALLET = 0;
const TAB_AGENT = 1;
const TAB_EXPLORE = 2;
const TAB_PREPAID_FULL = 3;
const TAB_SETTINGS_WITH_PREPAID_FULL = 4;

const IS_REDUCED_NAV = IS_FEATURE_LIMITED || NO_AGENT_AND_EXPLORE;
const TAB_COUNT = IS_REDUCED_NAV ? 3 : 5;
const PREPAID_INDEX = IS_REDUCED_NAV ? 1 : TAB_PREPAID_FULL;
const SETTINGS_INDEX = IS_REDUCED_NAV ? 2 : TAB_SETTINGS_WITH_PREPAID_FULL;

function BottomBar({
  theme, areSettingsOpen, isAgentOpen, isExploreOpen, isPrepaidOpen, accentColorIndex, isViewMode,
}: StateProps) {
  const { switchToWallet, switchToAgent, switchToExplore, switchToSettings, switchToPrepaid } = getActions();

  const lang = useLang();
  const [isHidden, setIsHidden] = useState(getIsBottomBarHidden());
  const appTheme = useAppTheme(theme);
  const stickerPaths = ANIMATED_STICKERS_PATHS[appTheme];
  const accentColor = accentColorIndex !== undefined ? ACCENT_COLORS[appTheme][accentColorIndex] : undefined;

  useEffectOnce(() => {
    return subscribeToBottomBarVisibility(() => {
      setIsHidden(getIsBottomBarHidden());
    });
  });

  const activeIndex = getActiveIndex({
    isAgentOpen, isExploreOpen, areSettingsOpen, isPrepaidOpen, isViewMode,
  });
  const tabCount = isViewMode ? TAB_COUNT - 1 : TAB_COUNT;

  const tabs: TabConfig[] = IS_REDUCED_NAV
    ? [
      {
        index: TAB_WALLET,
        label: 'Wallet',
        iconKey: 'iconWallet',
        activeIconKey: 'iconWalletSolid',
        onClick: switchToWallet,
      },
      ...(!isViewMode ? [{
        index: PREPAID_INDEX,
        label: 'Prepaid',
        iconKey: 'iconEarn' as const,
        activeIconKey: 'iconEarn' as const,
        onClick: switchToPrepaid,
      }] : []),
      {
        index: isViewMode ? 1 : SETTINGS_INDEX,
        label: 'Settings',
        iconKey: 'iconSettings',
        activeIconKey: 'iconSettingsSolid',
        onClick: switchToSettings,
      },
    ]
    : [
      {
        index: TAB_WALLET,
        label: 'Wallet',
        iconKey: 'iconWallet',
        activeIconKey: 'iconWalletSolid',
        onClick: switchToWallet,
      },
      {
        index: TAB_AGENT, label: 'Agent', iconKey: 'iconAgent', activeIconKey: 'iconAgentSolid', onClick: switchToAgent,
      },
      {
        index: TAB_EXPLORE,
        label: 'Explore',
        iconKey: 'iconExplore',
        activeIconKey: 'iconExploreSolid',
        onClick: switchToExplore,
      },
      ...(!isViewMode ? [{
        index: PREPAID_INDEX,
        label: 'Prepaid',
        iconKey: 'iconEarn' as const,
        activeIconKey: 'iconEarn' as const,
        onClick: switchToPrepaid,
      }] : []),
      {
        index: isViewMode ? 3 : SETTINGS_INDEX,
        label: 'Settings',
        iconKey: 'iconSettings',
        activeIconKey: 'iconSettingsSolid',
        onClick: switchToSettings,
      },
    ];

  const switchToTabByIndex = useLastCallback((index: number) => {
    tabs.find((tab) => tab.index === index)?.onClick();
  });

  const {
    capsuleRef,
    isDragging,
    squeeze,
    renderedActiveIndex,
    pointerHandlers,
  } = useDraggablePill({
    tabCount,
    activeIndex,
    onCommit: switchToTabByIndex,
  });

  const rootStyle = buildStyle(
    `--tab-count: ${tabCount}`,
    `--active-index: ${activeIndex}`,
  );

  return (
    <div
      className={buildClassName(styles.root, isHidden && styles.hidden)}
      style={rootStyle}
    >
      <div
        ref={capsuleRef}
        className={buildClassName(styles.capsule, isDragging && styles.dragging)}
        {...pointerHandlers}
      >
        <Pill isDragging={isDragging} squeeze={squeeze} />
        {tabs.map(({ index, label, iconKey, activeIconKey, onClick }) => {
          const isActive = renderedActiveIndex === index;
          const variant = isActive ? activeIconKey : iconKey;

          return (
            <TabButton
              key={index}
              isActive={isActive}
              label={lang(label)}
              tgsUrl={stickerPaths[variant]}
              previewUrl={stickerPaths.preview[variant]}
              accentColor={accentColor}
              onClick={onClick}
            />
          );
        })}
      </div>
    </div>
  );
}

export default memo(withGlobal((global): StateProps => {
  const { areSettingsOpen, isAgentOpen, isExploreOpen, isPrepaidOpen } = global;

  return {
    theme: global.settings.theme,
    areSettingsOpen,
    isAgentOpen,
    isExploreOpen,
    isPrepaidOpen,
    isViewMode: selectIsCurrentAccountViewMode(global),
    accentColorIndex: selectCurrentAccountSettings(global)?.accentColorIndex,
  };
})(BottomBar));

const TabButton = memo(({
  isActive, label, tgsUrl, previewUrl, accentColor, onClick,
}: {
  isActive?: boolean;
  label: string;
  tgsUrl: string;
  previewUrl: string;
  accentColor?: string;
  onClick: NoneToVoidFunction;
}) => {
  const [isAnimating, startAnimation, stopAnimation] = useFlag();

  const handleClick = useLastCallback(() => {
    startAnimation();
    onClick();
  });

  return (
    <Button
      isSimple
      className={buildClassName(styles.button, isActive && styles.active)}
      onClick={handleClick}
    >
      <AnimatedIconWithPreview
        play={isAnimating}
        size={ICON_SIZE_PX}
        speed={ANIMATED_STICKER_SPEED}
        nonInteractive
        forceOnHeavyAnimation
        className={buildClassName(styles.icon, !isActive && styles.iconInactive)}
        color={accentColor}
        tgsUrl={tgsUrl}
        previewUrl={previewUrl}
        onEnded={stopAnimation}
      />
      <span className={styles.label}>{label}</span>
    </Button>
  );
});

function getActiveIndex({
  isAgentOpen, isExploreOpen, areSettingsOpen, isPrepaidOpen, isViewMode,
}: Pick<StateProps, 'isAgentOpen' | 'isExploreOpen' | 'areSettingsOpen' | 'isPrepaidOpen' | 'isViewMode'>) {
  if (IS_REDUCED_NAV) {
    if (isViewMode) return areSettingsOpen ? 1 : TAB_WALLET;
    if (isPrepaidOpen) return PREPAID_INDEX;
    return areSettingsOpen ? SETTINGS_INDEX : TAB_WALLET;
  }

  if (isAgentOpen) return TAB_AGENT;
  if (isExploreOpen) return TAB_EXPLORE;
  if (isViewMode) return areSettingsOpen ? 3 : TAB_WALLET;
  if (isPrepaidOpen) return PREPAID_INDEX;
  if (areSettingsOpen) return SETTINGS_INDEX;

  return TAB_WALLET;
}

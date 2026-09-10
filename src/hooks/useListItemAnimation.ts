import { useRef } from '../lib/teact/teact';

import useLayoutEffectWithPrevDeps from './useLayoutEffectWithPrevDeps';

const ANIMATION_DURATION = 200;
const ANIMATION_EASING = 'ease-out';

export default function useListItemAnimation(
  withAnimation: boolean,
  topOffset: number, // rem
  shouldFadeInAnimate?: boolean,
) {
  const ref = useRef<HTMLDivElement>();
  const positionAnimationRef = useRef<Animation>();
  const transitionAnimationRef = useRef<Animation>();

  useLayoutEffectWithPrevDeps(([prevTopOffset]) => {
    const element = ref.current;

    if (!element) {
      return;
    }

    positionAnimationRef.current?.cancel();
    positionAnimationRef.current = element.animate(
      { top: `${topOffset}rem` },
      { duration: 0, fill: 'forwards' },
    );

    transitionAnimationRef.current?.cancel();

    if (!withAnimation) {
      return;
    }

    if (prevTopOffset === undefined) {
      transitionAnimationRef.current = animateOpacity(element);
    } else if (topOffset !== prevTopOffset) {
      transitionAnimationRef.current = shouldFadeInAnimate
        ? animateOpacity(element)
        : animateMove(element, topOffset - prevTopOffset);
    }
  }, [topOffset, withAnimation, shouldFadeInAnimate]);

  return { ref };
}

function animateOpacity(element: HTMLElement) {
  return element.animate(
    [{ opacity: 0 }, { opacity: 1 }],
    { duration: ANIMATION_DURATION, easing: ANIMATION_EASING },
  );
}

function animateMove(element: HTMLElement, offsetY: number) {
  return element.animate(
    [
      { transform: `translate3d(0, ${-offsetY}rem, 0)` },
      { transform: 'translate3d(0, 0, 0)' },
    ],
    { duration: ANIMATION_DURATION, easing: ANIMATION_EASING },
  );
}

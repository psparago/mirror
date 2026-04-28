import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, ViewStyle } from 'react-native';

/** Stable tuple — avoids new array identity each render for expo-linear-gradient. */
export const EXPLORER_HOME_GRADIENT_COLORS = ['#0f2027', '#203a43', '#2c5364'] as const;

type Props = {
  /**
   * `screen` — flex 1 (standalone screens).
   * `overlay` — absolute fill behind siblings; does not intercept touches.
   */
  layout: 'screen' | 'overlay';
  style?: ViewStyle;
};

/**
 * Memoized home-screen gradient. No `children` — compose siblings instead so React.memo
 * stays effective (wrapping arbitrary children would defeat memoization).
 */
function ExplorerGradientBackdropInner({ layout, style }: Props) {
  const base: ViewStyle =
    layout === 'overlay'
      ? {
          ...StyleSheet.absoluteFillObject,
          zIndex: 0,
          pointerEvents: 'none',
        }
      : { flex: 1 };

  return (
    <LinearGradient
      colors={[...EXPLORER_HOME_GRADIENT_COLORS]}
      style={[base, style]}
    />
  );
}

export const ExplorerGradientBackdrop = React.memo(ExplorerGradientBackdropInner);

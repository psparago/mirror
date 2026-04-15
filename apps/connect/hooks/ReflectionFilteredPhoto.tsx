import type { ImageStyle, NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';
import { Image as RNImage } from 'react-native';
import {
  ColorMatrix,
  Grayscale,
  concatColorMatrices,
  contrast,
  saturate,
  temperature,
} from 'react-native-image-filter-kit';
import type { ReflectionFilterType } from './useReflectionFilters';

const CLARITY_MATRIX = concatColorMatrices([contrast(1.2), saturate(1.1)]);
/** Warmer shift: temperature + slight saturation toward yellow/orange. */
const WARM_MATRIX = concatColorMatrices([temperature(0.48), saturate(1.12)]);

export type ReflectionFilteredPhotoProps = {
  mediaUri: string;
  currentFilterType: ReflectionFilterType;
  extractImageEnabled: boolean;
  onExtractImage: (e: NativeSyntheticEvent<{ uri: string }>) => void;
  style: StyleProp<ViewStyle>;
};

export function ReflectionFilteredPhoto({
  mediaUri,
  currentFilterType,
  extractImageEnabled,
  onExtractImage,
  style,
}: ReflectionFilteredPhotoProps) {
  const base = (
    <RNImage
      source={{ uri: mediaUri }}
      style={style as StyleProp<ImageStyle>}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
    />
  );

  if (currentFilterType === 'original') {
    return base;
  }

  if (currentFilterType === 'clarity') {
    return (
      <ColorMatrix
        style={style}
        matrix={CLARITY_MATRIX}
        extractImageEnabled={extractImageEnabled}
        onExtractImage={onExtractImage}
        image={base}
      />
    );
  }

  if (currentFilterType === 'classic') {
    return (
      <Grayscale
        style={style}
        amount={1}
        extractImageEnabled={extractImageEnabled}
        onExtractImage={onExtractImage}
        image={base}
      />
    );
  }

  if (currentFilterType === 'warm') {
    return (
      <ColorMatrix
        style={style}
        matrix={WARM_MATRIX}
        extractImageEnabled={extractImageEnabled}
        onExtractImage={onExtractImage}
        image={base}
      />
    );
  }

  return base;
}

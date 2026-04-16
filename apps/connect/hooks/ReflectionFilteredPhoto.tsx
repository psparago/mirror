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
const ORIGINAL_MATRIX: [
  number, number, number, number, number,
  number, number, number, number, number,
  number, number, number, number, number,
  number, number, number, number, number,
] = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

export type ReflectionFilteredPhotoProps = {
  mediaUri: string;
  currentFilterType: ReflectionFilterType;
  extractImageEnabled: boolean;
  onExtractImage: (e: NativeSyntheticEvent<{ uri: string }>) => void;
  style: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
};

export function ReflectionFilteredPhoto({
  mediaUri,
  currentFilterType,
  extractImageEnabled,
  onExtractImage,
  style,
  imageStyle,
}: ReflectionFilteredPhotoProps) {
  const base = (
    <RNImage
      source={{ uri: mediaUri }}
      style={(imageStyle ?? style) as StyleProp<ImageStyle>}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
    />
  );

  if (currentFilterType === 'original') {
    return (
      <ColorMatrix
        style={style}
        matrix={ORIGINAL_MATRIX}
        extractImageEnabled={extractImageEnabled}
        onExtractImage={onExtractImage}
        image={base}
      />
    );
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

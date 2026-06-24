import { Image, type ImageProps } from 'expo-image';
import React, { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { buildStableImageSource } from '@/utils/imageUrlCacheKey';

const PLACEHOLDER_COLOR = '#1a3a44';

type ExplorerCachedImageProps = Omit<ImageProps, 'source'> & {
  uri: string | undefined | null;
  width?: number;
  height?: number;
  /** When true, render a flat placeholder instead of mounting expo-image. */
  deferLoad?: boolean;
  placeholderStyle?: StyleProp<ViewStyle>;
};

function ExplorerCachedImageInner({
  uri,
  width,
  height,
  deferLoad = false,
  placeholderStyle,
  style,
  recyclingKey,
  cachePolicy = 'memory-disk',
  priority = 'low',
  contentFit = 'cover',
  ...rest
}: ExplorerCachedImageProps) {
  const source = useMemo(
    () => buildStableImageSource(uri, { width, height }),
    [uri, width, height],
  );

  if (deferLoad || !source) {
    return <View style={[styles.placeholder, placeholderStyle, style as StyleProp<ViewStyle>]} />;
  }

  return (
    <Image
      source={source}
      style={style}
      contentFit={contentFit}
      recyclingKey={recyclingKey}
      cachePolicy={cachePolicy}
      priority={priority}
      transition={0}
      {...rest}
    />
  );
}

export const ExplorerCachedImage = React.memo(ExplorerCachedImageInner);

const styles = StyleSheet.create({
  placeholder: {
    backgroundColor: PLACEHOLDER_COLOR,
  },
});

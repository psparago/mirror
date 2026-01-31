import { ConfigContext, ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';

export default ({ config }: ConfigContext): ExpoConfig => ({
    ...config,
    name: IS_DEV ? 'Explorer Dev' : (config.name ?? 'Explorer'),
    slug: config.slug ?? 'reflection-explorer', // TypeScript might want this too
    ios: {
        ...config.ios,
        bundleIdentifier: IS_DEV ? 'com.psparago.lookingglass.dev' : 'com.psparago.lookingglass',
    },
    android: {
        ...config.android,
        package: IS_DEV ? 'com.psparago.lookingglass.dev' : 'com.psparago.lookingglass',
    },
});
import { ConfigContext, ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';

export default ({ config }: ConfigContext): ExpoConfig => ({
    ...config,
    name: IS_DEV ? 'Reflection Companion Dev' : (config.name ?? 'Reflection Companion'),
    slug: config.slug ?? 'reflection-companion',
    ios: {
        ...config.ios,
        bundleIdentifier: IS_DEV ? 'com.psparago.lookingglass.companion.dev' : 'com.psparago.lookingglass.companion',
    },
    android: {
        ...config.android,
        package: IS_DEV ? 'com.psparago.lookingglass.companion.dev' : 'com.psparago.lookingglass.companion',
    },
});
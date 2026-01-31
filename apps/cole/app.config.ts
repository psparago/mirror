import { ConfigContext, ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';

export default ({ config }: ConfigContext): ExpoConfig => ({
    ...config,
    name: IS_DEV ? 'Explorer Dev' : (config.name ?? 'Explorer'),
    slug: config.slug ?? 'reflection-explorer', // TypeScript might want this too
    ios: {
        ...config.ios,
        bundleIdentifier: IS_DEV ? 'com.psparago.lookingglass.dev' : 'com.psparago.lookingglass',
        googleServicesFile: './GoogleService-Info.plist',
        infoPlist: {
            CFBundleURLTypes: [
                {
                    CFBundleURLSchemes: [
                        "com.googleusercontent.apps.870445864294-is9qgfe9venn0g01bg8ou9q40vaog7eb"
                    ]
                }
            ]
        }
    },
    android: {
        ...config.android,
        package: IS_DEV ? 'com.psparago.lookingglass.dev' : 'com.psparago.lookingglass',
    },
});
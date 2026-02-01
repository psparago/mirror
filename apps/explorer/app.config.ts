import { ConfigContext, ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';

export default ({ config }: ConfigContext): ExpoConfig => ({
    ...config,
    name: IS_DEV ? 'Explorer Dev' : (config.name ?? 'Explorer'),
    slug: config.slug ?? 'reflection-explorer', // TypeScript might want this too
    ios: {
        ...config.ios,
        bundleIdentifier: IS_DEV ? 'com.psparago.reflections.explorer.dev' : 'com.psparago.reflections.explorer',
        googleServicesFile: './GoogleService-Info.plist',
        infoPlist: {
            CFBundleURLTypes: [
                {
                    CFBundleURLSchemes: [
                        "com.googleusercontent.apps.759023712124-k4u8d605g32n41f6483d9u22cta28j3s"
                    ]
                }
            ]
        }
    },
    android: {
        ...config.android,
        package: IS_DEV ? 'com.psparago.reflections.explorer.dev' : 'com.psparago.reflections.explorer',
    },
});
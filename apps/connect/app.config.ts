import { ConfigContext, ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';

export default ({ config }: ConfigContext): ExpoConfig => ({
    ...config,
    name: IS_DEV ? 'Connect Dev' : (config.name ?? 'Connect'),
    slug: config.slug ?? 'reflections-connect',
    ios: {
        ...config.ios,
        bundleIdentifier: IS_DEV ? 'com.psparago.reflections.connect.dev' : 'com.psparago.reflections.connect',
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
        package: IS_DEV ? 'com.psparago.reflections.connect.dev' : 'com.psparago.reflections.connect',
    },
});
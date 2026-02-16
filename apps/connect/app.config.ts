import { ConfigContext, ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';

// If you run: OTA_VERSION="v2.1" eas update -> Label is "v2.1"
// If you just run: eas update -> Label is "Feb 16, 2026" (Automatic)
const OTA_LABEL = process.env.OTA_VERSION || new Date().toLocaleString('en-US', {
    month: 'short', 
    day: 'numeric', 
    year: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    timeZoneName: 'short'
});

export default ({ config }: ConfigContext): ExpoConfig => ({
    ...config,
    extra: {
        ...config.extra,
        otaLabel: OTA_LABEL,
    },
    name: IS_DEV ? 'Connect Dev' : (config.name ?? 'Connect'),
    slug: config.slug ?? 'reflections-connect',
    ios: {
        ...config.ios,
        bundleIdentifier: IS_DEV ? 'com.psparago.reflections.connect.dev' : 'com.psparago.reflections.connect',
        googleServicesFile: './GoogleService-Info.plist', 
        infoPlist: {
            ...config.ios?.infoPlist,
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
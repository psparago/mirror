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

    name: IS_DEV ? 'Explorer Dev' : (config.name ?? 'Explorer'),
    slug: config.slug ?? 'reflection-explorer', // TypeScript might want this too
    ios: {
        ...config.ios,
        bundleIdentifier: IS_DEV ? 'com.psparago.reflections.explorer.dev' : 'com.psparago.reflections.explorer',
        googleServicesFile: './GoogleService-Info.plist',
        infoPlist: {
            ...config.ios?.infoPlist,
            CFBundleURLTypes: [
                {
                    CFBundleURLSchemes: [
                        "com.googleusercontent.apps.759023712124-53bk46rivsfk3rr3ss23c0vtsrjch0g9"
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
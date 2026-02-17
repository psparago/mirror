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

// Sentry DSN for project "reflections-explorer" (org angelwareorg). Override with SENTRY_DSN_EXPLORER env if needed.
const SENTRY_DSN_EXPLORER =
  process.env.SENTRY_DSN_EXPLORER ||
  'https://3b9c28e5a2deadc1601d2e4b80bfca9d@o4507266632581120.ingest.us.sentry.io/4510811894972416';

export default ({ config }: ConfigContext): ExpoConfig => ({
    ...config,
    extra: {
        ...config.extra,
        otaLabel: OTA_LABEL,
        sentryDsn: SENTRY_DSN_EXPLORER,
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
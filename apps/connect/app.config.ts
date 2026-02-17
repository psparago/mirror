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

// Sentry DSN for project "reflections-connect" (org angelwareorg). Override with SENTRY_DSN_CONNECT env if needed.
const SENTRY_DSN_CONNECT =
  process.env.SENTRY_DSN_CONNECT ||
  'https://e9b6b6e7a2330b40b346b9bc4e6d83c1@o4507266632581120.ingest.us.sentry.io/4510811902574592';

export default ({ config }: ConfigContext): ExpoConfig => ({
    ...config,
    extra: {
        ...config.extra,
        otaLabel: OTA_LABEL,
        sentryDsn: SENTRY_DSN_CONNECT,
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
/**
 * react-native-image-filter-kit still relies on Renderscript. AGP disables the
 * default Renderscript build feature unless android.defaults.buildfeatures.renderscript
 * is set in gradle.properties.
 *
 * expo-build-properties@0.13.x accepts android.extraGradleProperties in app config but
 * does not write it yet; we apply the same entries here so prebuild/EAS pick them up.
 */
const { withGradleProperties, AndroidConfig } = require('expo/config-plugins');

const RENDERSCRIPT_GRADLE_DEFAULTS_KEY = 'android.defaults.buildfeatures.renderscript';

function withReactNativeImageFilterKit(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = AndroidConfig.BuildProperties.updateAndroidBuildProperty(
      cfg.modResults,
      RENDERSCRIPT_GRADLE_DEFAULTS_KEY,
      'true'
    );
    return cfg;
  });
}

module.exports = withReactNativeImageFilterKit;

const { withMainActivity } = require('@expo/config-plugins');

const KOTLIN_GUARD = `
  override fun onPause() {
    try {
      super.onPause()
    } catch (error: Throwable) {
      if (isReactNativeMissingCurrentActivityPauseAssertion(error)) {
        Log.w("MainActivity", "Ignoring React Native pause before current activity is attached", error)
        return
      }
      throw error
    }
  }

  private fun isReactNativeMissingCurrentActivityPauseAssertion(error: Throwable): Boolean {
    var current: Throwable? = error
    while (current != null) {
      val isReactPauseAssertion =
        current is AssertionError &&
          current.stackTrace.any {
            it.className == "com.facebook.react.ReactInstanceManager" &&
              it.methodName == "onHostPause"
          }
      if (isReactPauseAssertion) return true
      current = current.cause
    }
    return false
  }
`;

function ensureKotlinImport(contents) {
  if (contents.includes('import android.util.Log')) {
    return contents;
  }
  return contents.replace(
    /import android\.os\.Bundle\n/,
    'import android.os.Bundle\nimport android.util.Log\n',
  );
}

function addKotlinPauseGuard(contents) {
  if (contents.includes('isReactNativeMissingCurrentActivityPauseAssertion')) {
    return ensureKotlinImport(contents);
  }

  const contentsWithImport = ensureKotlinImport(contents);
  const classEnd = contentsWithImport.lastIndexOf('\n}');
  if (classEnd < 0) {
    throw new Error('Unable to locate MainActivity class end for React pause guard');
  }

  return `${contentsWithImport.slice(0, classEnd)}${KOTLIN_GUARD}${contentsWithImport.slice(classEnd)}`;
}

function withAndroidReactPauseGuard(config) {
  return withMainActivity(config, (mainActivityConfig) => {
    const { modResults } = mainActivityConfig;
    if (modResults.language !== 'kt') {
      throw new Error(`React pause guard expected Kotlin MainActivity, received ${modResults.language}`);
    }
    modResults.contents = addKotlinPauseGuard(modResults.contents);
    return mainActivityConfig;
  });
}

module.exports = withAndroidReactPauseGuard;

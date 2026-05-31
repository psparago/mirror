package expo.modules.reflectionsaudio

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ReflectionsAudioModule : Module() {
  private var deviceCallback: AudioDeviceCallback? = null

  private val audioManager: AudioManager?
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  override fun definition() = ModuleDefinition {
    // Referenced from JS via `requireNativeModule('ReflectionsAudio')`.
    Name("ReflectionsAudio")

    Events("onAudioRouteChange")

    // Android intentionally does NOT enable hardware AEC for reaction recording. Enabling it would
    // require patching expo-camera's audio source (VOICE_COMMUNICATION), which is a maintenance
    // liability with device-variable results. Echo is handled by the JS volume policy instead.
    // Kept as a no-op so JS can call the same audio-session API on both platforms.
    AsyncFunction("setVoiceChatModeAsync") {
      // no-op
    }

    AsyncFunction("setPlaybackModeAsync") {
      // no-op
    }

    Function("getAudioRoute") {
      describeCurrentRoute()
    }

    OnStartObserving {
      registerDeviceCallback()
    }

    OnStopObserving {
      unregisterDeviceCallback()
    }
  }

  private fun describeCurrentRoute(): Map<String, Any> {
    val manager = audioManager
      ?: return mapOf("hasHeadphones" to false, "outputs" to emptyList<String>())

    val devices = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    val headphoneTypes = setOf(
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_HEARING_AID,
    )
    val hasHeadphones = devices.any { headphoneTypes.contains(it.type) }
    return mapOf(
      "hasHeadphones" to hasHeadphones,
      "outputs" to devices.map { it.type.toString() },
    )
  }

  private fun registerDeviceCallback() {
    val manager = audioManager ?: return
    val callback = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
        sendEvent("onAudioRouteChange", describeCurrentRoute())
      }

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
        sendEvent("onAudioRouteChange", describeCurrentRoute())
      }
    }
    manager.registerAudioDeviceCallback(callback, null)
    deviceCallback = callback
  }

  private fun unregisterDeviceCallback() {
    val manager = audioManager ?: return
    deviceCallback?.let { manager.unregisterAudioDeviceCallback(it) }
    deviceCallback = null
  }
}

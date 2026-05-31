import ExpoModulesCore
import AVFoundation

public class ReflectionsAudioModule: Module {
  private var routeChangeObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    // Referenced from JS via `requireNativeModule('ReflectionsAudio')`.
    Name("ReflectionsAudio")

    Events("onAudioRouteChange")

    // Enables hardware acoustic echo cancellation for record-while-playing (selfie reactions).
    // `.voiceChat` activates Apple's Voice-Processing I/O unit — the same path used by FaceTime —
    // which subtracts the speaker reference signal from the mic input in real time.
    AsyncFunction("setVoiceChatModeAsync") {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
      )
      try session.setActive(true, options: [])
    }

    // Restores a playback-optimised session after recording so video playback is full fidelity.
    AsyncFunction("setPlaybackModeAsync") {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .moviePlayback, options: [])
      try session.setActive(true, options: [])
    }

    Function("getAudioRoute") { () -> [String: Any] in
      return ReflectionsAudioModule.describeCurrentRoute()
    }

    OnStartObserving {
      self.routeChangeObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: AVAudioSession.sharedInstance(),
        queue: OperationQueue.main
      ) { [weak self] _ in
        self?.sendEvent("onAudioRouteChange", ReflectionsAudioModule.describeCurrentRoute())
      }
    }

    OnStopObserving {
      if let observer = self.routeChangeObserver {
        NotificationCenter.default.removeObserver(observer)
        self.routeChangeObserver = nil
      }
    }
  }

  private static func describeCurrentRoute() -> [String: Any] {
    let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
    let headphonePorts: Set<AVAudioSession.Port> = [
      .headphones,
      .bluetoothA2DP,
      .bluetoothLE,
      .bluetoothHFP,
      .usbAudio,
      .carAudio,
    ]
    let hasHeadphones = outputs.contains { headphonePorts.contains($0.portType) }
    return [
      "hasHeadphones": hasHeadphones,
      "outputs": outputs.map { $0.portType.rawValue },
    ]
  }
}

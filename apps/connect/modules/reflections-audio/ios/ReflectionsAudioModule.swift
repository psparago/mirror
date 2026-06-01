import ExpoModulesCore
import AVFoundation

public class ReflectionsAudioModule: Module {
  private var routeChangeObserver: NSObjectProtocol?
  private var voiceChatRouteObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?
  private var voiceChatGuardActive = false
  private var parentRecordingPlayer: AVPlayer?
  private var preparedParentUrl: String?
  private var preparedStartMs: Double?

  public func definition() -> ModuleDefinition {
    // Referenced from JS via `requireNativeModule('ReflectionsAudio')`.
    Name("ReflectionsAudio")

    Events("onAudioRouteChange")

    AsyncFunction("setVoiceChatModeAsync") { () in
      try self.applyVoiceChatSession(reason: "setVoiceChatModeAsync")
    }

    AsyncFunction("beginVoiceChatGuardAsync") { () in
      self.voiceChatGuardActive = true
      try self.applyVoiceChatSession(reason: "beginVoiceChatGuardAsync")
      self.installVoiceChatGuardObservers()
      self.logNative("beginVoiceChatGuardAsync — guard ON")
    }

    AsyncFunction("reassertVoiceChatModeAsync") { () in
      guard self.voiceChatGuardActive else {
        self.logNative("reassertVoiceChatModeAsync — skipped (guard OFF)")
        return
      }
      try self.applyVoiceChatSession(reason: "reassertVoiceChatModeAsync")
    }

    AsyncFunction("endVoiceChatGuardAsync") { () in
      self.logNative("endVoiceChatGuardAsync — guard OFF")
      self.voiceChatGuardActive = false
      self.removeVoiceChatGuardObservers()
      self.stopParentRecordingPlaybackInternal(reason: "endVoiceChatGuardAsync")
    }

    AsyncFunction("prepareParentRecordingPlaybackAsync") { (urlString: String, startMs: Double, volume: Double) async throws in
      guard let url = URL(string: urlString) else {
        self.logNative("prepareParentRecordingPlaybackAsync — invalid URL")
        return
      }

      let clampedVolume = Float(max(0, min(volume, 1)))
      let start = CMTime(seconds: startMs / 1000.0, preferredTimescale: 1000)

      if
        let player = self.parentRecordingPlayer,
        self.preparedParentUrl == urlString,
        player.rate == 0
      {
        player.volume = clampedVolume
        await player.seek(
          to: start,
          toleranceBefore: CMTime(seconds: 0.25, preferredTimescale: 1000),
          toleranceAfter: CMTime(seconds: 0.25, preferredTimescale: 1000)
        )
        self.preparedStartMs = startMs
        self.logNative("prepareParentRecordingPlaybackAsync — re-seek startMs=\(startMs)")
        return
      }

      self.stopParentRecordingPlaybackInternal(reason: "prepareParentRecordingPlaybackAsync-replace")

      let item = AVPlayerItem(url: url)
      let player = AVPlayer(playerItem: item)
      player.volume = clampedVolume
      player.pause()
      self.parentRecordingPlayer = player
      self.preparedParentUrl = urlString
      self.preparedStartMs = startMs

      await player.seek(
        to: start,
        toleranceBefore: CMTime(seconds: 0.25, preferredTimescale: 1000),
        toleranceAfter: CMTime(seconds: 0.25, preferredTimescale: 1000)
      )

      self.logNative(
        "prepareParentRecordingPlaybackAsync — ready startMs=\(startMs) volume=\(volume) urlHost=\(url.host ?? "?")"
      )
    }

    AsyncFunction("startParentRecordingPlaybackAsync") { (urlString: String, startMs: Double, volume: Double) async throws in
      guard let url = URL(string: urlString) else {
        self.logNative("startParentRecordingPlaybackAsync — invalid URL")
        return
      }

      // Avoid tearing down a playing player (reassert paths must not restart S3 seeks).
      if let player = self.parentRecordingPlayer, player.rate > 0 {
        try self.applyVoiceChatSession(reason: "startParentRecordingPlaybackAsync-alreadyPlaying")
        self.logNative("startParentRecordingPlaybackAsync — already playing, VoiceChat re-applied only")
        return
      }

      // Resume a pre-warmed paused player instead of cold-loading S3 on record press.
      if
        let player = self.parentRecordingPlayer,
        self.preparedParentUrl == urlString,
        player.rate == 0
      {
        try self.applyVoiceChatSession(reason: "startParentRecordingPlaybackAsync-resumePrepared")
        player.volume = Float(max(0, min(volume, 1)))
        let start = CMTime(seconds: startMs / 1000.0, preferredTimescale: 1000)
        if let prepared = self.preparedStartMs, abs(prepared - startMs) > 250 {
          await player.seek(
            to: start,
            toleranceBefore: CMTime(seconds: 0.25, preferredTimescale: 1000),
            toleranceAfter: CMTime(seconds: 0.25, preferredTimescale: 1000)
          )
        }
        self.preparedStartMs = startMs
        player.play()
        self.logNative(
          "startParentRecordingPlaybackAsync — resumed prepared startMs=\(startMs) volume=\(volume)"
        )
        return
      }

      try self.applyVoiceChatSession(reason: "startParentRecordingPlaybackAsync")
      self.stopParentRecordingPlaybackInternal(reason: "startParentRecordingPlaybackAsync-replace")

      let item = AVPlayerItem(url: url)
      let player = AVPlayer(playerItem: item)
      player.volume = Float(max(0, min(volume, 1)))
      let start = CMTime(seconds: startMs / 1000.0, preferredTimescale: 1000)
      player.play()
      self.parentRecordingPlayer = player
      await player.seek(
        to: start,
        toleranceBefore: CMTime(seconds: 0.25, preferredTimescale: 1000),
        toleranceAfter: CMTime(seconds: 0.25, preferredTimescale: 1000)
      )

      self.logNative(
        "startParentRecordingPlaybackAsync — play startMs=\(startMs) volume=\(volume) urlHost=\(url.host ?? "?")"
      )
    }

    AsyncFunction("stopParentRecordingPlaybackAsync") { () in
      self.stopParentRecordingPlaybackInternal(reason: "stopParentRecordingPlaybackAsync")
    }

    AsyncFunction("setPlaybackModeAsync") {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .moviePlayback, options: [])
      try session.setActive(true, options: [])
      self.logNative("setPlaybackModeAsync — category=Playback mode=MoviePlayback")
    }

    Function("getAudioRoute") { () -> [String: Any] in
      return ReflectionsAudioModule.describeCurrentRoute()
    }

    Function("getAudioSessionInfo") { () -> [String: Any] in
      var info = self.describeAudioSessionInfo()
      info["nativeModuleVersion"] = 3
      return info
    }

    OnStartObserving {
      self.routeChangeObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: AVAudioSession.sharedInstance(),
        queue: OperationQueue.main
      ) { [weak self] _ in
        guard let self else { return }
        self.sendEvent("onAudioRouteChange", ReflectionsAudioModule.describeCurrentRoute())
      }
    }

    OnStopObserving {
      if let observer = self.routeChangeObserver {
        NotificationCenter.default.removeObserver(observer)
        self.routeChangeObserver = nil
      }
    }
  }

  private func applyVoiceChatSession(reason: String) throws {
    let session = AVAudioSession.sharedInstance()
    let beforeCategory = session.category.rawValue
    let beforeMode = session.mode.rawValue

    try session.setCategory(
      .playAndRecord,
      mode: .voiceChat,
      options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
    )
    try session.setActive(true, options: [])
    try session.overrideOutputAudioPort(.speaker)

    let afterCategory = session.category.rawValue
    let afterMode = session.mode.rawValue
    self.logNative(
      "applyVoiceChatSession(\(reason)) — \(beforeCategory)/\(beforeMode) → \(afterCategory)/\(afterMode)"
    )
  }

  private func installVoiceChatGuardObservers() {
    removeVoiceChatGuardObservers()

    voiceChatRouteObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: AVAudioSession.sharedInstance(),
      queue: OperationQueue.main
    ) { [weak self] _ in
      guard let self, self.voiceChatGuardActive else { return }
      let route = ReflectionsAudioModule.describeCurrentRoute()
      self.logNative("routeChange during guard — outputs=\(route["outputs"] ?? [])")
      try? self.applyVoiceChatSession(reason: "routeChange-guard")
    }

    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: OperationQueue.main
    ) { [weak self] notification in
      guard let self, self.voiceChatGuardActive else { return }
      guard
        let userInfo = notification.userInfo,
        let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
        let type = AVAudioSession.InterruptionType(rawValue: typeValue)
      else {
        return
      }

      if type == .ended {
        self.logNative("interruption ended during guard — re-applying VoiceChat")
        try? self.applyVoiceChatSession(reason: "interruptionEnded-guard")
        self.parentRecordingPlayer?.play()
      } else {
        self.logNative("interruption began during guard")
      }
    }
  }

  private func removeVoiceChatGuardObservers() {
    if let observer = voiceChatRouteObserver {
      NotificationCenter.default.removeObserver(observer)
      voiceChatRouteObserver = nil
    }
    if let observer = interruptionObserver {
      NotificationCenter.default.removeObserver(observer)
      interruptionObserver = nil
    }
  }

  private func stopParentRecordingPlaybackInternal(reason: String) {
    if parentRecordingPlayer != nil {
      self.logNative("stopParentRecordingPlaybackInternal(\(reason))")
    }
    parentRecordingPlayer?.pause()
    parentRecordingPlayer = nil
    preparedParentUrl = nil
    preparedStartMs = nil
  }

  private func describeAudioSessionInfo() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    let route = ReflectionsAudioModule.describeCurrentRoute()
    let player = parentRecordingPlayer
    let playerTimeSec = CMTimeGetSeconds(player?.currentTime() ?? .zero)
    let playerRate = player?.rate ?? 0

    return [
      "category": session.category.rawValue,
      "mode": session.mode.rawValue,
      "isPlayAndRecord": session.category == .playAndRecord,
      "isVoiceChatMode": session.mode == .voiceChat,
      "isOtherAudioPlaying": session.isOtherAudioPlaying,
      "voiceChatGuardActive": voiceChatGuardActive,
      "nativeParentPlaybackActive": player != nil,
      "nativeParentPlaying": playerRate > 0,
      "nativeParentVolume": player?.volume ?? 0,
      "nativeParentRate": playerRate,
      "nativeParentTimeSec": playerTimeSec.isFinite ? playerTimeSec : 0,
      "nativeModuleLoaded": true,
      "outputs": route["outputs"] ?? [],
      "inputs": session.currentRoute.inputs.map { $0.portType.rawValue },
      "hasHeadphones": route["hasHeadphones"] ?? false,
    ]
  }

  private func logNative(_ message: String) {
    #if DEBUG
    print("[ReflectionsAudio] \(message)")
    #endif
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

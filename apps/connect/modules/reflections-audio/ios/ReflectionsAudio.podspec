Pod::Spec.new do |s|
  s.name           = 'ReflectionsAudio'
  s.version        = '1.0.0'
  s.summary        = 'Hardware AEC + audio route detection for Reflections Connect'
  s.description    = 'Local Expo module that enables AVAudioSession VoiceChat mode for echo-cancelled selfie reaction recording and exposes the current audio output route.'
  s.author         = 'Reflections'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.swift_version  = '5.4'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

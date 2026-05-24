import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS } from '@projectmirror/shared';
import { Audio } from 'expo-av';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  VOICE_OPTIONS,
  type VoiceOption,
  type VoicePickerTarget,
} from '@/utils/ttsVoices';

type VoicePickerModalProps = {
  visible: boolean;
  target: VoicePickerTarget | null;
  captionVoice: string;
  deepDiveVoice: string;
  onSelect: (voice: VoiceOption) => void;
  onClose: () => void;
};

export function VoicePickerModal({
  visible,
  target,
  captionVoice,
  deepDiveVoice,
  onSelect,
  onClose,
}: VoicePickerModalProps) {
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  const stopSample = useCallback(async () => {
    if (soundRef.current) {
      try {
        await soundRef.current.unloadAsync();
      } catch {
        /* ignore */
      }
      soundRef.current = null;
    }
    setPlayingVoice(null);
  }, []);

  const playVoiceSample = useCallback(
    async (voiceValue: string) => {
      if (playingVoice === voiceValue) {
        await stopSample();
        return;
      }
      await stopSample();
      setPlayingVoice(voiceValue);
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        });
        const res = await fetch(
          `${API_ENDPOINTS.GET_VOICE_SAMPLE}?voice=${encodeURIComponent(voiceValue)}`,
        );
        if (!res.ok) throw new Error('Failed to fetch sample URL');
        const { url } = await res.json();
        const { sound } = await Audio.Sound.createAsync(
          { uri: url },
          { shouldPlay: true, volume: 1.0 },
        );
        soundRef.current = sound;
        await sound.setVolumeAsync(1.0);
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            stopSample();
          }
        });
      } catch {
        setPlayingVoice(null);
      }
    },
    [playingVoice, stopSample],
  );

  useEffect(() => {
    if (!visible) {
      void stopSample();
    }
  }, [visible, stopSample]);

  useEffect(() => {
    return () => {
      void stopSample();
    };
  }, [stopSample]);

  const handleClose = () => {
    void stopSample();
    onClose();
  };

  const handleSelect = (voice: VoiceOption) => {
    void stopSample();
    onSelect(voice);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>
            {target === 'caption' ? 'Caption Voice' : 'Rich Narration Voice'}
          </Text>

          <ScrollView style={styles.modalList} showsVerticalScrollIndicator={false}>
            {VOICE_OPTIONS.map((voice) => {
              const isSelected =
                target === 'caption'
                  ? captionVoice === voice.value
                  : deepDiveVoice === voice.value;
              const isPlaying = playingVoice === voice.value;
              return (
                <TouchableOpacity
                  key={voice.value}
                  style={[styles.modalOption, isSelected && styles.modalOptionActive]}
                  onPress={() => handleSelect(voice)}
                  activeOpacity={0.7}
                >
                  <View style={styles.modalOptionHeader}>
                    <Text
                      style={[
                        styles.modalOptionLabel,
                        isSelected && styles.modalOptionLabelActive,
                      ]}
                    >
                      {voice.label}
                    </Text>
                    <View style={styles.modalOptionActions}>
                      <TouchableOpacity
                        onPress={(e) => {
                          e.stopPropagation();
                          void playVoiceSample(voice.value);
                        }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        style={styles.sampleBtn}
                      >
                        <FontAwesome
                          name={isPlaying ? 'stop-circle' : 'volume-up'}
                          size={18}
                          color={isPlaying ? '#ff6b6b' : '#5aadde'}
                        />
                      </TouchableOpacity>
                      {isSelected ? <Text style={styles.modalCheckmark}>✓</Text> : null}
                    </View>
                  </View>
                  <Text style={styles.modalOptionDesc}>{voice.description}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <TouchableOpacity style={styles.modalCloseBtn} onPress={handleClose}>
            <Text style={styles.modalCloseBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#1e1e1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 34,
    maxHeight: '85%',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
    textAlign: 'center',
  },
  modalList: {
    maxHeight: 420,
  },
  modalOption: {
    backgroundColor: '#2a2a2a',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  modalOptionActive: {
    backgroundColor: 'rgba(46,120,183,0.2)',
    borderColor: '#2e78b7',
  },
  modalOptionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  modalOptionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sampleBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalOptionLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalOptionLabelActive: {
    color: '#5aadde',
  },
  modalCheckmark: {
    color: '#2e78b7',
    fontSize: 18,
    fontWeight: '700',
  },
  modalOptionDesc: {
    color: '#aaa',
    fontSize: 13,
    lineHeight: 18,
  },
  modalCloseBtn: {
    alignItems: 'center',
    paddingVertical: 14,
    backgroundColor: '#333',
    borderRadius: 12,
    marginTop: 8,
  },
  modalCloseBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

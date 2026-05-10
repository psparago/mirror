import { FontAwesome } from '@expo/vector-icons';
import { useExplorer } from '@projectmirror/shared';
import React, { useState } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

export interface TutorialCarouselProps {
  onFinish: (didView: boolean) => void;
  showSkip?: boolean;
}

interface Slide {
  icon: React.ComponentProps<typeof FontAwesome>['name'];
  iconColor: string;
  title: string;
  body: (explorerLabel: string) => string;
}

const SLIDES: Slide[] = [
  {
    icon: 'film',
    iconColor: '#2e78b7',
    title: 'What is a Reflection?',
    body: (explorerLabel) =>
      `A Reflection is a short video or photo you send to ${explorerLabel}. It appears on their screen, paused and waiting — ready to watch whenever they choose.`,
  },
  {
    icon: 'microphone',
    iconColor: '#fcd34d',
    title: 'Your Voice Sets the Stage',
    body: () =>
      `Before the video plays, a short audio intro from you provides context. Record it yourself, or we'll generate one automatically using AI.`,
  },
  {
    icon: 'video-camera',
    iconColor: '#4ade80',
    title: 'Ready to Create',
    body: () =>
      `Tap the camera or gallery icon to start your first Reflection. The creation screen has a "How it works" link if you ever need a refresher.`,
  },
];

export function TutorialCarousel({ onFinish, showSkip }: TutorialCarouselProps) {
  const { explorerName } = useExplorer();
  const [currentSlide, setCurrentSlide] = useState(0);

  const explorerLabel = explorerName || 'the Explorer';
  const slide = SLIDES[currentSlide];
  const isLast = currentSlide === SLIDES.length - 1;

  const handleNext = () => {
    if (isLast) {
      onFinish(true);
    } else {
      setCurrentSlide((prev) => prev + 1);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        {/* Skip / Done button */}
        {showSkip && (
          <TouchableOpacity
            style={styles.skipButton}
            onPress={() => onFinish(false)}
            activeOpacity={0.7}
          >
            <Text style={styles.skipText}>Done</Text>
          </TouchableOpacity>
        )}

        {/* Slide content */}
        <View style={styles.slideContent}>
          <View style={[styles.iconCircle, { backgroundColor: `${slide.iconColor}22` }]}>
            <FontAwesome name={slide.icon} size={52} color={slide.iconColor} />
          </View>

          <Text style={styles.slideTitle}>{slide.title}</Text>
          <Text style={styles.slideBody}>{slide.body(explorerLabel)}</Text>
        </View>

        {/* Progress dots */}
        <View style={styles.dotsRow}>
          {SLIDES.map((_, i) => (
            <View key={i} style={[styles.dot, i === currentSlide && styles.dotActive]} />
          ))}
        </View>

        {/* Next / Let's Go */}
        <TouchableOpacity
          style={styles.nextButton}
          onPress={handleNext}
          activeOpacity={0.85}
        >
          <Text style={styles.nextButtonText}>{isLast ? "Let's Go!" : 'Next'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#121212',
  },
  container: {
    flex: 1,
    paddingHorizontal: 28,
    paddingBottom: 36,
    justifyContent: 'space-between',
  },
  skipButton: {
    alignSelf: 'flex-end',
    paddingTop: 16,
    paddingBottom: 8,
  },
  skipText: {
    color: '#888',
    fontSize: 15,
    fontWeight: '500',
  },
  slideContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },
  iconCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  slideTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
  },
  slideBody: {
    fontSize: 16,
    color: '#aaa',
    lineHeight: 25,
    textAlign: 'center',
    maxWidth: 320,
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 24,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#333',
  },
  dotActive: {
    backgroundColor: '#2e78b7',
    width: 20,
  },
  nextButton: {
    backgroundColor: '#2e78b7',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  nextButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
});

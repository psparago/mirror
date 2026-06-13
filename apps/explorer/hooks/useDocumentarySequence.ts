import {
  buildDocumentaryChapters,
  resolveChapterSubtitle,
  shouldBypassDeepDive,
} from '@projectmirror/shared';
import type { CompanionAvatar, DocumentaryChapter, Event, EventMetadata } from '@projectmirror/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Phase = 'idle' | 'playing' | 'complete';

export interface DocState {
  chapters: DocumentaryChapter[];
  currentIndex: number;
  activeEvent: Event | null;
  activeSubtitle: string | null;
  phase: Phase;
  bypassDeepDive: boolean;
  isPlayingSequence: boolean;
}

export interface GotoIndexOptions {
  index: number;
  sendSelectEvent: (ev: Event, meta: EventMetadata, takeSelfie: boolean) => void;
  takeSelfie: boolean;
}

export interface ChapterFinishedOptions {
  sendSelectEventInstant: (ev: Event, meta: EventMetadata, takeSelfie: boolean) => void;
  takeSelfie: boolean;
}

export interface DocActions {
  markPlaying: () => void;
  reset: () => void;
  onChapterFinished: (opts: ChapterFinishedOptions) => void;
  gotoIndex: (opts: GotoIndexOptions) => void;
}

function buildFallbackMeta(chapter: DocumentaryChapter): EventMetadata {
  return {
    event_id: chapter.event.event_id,
    description: chapter.speakerName,
    short_caption: chapter.speakerName,
    sender: chapter.speakerName,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Manages the documentary sequence state.
 * Returns a `[docState, docActions]` tuple.
 */
export function useDocumentarySequence(
  selectedEvent: Event | null | undefined,
  reactionsByParentId: Map<string, Event[]> | undefined,
  eventMetadata: Record<string, EventMetadata>,
  companions: CompanionAvatar[],
): [DocState, DocActions] {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');

  // Stable refs so callbacks always see the latest values without stale closures
  const currentIndexRef = useRef(0);
  const phaseRef = useRef<Phase>('idle');
  const prevEventIdRef = useRef<string | null>(null);
  const advanceGuardRef = useRef(false);

  const chapters = useMemo((): DocumentaryChapter[] => {
    if (!selectedEvent) return [];
    const reactions = reactionsByParentId?.get(selectedEvent.event_id) ?? [];
    return buildDocumentaryChapters(selectedEvent, reactions, eventMetadata, companions);
  }, [selectedEvent, reactionsByParentId, eventMetadata, companions]);

  const chaptersRef = useRef(chapters);
  const eventMetadataRef = useRef(eventMetadata);

  useEffect(() => {
    chaptersRef.current = chapters;
    eventMetadataRef.current = eventMetadata;
  }, [chapters, eventMetadata]);

  // Reset when the base Reflection changes
  useEffect(() => {
    const newId = selectedEvent?.event_id ?? null;
    if (newId === prevEventIdRef.current) return;
    prevEventIdRef.current = newId;
    currentIndexRef.current = 0;
    phaseRef.current = 'idle';
    advanceGuardRef.current = false;
    setCurrentIndex(0);
    setPhase('idle');
  }, [selectedEvent?.event_id]);

  // Keep refs in sync with state
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const activeChapter = chapters[currentIndex] ?? null;
  const activeEvent = activeChapter?.event ?? selectedEvent ?? null;
  const activeSubtitle = activeChapter ? resolveChapterSubtitle(activeChapter) : null;
  const bypassDeepDive = shouldBypassDeepDive(chapters);
  const isPlayingSequence = phase === 'playing' && chapters.length > 1;

  const markPlaying = useCallback(() => {
    phaseRef.current = 'playing';
    advanceGuardRef.current = false;
    setPhase('playing');
  }, []);

  const reset = useCallback(() => {
    currentIndexRef.current = 0;
    phaseRef.current = 'playing';
    advanceGuardRef.current = false;
    setCurrentIndex(0);
    setPhase('playing');
  }, []);

  const onChapterFinished = useCallback(
    ({ sendSelectEventInstant, takeSelfie }: ChapterFinishedOptions) => {
      if (advanceGuardRef.current) return;
      if (phaseRef.current !== 'playing') return;

      const currentChapters = chaptersRef.current;
      const idx = currentIndexRef.current;
      const nextIndex = idx + 1;

      if (nextIndex < currentChapters.length) {
        advanceGuardRef.current = true;
        const nextChapter = currentChapters[nextIndex];
        const meta =
          eventMetadataRef.current[nextChapter.event.event_id] ??
          buildFallbackMeta(nextChapter);
        currentIndexRef.current = nextIndex;
        setCurrentIndex(nextIndex);
        sendSelectEventInstant(nextChapter.event, meta, takeSelfie);
        // Release the guard after a short delay so subsequent chapters can advance
        setTimeout(() => { advanceGuardRef.current = false; }, 300);
      } else {
        // Sequence complete
        phaseRef.current = 'complete';
        setPhase('complete');
      }
    },
    [], // All values accessed via refs
  );

  const gotoIndex = useCallback(
    ({ index, sendSelectEvent, takeSelfie }: GotoIndexOptions) => {
      const currentChapters = chaptersRef.current;
      if (index < 0 || index >= currentChapters.length) return;
      const chapter = currentChapters[index];
      const meta =
        eventMetadataRef.current[chapter.event.event_id] ??
        buildFallbackMeta(chapter);
      currentIndexRef.current = index;
      phaseRef.current = 'playing';
      advanceGuardRef.current = false;
      setCurrentIndex(index);
      setPhase('playing');
      sendSelectEvent(chapter.event, meta, takeSelfie);
    },
    [],
  );

  const docState: DocState = {
    chapters,
    currentIndex,
    activeEvent,
    activeSubtitle,
    phase,
    bypassDeepDive,
    isPlayingSequence,
  };

  const docActions: DocActions = { markPlaying, reset, onChapterFinished, gotoIndex };

  return [docState, docActions];
}

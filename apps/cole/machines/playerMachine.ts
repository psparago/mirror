import { Event, EventMetadata } from '@projectmirror/shared';
import { assign, setup } from 'xstate';

// 1. CONTEXT (The State Data)
// Think of this as the "Struct" that holds the machine's memory.
export interface PlayerContext {
    event: Event | null;      // The current Reflection
    metadata: EventMetadata | null;
    hasSpoken: boolean;       // Did we finish the TTS/Intro?
    videoFinished: boolean;   // Did the video reach the end?
}

// 2. EVENTS (The Inputs)
// These are the signals the React UI sends to the Machine.
export type PlayerEvent =
    | { type: 'SELECT_EVENT'; event: Event; metadata: EventMetadata }
    | { type: 'METADATA_LOADED'; metadata: EventMetadata }
    | { type: 'NARRATION_FINISHED' }
    | { type: 'VIDEO_FINISHED' }
    | { type: 'AUDIO_FINISHED' }
    | { type: 'TELL_ME_MORE' }
    | { type: 'REPLAY' }
    | { type: 'SWIPE_NEXT' } // Handled by parent, but machine needs to know to reset
    | { type: 'SWIPE_PREV' } // Handled by parent
    | { type: 'CLOSE' };

// 3. THE MACHINE
export const playerMachine = setup({
    types: {
        context: {} as PlayerContext,
        events: {} as PlayerEvent,
    },
    actions: {
        stopAllMedia: () => { },   // The Kill Switch
        speakCaption: () => { },   // TTS Logic
        playVideo: () => { },      // Video Player Logic
        playAudio: () => { },      // Voice Message Logic
        playDeepDive: () => { },   // Deep Dive TTS Logic
        showSelfieBubble: () => { }, // Show selfie bubble
        triggerSelfie: () => { },  // The Magic Mirror Snap
    },
}).createMachine({
    id: 'lookingGlassPlayer',
    initial: 'idle',

    // Initial Context
    context: {
        event: null,
        metadata: null,
        hasSpoken: false,
        videoFinished: false,
    },

    // GLOBAL LISTENERS
    on: {
        CLOSE: {
            target: '.idle',
            actions: ['stopAllMedia', assign({ event: null, metadata: null })]
        },
        SELECT_EVENT: {
            target: '.loading',
            actions: [
                'stopAllMedia',
                assign({
                    event: ({ event }) => event.event,
                    metadata: ({ event }) => event.metadata,
                    hasSpoken: false,
                    videoFinished: false
                })
            ]
        }
    },

    states: {
        idle: {},

        loading: {
            always: [
                {
                    // PATH A: Has VIDEO URL - always play as video (even if labeled "Voice message")
                    guard: ({ context }) => !!(context.event as any)?.video_url,
                    target: 'playingVideo'
                },
                {
                    // PATH B: Has AUDIO but NO VIDEO - play as audio-only voice message
                    guard: ({ context }) => {
                        const hasAudio = !!(context.event as any)?.audio_url;
                        const hasVideo = !!(context.event as any)?.video_url;
                        return hasAudio && !hasVideo;
                    },
                    target: 'playingAudio'
                },
                {
                    // PATH C: It's a PHOTO (no video, no audio)
                    target: 'viewingPhoto'
                }
            ]
        },

        // 🎥 VIDEO LOGIC
        playingVideo: {
            initial: 'narrating',
            states: {
                narrating: {
                    entry: 'speakCaption',
                    on: {
                        NARRATION_FINISHED: 'playing',
                        VIDEO_FINISHED: '#lookingGlassPlayer.finished'
                    }
                },
                playing: {
                    entry: 'playVideo',
                    type: 'parallel',
                    states: {
                        video: {
                            on: {
                                VIDEO_FINISHED: '#lookingGlassPlayer.finished'
                            }
                        },
                        selfie: {
                            initial: 'waiting',
                            states: {
                                waiting: { after: { 1000: 'snap' } },
                                snap: {
                                    entry: 'triggerSelfie',
                                    type: 'final'
                                }
                            }
                        }
                    }
                }
            }
        },

        // 🎤 AUDIO LOGIC (Voice Messages)
        playingAudio: {
            entry: 'playAudio',
            type: 'parallel',
            states: {
                audio: {
                    on: {
                        AUDIO_FINISHED: '#lookingGlassPlayer.finished'
                    }
                },
                selfie: {
                    initial: 'waiting',
                    states: {
                        waiting: { after: { 1500: 'snap' } }, // Wait 1.5s for reaction
                        snap: {
                            entry: 'triggerSelfie',
                            type: 'final'
                        }
                    }
                }
            }
        },

        // 📸 PHOTO LOGIC
        viewingPhoto: {
            initial: 'narrating',
            on: {
                REPLAY: { target: '.narrating' },
                TELL_ME_MORE: '#lookingGlassPlayer.playingDeepDive' // Allow deep dive from photo viewing
            },
            states: {
                narrating: {
                    entry: 'speakCaption',
                    on: {
                        NARRATION_FINISHED: 'viewing'
                    }
                },
                viewing: {
                    entry: 'showSelfieBubble', // Show bubble before capture
                    initial: 'waiting',
                    states: {
                        waiting: { after: { 200: 'snap' } }, // Fast snap for photos
                        snap: {
                            entry: 'triggerSelfie',
                            type: 'final'
                        }
                    }
                }
            }
        },

        // ✨ DEEP DIVE LOGIC
        playingDeepDive: {
            entry: 'playDeepDive',
            on: {
                NARRATION_FINISHED: '#lookingGlassPlayer.finished'
            }
        },

        // 🏁 FINISHED STATE
        finished: {
            entry: assign({ videoFinished: true }),
            on: {
                REPLAY: [
                    {
                        // Has VIDEO - replay as video (even if has audio caption)
                        guard: ({ context }) => !!(context.event as any)?.video_url,
                        target: 'playingVideo.playing',
                        actions: assign({ videoFinished: false })
                    },
                    {
                        // Has AUDIO but NO VIDEO - replay as audio-only
                        guard: ({ context }) => {
                            const hasAudio = !!(context.event as any)?.audio_url;
                            const hasVideo = !!(context.event as any)?.video_url;
                            return hasAudio && !hasVideo;
                        },
                        target: 'playingAudio',
                        actions: assign({ videoFinished: false })
                    },
                    {
                        // Photo - replay from narration
                        target: 'viewingPhoto.narrating'
                    }
                ],
                TELL_ME_MORE: 'playingDeepDive'
            }
        }
    }
});
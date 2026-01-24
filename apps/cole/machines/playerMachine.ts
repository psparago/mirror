import { Event, EventMetadata } from '@projectmirror/shared';
import { assign, setup } from 'xstate';

// 1. CONTEXT
export interface PlayerContext {
    event: Event | null;
    metadata: EventMetadata | null;
    hasSpoken: boolean;
    videoFinished: boolean;
    selfieTaken: boolean;
}

// 2. EVENTS
export type PlayerEvent =
    | { type: 'SELECT_EVENT'; event: Event; metadata: EventMetadata }
    | { type: 'SELECT_EVENT_INSTANT'; event: Event; metadata: EventMetadata }
    | { type: 'METADATA_LOADED'; metadata: EventMetadata }
    | { type: 'NARRATION_FINISHED' }
    | { type: 'VIDEO_FINISHED' }
    | { type: 'AUDIO_FINISHED' }
    | { type: 'TELL_ME_MORE' }
    | { type: 'REPLAY' }
    | { type: 'PAUSE' }
    | { type: 'RESUME' }
    | { type: 'SWIPE_NEXT' }
    | { type: 'SWIPE_PREV' }
    | { type: 'CLOSE' };

// 3. THE MACHINE
export const playerMachine = setup({
    types: {
        context: {} as PlayerContext,
        events: {} as PlayerEvent,
    },
    actions: {
        stopAllMedia: () => { },
        speakCaption: () => { },
        playVideo: () => { },
        playAudio: () => { },
        playDeepDive: () => { },
        showSelfieBubble: () => { },
        triggerSelfie: () => { },
        pauseMedia: () => { },
        resumeMedia: () => { },
    },
}).createMachine({
    id: 'lookingGlassPlayer',
    initial: 'idle',

    context: {
        event: null,
        metadata: null,
        hasSpoken: false,
        videoFinished: false,
        selfieTaken: false,
    },

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
                    videoFinished: false,
                    selfieTaken: false
                })
            ]
        },
        SELECT_EVENT_INSTANT: {
            target: '.loadingInstant',
            actions: [
                'stopAllMedia',
                assign({
                    event: ({ event }) => event.event,
                    metadata: ({ event }) => event.metadata,
                    hasSpoken: true, // Skip narration
                    videoFinished: false,
                    selfieTaken: false
                })
            ]
        }
    },

    states: {
        idle: {},

        loading: {
            always: [
                {
                    guard: ({ context }) => !!(context.event as any)?.video_url,
                    target: 'playingVideo'
                },
                {
                    guard: ({ context }) => {
                        const hasAudio = !!(context.event as any)?.audio_url;
                        const hasVideo = !!(context.event as any)?.video_url;
                        return hasAudio && !hasVideo;
                    },
                    target: 'playingAudio'
                },
                { target: 'viewingPhoto' }
            ]
        },

        // Instant loading - skips narration for videos
        loadingInstant: {
            always: [
                {
                    guard: ({ context }) => !!(context.event as any)?.video_url,
                    target: 'playingVideoInstant'
                },
                {
                    guard: ({ context }) => {
                        const hasAudio = !!(context.event as any)?.audio_url;
                        const hasVideo = !!(context.event as any)?.video_url;
                        return hasAudio && !hasVideo;
                    },
                    target: 'playingAudio'
                },
                { target: 'viewingPhoto' }
            ]
        },

        playingVideo: {
            type: 'parallel',
            tags: ['video_mode'],
            states: {
                playback: {
                    initial: 'narrating',
                    entry: 'speakCaption',
                    states: {
                        narrating: {
                            tags: ['speaking', 'active'],
                            on: {
                                NARRATION_FINISHED: {
                                    target: 'playing',
                                    actions: [assign({ hasSpoken: true }), 'playVideo']
                                },
                                PAUSE: 'paused'
                            }
                        },
                        playing: {
                            tags: ['playing', 'active', 'video', 'loadingVideo'],
                            on: {
                                PAUSE: 'paused',
                                VIDEO_FINISHED: '#lookingGlassPlayer.finished'
                            }
                        },
                        paused: {
                            tags: ['paused', 'active'],
                            entry: 'pauseMedia',
                            on: {
                                RESUME: [
                                    { guard: ({ context }: { context: PlayerContext }) => !context.hasSpoken, target: 'narrating', actions: 'resumeMedia' },
                                    { target: 'playing', actions: 'resumeMedia' }
                                ]
                            }
                        }
                    }
                },
                selfie: {
                    initial: 'waitingForStart',
                    states: {
                        waitingForStart: {
                            always: {
                                guard: ({ context }) => context.hasSpoken,
                                target: 'evaluating'
                            }
                        },
                        evaluating: {
                            always: [
                                { guard: ({ context }: { context: PlayerContext }) => context.selfieTaken, target: 'done' },
                                { target: 'waiting' }
                            ]
                        },
                        waiting: {
                            after: { 5000: 'snap' }
                        },
                        snap: {
                            entry: ['triggerSelfie', assign({ selfieTaken: true })],
                            target: 'done'
                        },
                        done: { type: 'final' }
                    }
                }
            }
        },

        // Instant video playback - skips narration, starts video immediately
        playingVideoInstant: {
            type: 'parallel',
            tags: ['video_mode'],
            states: {
                playback: {
                    initial: 'playing',
                    entry: 'playVideo', // Start video immediately
                    states: {
                        playing: {
                            tags: ['playing', 'active', 'video', 'loadingVideo'],
                            on: {
                                PAUSE: 'paused',
                                VIDEO_FINISHED: '#lookingGlassPlayer.finished'
                            }
                        },
                        paused: {
                            tags: ['paused', 'active'],
                            entry: 'pauseMedia',
                            on: {
                                RESUME: {
                                    target: 'playing',
                                    actions: 'resumeMedia'
                                }
                            }
                        }
                    }
                },
                selfie: {
                    initial: 'evaluating',
                    states: {
                        evaluating: {
                            always: [
                                { guard: ({ context }: { context: PlayerContext }) => context.selfieTaken, target: 'done' },
                                { target: 'waiting' }
                            ]
                        },
                        waiting: {
                            after: { 5000: 'snap' }
                        },
                        snap: {
                            entry: ['triggerSelfie', assign({ selfieTaken: true })],
                            target: 'done'
                        },
                        done: { type: 'final' }
                    }
                }
            }
        },

        playingAudio: {
            type: 'parallel',
            tags: ['audio_mode'],
            states: {
                playback: {
                    initial: 'playing',
                    entry: 'playAudio',
                    states: {
                        playing: {
                            tags: ['playing', 'active'],
                            on: {
                                PAUSE: 'paused',
                                AUDIO_FINISHED: '#lookingGlassPlayer.finished'
                            }
                        },
                        paused: {
                            tags: ['paused', 'active'],
                            entry: 'pauseMedia',
                            on: {
                                RESUME: {
                                    target: 'playing',
                                    actions: 'resumeMedia'
                                }
                            }
                        }
                    }
                },
                selfie: {
                    initial: 'evaluating',
                    states: {
                        evaluating: {
                            always: [
                                { guard: ({ context }: { context: PlayerContext }) => context.selfieTaken, target: 'done' },
                                { target: 'waiting' }
                            ]
                        },
                        waiting: { after: { 5000: 'snap' } },
                        snap: {
                            entry: ['triggerSelfie', assign({ selfieTaken: true })],
                            target: 'done'
                        },
                        done: { type: 'final' }
                    }
                }
            }
        },

        viewingPhoto: {
            initial: 'narrating',
            on: {
                REPLAY: { target: '.narrating' },
                TELL_ME_MORE: '#lookingGlassPlayer.playingDeepDive'
            },
            states: {
                narrating: {
                    entry: 'speakCaption',
                    tags: ['speaking', 'active'],
                    on: { NARRATION_FINISHED: 'viewing' }
                },
                viewing: {
                    entry: 'showSelfieBubble',
                    initial: 'waiting',
                    states: {
                        waiting: { after: { 5000: 'snap' } },
                        snap: {
                            entry: 'triggerSelfie',
                            type: 'final'
                        }
                    }
                }
            }
        },

        playingDeepDive: {
            initial: 'active',
            tags: ['audio_mode'],
            states: {
                active: {
                    initial: 'playing',
                    entry: 'playDeepDive',
                    states: {
                        playing: {
                            tags: ['playing', 'active'],
                            on: {
                                PAUSE: 'paused',
                                NARRATION_FINISHED: '#lookingGlassPlayer.finished'
                            }
                        },
                        paused: {
                            tags: ['paused', 'active'],
                            entry: 'pauseMedia',
                            on: {
                                RESUME: {
                                    target: 'playing',
                                    actions: 'resumeMedia'
                                }
                            }
                        }
                    }
                }
            }
        },

        finished: {
            entry: assign({ videoFinished: true }),
            on: {
                REPLAY: [
                    {
                        guard: ({ context }: { context: PlayerContext }) => !!(context.event as any)?.video_url,
                        target: 'playingVideo',
                        actions: ['stopAllMedia', assign({ videoFinished: false, selfieTaken: false, hasSpoken: false })]
                    },
                    {
                        guard: ({ context }: { context: PlayerContext }) => {
                            const hasAudio = !!(context.event as any)?.audio_url;
                            const hasVideo = !!(context.event as any)?.video_url;
                            return hasAudio && !hasVideo;
                        },
                        target: 'playingAudio',
                        actions: ['stopAllMedia', assign({ videoFinished: false, selfieTaken: false, hasSpoken: false })]
                    },
                    {
                        target: 'viewingPhoto.narrating',
                        actions: ['stopAllMedia', assign({ selfieTaken: false, hasSpoken: false })]
                    }
                ],
                TELL_ME_MORE: 'playingDeepDive'
            }
        }
    }
});
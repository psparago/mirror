/**
 * @projectmirror/shared
 * Shared code between Cole and Companion apps
 */

// API endpoints
export * from './api/endpoints';

// S3 utilities
export * from './s3/constants';
export * from './s3/upload';

// Types
export * from './types';

export * from './firebase';

export * from './auth/AuthContext';

export * from './explorer/ExplorerConfig';
export * from './explorer/ExplorerContext';

// Hooks
export * from './hooks/useCompanionAvatars';
export * from './hooks/useThrottledCallback';

// Components
export { default as VersionDisplay } from './components/VersionDisplay';
export { AvatarFilterBar } from './components/AvatarFilterBar';
export type { AvatarFilterBarProps } from './components/AvatarFilterBar';

// Utilities
export * from './utils/avatarDefaults';
export * from './reflections/likes';

// State machines
export * from './machines/playerMachine';

// Video (cloud master / expo-video helpers)
export * from './video/cloudMasterVideo';
export { default as VideoTrimSlider } from './video/VideoTrimSlider';
export type { VideoTrimSliderProps } from './video/VideoTrimSlider';

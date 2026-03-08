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

// Components
export { default as VersionDisplay } from './components/VersionDisplay';

// Utilities
export * from './utils/avatarDefaults';

// State machines
export * from './machines/playerMachine';

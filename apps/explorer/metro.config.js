const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Prioritize React Native over Web/Browser
config.resolver.resolverMainFields = ['react-native', 'browser', 'main'];

// 2. Add mjs support (required by Firebase v10+)
config.resolver.sourceExts = [...config.resolver.sourceExts, 'ts', 'tsx', 'js', 'jsx', 'json', 'mjs'];

// 3. Monorepo Watch Folders
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.(test|spec).(ts|tsx)'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
};

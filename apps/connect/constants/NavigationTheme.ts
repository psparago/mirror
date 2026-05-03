import { DefaultTheme, type Theme } from '@react-navigation/native';

export const NAV_COLORS = {
  background: '#000000',
  card: '#0d1117',
  header: '#0f2027',
  headerBorder: 'rgba(255,255,255,0.12)',
  text: '#ffffff',
  textMuted: 'rgba(255,255,255,0.68)',
  tabActive: '#4FC3F7',
  tabInactive: 'rgba(255,255,255,0.58)',
  tabBorder: 'rgba(255,255,255,0.14)',
} as const;

export const ReflectionsNavigationTheme: Theme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: NAV_COLORS.tabActive,
    background: NAV_COLORS.background,
    card: NAV_COLORS.card,
    text: NAV_COLORS.text,
    border: NAV_COLORS.tabBorder,
    notification: NAV_COLORS.tabActive,
  },
};

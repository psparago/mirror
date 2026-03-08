const AVATAR_PALETTE = [
  '#E57373', '#F06292', '#BA68C8', '#9575CD',
  '#7986CB', '#64B5F6', '#4FC3F7', '#4DD0E1',
  '#4DB6AC', '#81C784', '#AED581', '#FFD54F',
  '#FFB74D', '#FF8A65', '#A1887F', '#90A4AE',
] as const;

export function getAvatarColor(userId: string): string {
  const hash = userId.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

export function getAvatarInitial(name: string): string {
  return (name || '?')[0].toUpperCase();
}

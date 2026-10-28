export const en = {
  agent: 'Agent', sync: 'Sync now', syncing: 'Syncing…', menu: 'Owner menu',
  status: 'Sync data', settings: 'Settings', close: 'Close', refresh: 'Refresh', loading: 'Loading…', courses: 'Courses',
  error: 'Could not load or save data. Refresh to try again.',
  theme: 'Theme', language: 'Language', system: 'System', light: 'Light', dark: 'Dark',
  palette: 'Palette', palettes: { mono: 'Ink', mist: 'Mist', pine: 'Pine', stone: 'Stone', morty: 'Morty' },
};
export const zh: typeof en = {
  agent: 'Agent', sync: '立即同步', syncing: '同步中…', menu: '用户菜单',
  status: '同步数据', settings: '设置', close: '关闭', refresh: '刷新', loading: '加载中…', courses: '课程',
  error: '无法读取或保存数据，请刷新重试。',
  theme: '主题', language: '语言', system: '跟随系统', light: '浅色', dark: '深色',
  palette: '配色', palettes: { mono: '墨', mist: '雾蓝', pine: '松', stone: '石', morty: '谷鱼' },
};
export type Copy = typeof en;
export type Language = 'en' | 'zh';
export type Theme = 'system' | 'light' | 'dark';

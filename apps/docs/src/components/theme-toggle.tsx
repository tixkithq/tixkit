'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function preferredTheme(): Theme {
  const saved = window.localStorage.getItem('tixkit-docs-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    const value = preferredTheme();
    setTheme(value);
    document.documentElement.dataset.theme = value;
  }, []);

  function toggle() {
    const value = theme === 'light' ? 'dark' : 'light';
    setTheme(value);
    document.documentElement.dataset.theme = value;
    window.localStorage.setItem('tixkit-docs-theme', value);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} theme`}
    >
      {theme === 'light' ? 'Dark' : 'Light'} theme
    </button>
  );
}

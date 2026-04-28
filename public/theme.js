(() => {
  try {
    const root = document.documentElement;
    const stored = localStorage.getItem('plexDonateTheme');
    const prefersDark =
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme =
      stored === 'dark' || stored === 'light'
        ? stored
        : prefersDark
          ? 'dark'
          : 'light';
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const lightColor = root.dataset.themeLightColor || '#f8fafc';
      const darkColor = root.dataset.themeDarkColor || '#0f172a';
      meta.setAttribute('content', theme === 'dark' ? darkColor : lightColor);
    }
  } catch (err) {
    document.documentElement.dataset.theme = 'dark';
  }
})();


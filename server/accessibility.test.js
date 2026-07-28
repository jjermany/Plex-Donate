const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const publicRoot = path.resolve(__dirname, '..', 'public');
const htmlFiles = ['index.html', 'dashboard.html', 'share.html', 'about.html'];

function readPublic(name) {
  return fs.readFileSync(path.join(publicRoot, name), 'utf8');
}

function stripEmbeddedCode(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
}

function getAttribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
  );
  return match ? match[1] ?? match[2] ?? '' : '';
}

function isInsideLabel(html, offset) {
  return html.lastIndexOf('<label', offset) > html.lastIndexOf('</label>', offset);
}

function relativeLuminance(hex) {
  const normalized = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    channels[0] * 0.2126 +
    channels[1] * 0.7152 +
    channels[2] * 0.0722
  );
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background)
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background)
  );
  return (lighter + 0.05) / (darker + 0.05);
}

test('pages expose one main landmark, unique IDs, and named controls', () => {
  htmlFiles.forEach((fileName) => {
    const html = stripEmbeddedCode(readPublic(fileName));
    const mainCount = (html.match(/<main\b/gi) || []).length;
    assert.equal(mainCount, 1, `${fileName} must expose exactly one main landmark`);

    const ids = Array.from(html.matchAll(/\sid="([^"]+)"/gi), (match) => match[1]);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `${fileName} contains duplicate element IDs`
    );

    const labelFors = new Set(
      Array.from(html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/gi), (match) => match[1])
    );
    const controls = Array.from(
      html.matchAll(/<(input|select|textarea)\b[^>]*>/gi)
    );
    controls.forEach((match) => {
      const tag = match[0];
      if (getAttribute(tag, 'type').toLowerCase() === 'hidden') {
        return;
      }
      const id = getAttribute(tag, 'id');
      const hasAccessibleName =
        Boolean(getAttribute(tag, 'aria-label')) ||
        Boolean(getAttribute(tag, 'aria-labelledby')) ||
        (id && labelFors.has(id)) ||
        isInsideLabel(html, match.index);
      assert.ok(
        hasAccessibleName,
        `${fileName} has an unnamed form control: ${tag.slice(0, 120)}`
      );
    });

    const buttons = Array.from(html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi));
    buttons.forEach((match) => {
      const openingTag = `<button${match[1]}>`;
      const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      assert.ok(
        text ||
          getAttribute(openingTag, 'aria-label') ||
          getAttribute(openingTag, 'aria-labelledby'),
        `${fileName} has an unnamed button`
      );
    });
  });
});

test('dialogs and dynamic status regions have reusable keyboard and live-region support', () => {
  const accessibilityJs = readPublic('accessibility.js');
  const adminJs = readPublic('admin.js');
  const dashboardJs = readPublic('dashboard.js');
  const adminHtml = readPublic('index.html');
  const dashboardHtml = readPublic('dashboard.html');
  const shareHtml = readPublic('share.html');

  [adminHtml, dashboardHtml, shareHtml].forEach((html) => {
    assert.match(html, /\/accessibility\.js\?v=accessibility-20260728/);
  });

  [adminHtml, dashboardHtml].forEach((html) => {
    const dialogs = Array.from(html.matchAll(/<div\b[^>]*role="dialog"[^>]*>/gi));
    assert.ok(dialogs.length > 0);
    dialogs.forEach((match) => {
      assert.match(match[0], /aria-modal="true"/);
      assert.match(match[0], /aria-labelledby="[^"]+"/);
    });
  });

  assert.match(accessibilityJs, /function handleDialogKeydown/);
  assert.match(accessibilityJs, /event\.key !== 'Tab'/);
  assert.match(accessibilityJs, /event\.key === 'Escape'/);
  assert.match(accessibilityJs, /aria-live/);
  assert.match(accessibilityJs, /aria-atomic/);
  assert.match(adminJs, /PlexDonateA11y\.handleDialogKeydown/);
  assert.match(dashboardJs, /PlexDonateA11y\.handleDialogKeydown/);
  assert.match(adminJs, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
});

test('shared foreground and action colors meet WCAG AA contrast', () => {
  const requiredPairs = [
    ['#475569', '#ffffff', 'light muted text'],
    ['#64748b', '#ffffff', 'light soft text'],
    ['#e2e8f0', '#0f172a', 'dark primary text'],
    ['#94a3b8', '#0f172a', 'dark soft text'],
    ['#ffffff', '#0f766e', 'teal action'],
    ['#ffffff', '#0369a1', 'blue action'],
    ['#ffffff', '#4f46e5', 'indigo action'],
    ['#ffffff', '#6d28d9', 'purple action'],
  ];

  requiredPairs.forEach(([foreground, background, label]) => {
    assert.ok(
      contrastRatio(foreground, background) >= 4.5,
      `${label} must meet 4.5:1 contrast`
    );
  });
});

test('shared responsive and focus contracts protect keyboard and touch users', () => {
  const sharedCss = readPublic('shared.css');
  assert.match(sharedCss, /:focus-visible/);
  assert.match(sharedCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(sharedCss, /max-width:\s*640px/);
  assert.match(sharedCss, /min-height:\s*44px/);
  assert.match(sharedCss, /overflow-x:\s*(?:clip|hidden)/);
});

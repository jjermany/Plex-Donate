const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const publicRoot = path.join(projectRoot, 'public');

function readPublicFile(name) {
  return fs.readFileSync(path.join(publicRoot, name), 'utf8');
}

test('shared design tokens define every visual-system category', () => {
  const css = readPublicFile('shared.css');

  [
    '--font-sans:',
    '--font-size-md:',
    '--space-4:',
    '--radius-lg:',
    '--color-brand:',
    '--color-text:',
    '--color-surface:',
    '--shadow-lg:',
    '--duration-normal:',
    '--control-height:',
  ].forEach((token) => {
    assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  assert.match(css, /:root\[data-theme='dark'\]/);
});

test('every product surface loads and consumes the shared design tokens', () => {
  const sharedCss = readPublicFile('shared.css');
  const surfaces = [
    ['index.html', 'admin.css'],
    ['dashboard.html', 'dashboard.css'],
    ['share.html', null],
    ['about.html', null],
  ];

  surfaces.forEach(([htmlName, cssName]) => {
    const html = readPublicFile(htmlName);
    assert.match(html, /href="\/shared\.css\?v=ui-components-20260728"/);
    const pageStyles = cssName ? readPublicFile(cssName) : html;
    const styles = `${sharedCss}\n${pageStyles}`;
    assert.match(styles, /var\(--font-sans\)/);
    assert.match(styles, /var\(--color-(?:text|surface)\)/);
    assert.match(styles, /var\(--(?:space|radius|shadow)-/);
  });
});

test('shared component primitives replace duplicated page-level definitions', () => {
  const sharedCss = readPublicFile('shared.css');
  const dashboardCss = readPublicFile('dashboard.css');
  const dashboardHtml = readPublicFile('dashboard.html');
  const shareHtml = readPublicFile('share.html');

  [
    '.supporter-panel {',
    '.surface {',
    '.theme-toggle {',
    '.status-text.relay-warning {',
    '.skip-link {',
  ].forEach((selector) => assert.ok(sharedCss.includes(selector)));

  assert.match(dashboardHtml, /class="panel supporter-panel"/);
  assert.match(shareHtml, /class="panel supporter-panel"/);
  assert.match(dashboardHtml, /data-ui-shell="supporter"/);
  assert.match(shareHtml, /data-ui-shell="supporter"/);
  assert.match(sharedCss, /:root\[data-ui-shell='supporter'\]/);
  assert.match(sharedCss, /:root\[data-ui-shell='supporter'\] body/);

  [dashboardCss, shareHtml].forEach((pageStyles) => {
    assert.doesNotMatch(pageStyles, /\.theme-toggle\s*\{/);
    assert.doesNotMatch(pageStyles, /\.status-text\.relay-warning\s*\{/);
    assert.doesNotMatch(pageStyles, /\.hidden\s*\{\s*display:\s*none/);
    assert.doesNotMatch(
      pageStyles,
      /\.surface\s*\{\s*background:\s*var\(--surface-background\)/
    );
    assert.doesNotMatch(pageStyles, /--page-background:\s*(?:radial|linear)-gradient/);
    assert.doesNotMatch(pageStyles, /^\s*body\s*\{/m);
  });

  assert.doesNotMatch(readPublicFile('admin.css'), /\.skip-link\s*\{/);
});

test('Plex library picker uses the shared visual system and accessible controls', () => {
  const adminHtml = readPublicFile('index.html');
  const adminCss = readPublicFile('admin.css');
  const adminJs = readPublicFile('admin.js');

  assert.match(adminHtml, /aria-controls="plex-library-dropdown"/);
  assert.match(adminHtml, /data-library-toggle-value/);
  assert.match(adminHtml, /data-library-count/);
  assert.match(adminHtml, /data-library-select-all/);
  assert.match(adminHtml, /data-library-summary[\s\S]*role="status"/);

  assert.match(adminCss, /\.library-option\[data-selected='true'\]/);
  assert.match(adminCss, /\.library-selection-chip/);
  assert.match(adminCss, /\.library-selector-toggle-icon/);
  assert.match(adminCss, /max-height:\s*min\(72dvh,\s*560px\)/);
  assert.match(adminCss, /var\(--color-accent-soft\)/);
  assert.match(adminCss, /var\(--radius-xl\)/);

  assert.match(adminJs, /markSettingsFormDirty\(form\)/);
  assert.match(adminJs, /plexLibrarySelectAllButton\.addEventListener/);
  assert.match(adminJs, /library-option-icon/);
});

(function initializeBranding(global) {
  'use strict';

  const DEFAULT_BRANDING = {
    brandName: 'Member Hub',
    emailSenderName: 'Member Hub',
    emailSignoff: 'Member Hub',
  };

  let current = { ...DEFAULT_BRANDING };
  const textTemplates = new WeakMap();
  const attributeTemplates = new WeakMap();

  function normalize(value, fallback) {
    const normalized = value == null ? '' : String(value).trim();
    return normalized || fallback;
  }

  function format(template) {
    return String(template || '').replace(/\{brand\}/g, current.brandName);
  }

  function apply(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('[data-brand]').forEach((element) => {
      element.textContent = current.brandName;
    });
    scope.querySelectorAll('[data-brand-template]').forEach((element) => {
      element.textContent = format(element.dataset.brandTemplate);
    });
    scope.querySelectorAll('[data-brand-placeholder]').forEach((element) => {
      element.setAttribute(
        'placeholder',
        format(element.dataset.brandPlaceholder)
      );
    });
    scope.querySelectorAll('[data-brand-content]').forEach((element) => {
      element.setAttribute('content', format(element.dataset.brandContent));
    });
    const walker = document.createTreeWalker(
      scope === document ? document.body : scope,
      NodeFilter.SHOW_TEXT
    );
    let node = walker.nextNode();
    while (node) {
      const parentName =
        node.parentElement && node.parentElement.tagName
          ? node.parentElement.tagName.toLowerCase()
          : '';
      if (parentName !== 'script' && parentName !== 'style') {
        if (
          !textTemplates.has(node) &&
          node.nodeValue &&
          node.nodeValue.includes(DEFAULT_BRANDING.brandName)
        ) {
          textTemplates.set(node, node.nodeValue);
        }
        const template = textTemplates.get(node);
        if (template) {
          node.nodeValue = template.replace(/Member Hub/g, current.brandName);
        }
      }
      node = walker.nextNode();
    }
    scope
      .querySelectorAll('[placeholder], [title], [aria-label]')
      .forEach((element) => {
        let templates = attributeTemplates.get(element);
        if (!templates) {
          templates = {};
          attributeTemplates.set(element, templates);
        }
        ['placeholder', 'title', 'aria-label'].forEach((attribute) => {
          const value = element.getAttribute(attribute);
          if (
            !templates[attribute] &&
            value &&
            value.includes(DEFAULT_BRANDING.brandName)
          ) {
            templates[attribute] = value;
          }
          if (templates[attribute]) {
            element.setAttribute(
              attribute,
              templates[attribute].replace(/Member Hub/g, current.brandName)
            );
          }
        });
      });

    const titleTemplate =
      document.documentElement &&
      document.documentElement.dataset.brandTitleTemplate;
    if (titleTemplate) {
      document.title = format(titleTemplate);
    }
  }

  function update(next) {
    current = {
      brandName: normalize(
        next && next.brandName,
        DEFAULT_BRANDING.brandName
      ),
      emailSenderName: normalize(
        next && next.emailSenderName,
        (next && next.brandName) || DEFAULT_BRANDING.emailSenderName
      ),
      emailSignoff: normalize(
        next && next.emailSignoff,
        (next && next.brandName) || DEFAULT_BRANDING.emailSignoff
      ),
    };
    api.current = current;
    apply(document);
    document.dispatchEvent(
      new CustomEvent('branding:updated', { detail: { ...current } })
    );
  }

  const api = {
    current,
    apply,
    format,
    getName() {
      return current.brandName;
    },
    update,
  };
  global.MemberHubBranding = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => apply(document), {
      once: true,
    });
  } else {
    apply(document);
  }

  fetch('/api/branding', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((branding) => {
      if (branding) {
        update(branding);
      }
    })
    .catch(() => {
      apply(document);
    });
})(window);

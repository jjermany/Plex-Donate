(() => {
  const dialogState = new WeakMap();
  const statusSelector =
    '.status-text, .form-status, .form-status-text, .dashboard-toast';

  function getFocusable(container) {
    if (!container) {
      return [];
    }
    return Array.from(
      container.querySelectorAll(
        'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), ' +
          'select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => {
      if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      return element.getClientRects().length > 0;
    });
  }

  function enhanceStatusRegions(root = document) {
    root.querySelectorAll(statusSelector).forEach((region) => {
      if (!region.hasAttribute('role')) {
        region.setAttribute('role', 'status');
      }
      if (!region.hasAttribute('aria-live')) {
        region.setAttribute('aria-live', 'polite');
      }
      if (!region.hasAttribute('aria-atomic')) {
        region.setAttribute('aria-atomic', 'true');
      }
    });
  }

  function activateDialog(dialog, initialFocus = null) {
    if (!dialog) {
      return;
    }
    dialogState.set(dialog, {
      returnFocus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    });
    const target =
      initialFocus ||
      getFocusable(dialog)[0] ||
      dialog.querySelector('[tabindex="-1"]') ||
      dialog;
    if (!dialog.hasAttribute('tabindex')) {
      dialog.setAttribute('tabindex', '-1');
    }
    window.requestAnimationFrame(() => {
      if (target && typeof target.focus === 'function') {
        target.focus();
      }
    });
  }

  function deactivateDialog(dialog) {
    if (!dialog) {
      return;
    }
    const state = dialogState.get(dialog);
    dialogState.delete(dialog);
    const returnFocus = state && state.returnFocus;
    if (
      returnFocus &&
      returnFocus.isConnected &&
      typeof returnFocus.focus === 'function'
    ) {
      window.requestAnimationFrame(() => returnFocus.focus());
    }
  }

  function handleDialogKeydown(event, dialog, closeDialog) {
    if (!dialog || dialog.hidden || dialog.classList.contains('hidden')) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (typeof closeDialog === 'function') {
        closeDialog();
      }
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = getFocusable(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  window.PlexDonateA11y = {
    activateDialog,
    deactivateDialog,
    enhanceStatusRegions,
    getFocusable,
    handleDialogKeydown,
  };

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => enhanceStatusRegions(),
      { once: true }
    );
  } else {
    enhanceStatusRegions();
  }
})();

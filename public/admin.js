/* ?? Styled confirmation modal (replaces native confirm()) ?? */
      function showConfirmModal(title, message) {
        return new Promise((resolve) => {
          const backdrop = document.createElement('div');
          backdrop.className = 'confirm-backdrop';
          backdrop.setAttribute('role', 'alertdialog');
          backdrop.setAttribute('aria-modal', 'true');
          backdrop.setAttribute('aria-label', title);

          backdrop.innerHTML = `
            <div class="confirm-panel">
              <div class="confirm-panel-header">
                <div class="confirm-panel-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <div>
                  <h3>${title}</h3>
                  <p>${message}</p>
                </div>
              </div>
              <div class="confirm-actions">
                <button type="button" class="secondary confirm-cancel">Cancel</button>
                <button type="button" class="danger confirm-ok">Confirm</button>
              </div>
            </div>
          `;

          const cleanup = (result) => {
            backdrop.style.opacity = '0';
            backdrop.style.transition = 'opacity 0.15s ease';
            setTimeout(() => backdrop.remove(), 150);
            resolve(result);
          };

          backdrop.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false));
          backdrop.querySelector('.confirm-ok').addEventListener('click', () => cleanup(true));
          backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) cleanup(false);
          });
          backdrop.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') cleanup(false);
          });

          document.body.appendChild(backdrop);
          backdrop.querySelector('.confirm-cancel').focus();
        });
      }

      function showNoticeModal(title, message, options = {}) {
        return new Promise((resolve) => {
          const stateAttr =
            options && typeof options.stateAttr === 'string' ? options.stateAttr : 'info';
          const details = Array.isArray(options && options.details)
            ? options.details.filter((item) => typeof item === 'string' && item.trim())
            : [];
          const closeLabel =
            options && typeof options.closeLabel === 'string' && options.closeLabel.trim()
              ? options.closeLabel.trim()
              : 'OK';
          const backdrop = document.createElement('div');
          backdrop.className = 'confirm-backdrop';
          backdrop.setAttribute('role', 'alertdialog');
          backdrop.setAttribute('aria-modal', 'true');
          backdrop.setAttribute('aria-label', title);

          const detailsMarkup = details.length
            ? `<ul class="notice-list">${details
                .map((item) => `<li>${escapeHtml(item)}</li>`)
                .join('')}</ul>`
            : '';

          backdrop.innerHTML = `
            <div class="confirm-panel notice-panel" data-state="${escapeHtml(stateAttr)}">
              <div class="confirm-panel-header">
                <div class="confirm-panel-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 8h.01M12 12v4m0-14a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z" />
                  </svg>
                </div>
                <div>
                  <h3>${escapeHtml(title)}</h3>
                  <p>${escapeHtml(message)}</p>
                </div>
              </div>
              ${detailsMarkup}
              <div class="confirm-actions">
                <button type="button" class="primary notice-close">${escapeHtml(closeLabel)}</button>
              </div>
            </div>
          `;

          const cleanup = () => {
            backdrop.style.opacity = '0';
            backdrop.style.transition = 'opacity 0.15s ease';
            setTimeout(() => backdrop.remove(), 150);
            resolve(true);
          };

          backdrop.querySelector('.notice-close').addEventListener('click', cleanup);
          backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) cleanup();
          });
          backdrop.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || e.key === 'Enter') cleanup();
          });

          document.body.appendChild(backdrop);
          backdrop.querySelector('.notice-close').focus();
        });
      }

      const loadingGate = document.getElementById('loading-gate');
      const loadingGateMessage = document.getElementById('loading-gate-message');
      const loginPageWrapper = document.getElementById('login-page-wrapper');
      const loginPanel = document.getElementById('login-panel');
      const loginTitle = loginPanel ? loginPanel.querySelector('.login-brand h2') : null;
      const loginForm = document.getElementById('login-form');
      const adminSetupForm = document.getElementById('admin-setup-form');
      const adminSetupUsernameInput = document.getElementById('setup-username');
      const adminSetupPasswordInput = document.getElementById('setup-password');
      const adminSetupConfirmPasswordInput = document.getElementById('setup-confirm-password');
      const adminSetupSubmitButton = document.getElementById('admin-setup-submit');
      const loginUsernameInput = document.getElementById('username');
      const loginPasswordInput = document.getElementById('password');
      const loginTotpForm = document.getElementById('login-totp-form');
      const loginTotpCodeInput = document.getElementById('login-totp-code');
      const loginTotpSubmitButton = document.getElementById('login-totp-submit');
      const loginTotpCancelButton = document.getElementById('login-totp-cancel');
      const loginSubmitButton = document.getElementById('login-submit');
      const loginHelp = document.getElementById('login-help');
      const togglePasswordVisibilityButton = document.getElementById('toggle-password-visibility');
      const dashboard = document.getElementById('dashboard');
      const logoutButton = document.getElementById('logout-button');
      const statusMessage = document.getElementById('status-message');
      const dashboardToast = document.getElementById('dashboard-toast');
      const adminTwoFactorOnboardingBanner = document.getElementById('admin-two-factor-onboarding-banner');
      const adminTwoFactorOnboardingStartButton = document.getElementById('admin-two-factor-onboarding-start');
      const adminTwoFactorOnboardingSkipButton = document.getElementById('admin-two-factor-onboarding-skip');
      const adminAccountPanel = document.getElementById('admin-account-panel');
      const adminCredentialsForm = document.getElementById('admin-credentials-form');
      const adminTwoFactorForm = document.getElementById('admin-two-factor-form');
      const adminAccountDescription = document.getElementById('admin-account-description');
      const adminTwoFactorDescription = document.getElementById('admin-two-factor-description');
      const adminTwoFactorSetupPanel = document.getElementById('admin-two-factor-setup-panel');
      const adminTwoFactorQr = document.getElementById('admin-two-factor-qr');
      const adminTwoFactorManualKey = document.getElementById('admin-two-factor-manual-key');
      const adminTwoFactorCode = document.getElementById('admin-two-factor-code');
      const adminTwoFactorStartButton = document.getElementById('admin-two-factor-start');
      const adminTwoFactorVerifyButton = document.getElementById('admin-two-factor-verify');
      const adminTwoFactorDisableButton = document.getElementById('admin-two-factor-disable');
      const subscribersTable = document.querySelector('#subscribers-table tbody');
      const plexStatusNote = document.getElementById('plex-status-note');

      // Master-detail donors layout elements
      const donorsList = document.getElementById('donors-list');
      const donorDetail = document.getElementById('donor-detail');
      const donorsEmptyState = document.getElementById('donors-empty-state');
      const donorsSearchInput = document.getElementById('donors-search');
      const donorsFilterTabs = document.querySelectorAll('.donors-filter-tab');
      const donorsLayout = document.querySelector('.donors-layout');

      // Donor detail elements
      const donorDetailName = document.getElementById('donor-detail-name');
      const donorDetailStatus = document.getElementById('donor-detail-status');
      const donorDetailEmail = document.getElementById('donor-detail-email');
      const donorDetailSubId = document.getElementById('donor-detail-sub-id');
      const donorDetailLastPayment = document.getElementById('donor-detail-last-payment');
      const donorDetailAmount = document.getElementById('donor-detail-amount');
      const donorDetailInvite = document.getElementById('donor-detail-invite');
      const donorDetailError = document.getElementById('donor-detail-error');
      const donorDetailErrorSection = document.getElementById('donor-detail-error-section');
      const donorDetailActions = document.getElementById('donor-detail-actions');

      // Donor state
      let selectedDonorId = null;
      let currentFilter = 'all';
      let searchQuery = '';

      const shareLinksPanel = document.getElementById('share-links-panel');
      const shareLinksTable = document.querySelector('#share-links-table tbody');
      const eventsList = document.getElementById('events-list');
      const refreshButton = document.getElementById('refresh-button');
      const settingsPanel = document.getElementById('settings-panel');
      const settingsForms = Array.from(
        document.querySelectorAll('.settings-form[data-group]')
      );

      function markSettingsFormDirty(form) {
        if (!form || !form.dataset) {
          return;
        }
        form.dataset.dirty = 'true';
      }

      function clearSettingsFormDirtyFlags() {
        settingsForms.forEach((form) => {
          if (form && form.dataset) {
            delete form.dataset.dirty;
          }
        });
      }

      function anySettingsFormDirty() {
        return settingsForms.some(
          (form) => form && form.dataset && form.dataset.dirty === 'true'
        );
      }
      const plexLibraryPicker = settingsPanel
        ? settingsPanel.querySelector('[data-library-picker]')
        : null;
      const plexLibraryInput = plexLibraryPicker
        ? plexLibraryPicker.querySelector('[data-library-input]')
        : null;
      const plexLibraryToggle = plexLibraryPicker
        ? plexLibraryPicker.querySelector('[data-library-toggle]')
        : null;
      const plexLibraryDropdown = plexLibraryPicker
        ? plexLibraryPicker.querySelector('[data-library-dropdown]')
        : null;
      const plexLibraryOptions = plexLibraryPicker
        ? plexLibraryPicker.querySelector('[data-library-options]')
        : null;
      const plexLibraryEmpty = plexLibraryPicker
        ? plexLibraryPicker.querySelector('[data-library-empty]')
        : null;
      const plexLibraryHelp = plexLibraryPicker
        ? plexLibraryPicker.querySelector('[data-library-help]')
        : null;
      const plexLibrarySummary = plexLibraryPicker
        ? plexLibraryPicker.querySelector('[data-library-summary]')
        : null;
      const plexLibraryClearButton = plexLibraryPicker
        ? plexLibraryPicker.querySelector('[data-library-clear]')
        : null;
      const plexLibraryApplyButton = plexLibraryPicker
        ? plexLibraryPicker.querySelector('[data-library-apply]')
        : null;
      const paypalPlanSection = document.getElementById('paypal-plan-management');
      const paypalPlanBody = document.getElementById('paypal-plan-body');
      const paypalPlanManageLink = document.getElementById('paypal-plan-manage-link');
      const announcementSettingsPanel = document.getElementById(
        'announcement-settings-panel'
      );
      const announcementsForm = announcementSettingsPanel
        ? announcementSettingsPanel.querySelector(
            '.settings-form[data-group="announcements"]'
          )
        : null;
      const announcementPreview = announcementSettingsPanel
        ? announcementSettingsPanel.querySelector('[data-announcement-preview]')
        : null;
      const announcementPreviewBanner = announcementSettingsPanel
        ? announcementSettingsPanel.querySelector('[data-announcement-banner]')
        : null;
      const announcementPreviewEmpty = announcementSettingsPanel
        ? announcementSettingsPanel.querySelector('[data-announcement-preview-empty]')
        : null;
      const announcementPreviewTitle = announcementSettingsPanel
        ? announcementSettingsPanel.querySelector('[data-announcement-title]')
        : null;
      const announcementPreviewBody = announcementSettingsPanel
        ? announcementSettingsPanel.querySelector('[data-announcement-body]')
        : null;
      const announcementPreviewChip = announcementSettingsPanel
        ? announcementSettingsPanel.querySelector('[data-announcement-chip]')
        : null;
      const announcementPreviewCta = announcementSettingsPanel
        ? announcementSettingsPanel.querySelector('[data-announcement-cta]')
        : null;
      const announcementPreviewDismiss = announcementSettingsPanel
        ? announcementSettingsPanel.querySelector('[data-announcement-dismiss]')
        : null;
      const announcementEmailButton = announcementSettingsPanel
        ? announcementSettingsPanel.querySelector('[data-announcement-email-send]')
        : null;
      const prospectShareOpen = document.getElementById('prospect-share-open');
      const prospectShareModal = document.getElementById('prospect-share-modal');
      const prospectShareClose = document.getElementById('prospect-share-close');
      const prospectShareForm = document.getElementById('prospect-share-form');
      const prospectShareResult = document.getElementById('prospect-share-result');
      const prospectShareSummary = document.getElementById('prospect-share-summary');
      const prospectShareUrl = document.getElementById('prospect-share-url');
      const prospectShareNote = document.getElementById('prospect-share-note');
      const prospectShareCopy = document.getElementById('prospect-share-copy');
      const prospectShareRegenerate = document.getElementById('prospect-share-regenerate');
      const prospectShareReset = document.getElementById('prospect-share-reset');
      const themeToggleButton = document.getElementById('theme-toggle');
      const themeMeta = document.querySelector('meta[name="theme-color"]');
      const rootElement = document.documentElement;
      const THEME_STORAGE_KEY = 'plexDonateTheme';
      const dashboardLegend = document.querySelector('[data-dashboard-legend]');
      const dashboardLegendButtons = dashboardLegend
        ? Array.from(dashboardLegend.querySelectorAll('[data-dashboard-target]'))
        : [];
      const supportPanel = document.getElementById('support-panel');
      const supportRequestList = document.getElementById('support-request-list');
      const supportConversation = document.getElementById('support-conversation');
      const supportRequestSubject = document.getElementById('support-request-subject');
      const supportRequestStatus = document.getElementById('support-request-status');
      const supportRequestMeta = document.getElementById('support-request-meta');
      const supportMessageThread = document.getElementById('support-message-thread');
      const supportIncludeResolved = document.getElementById('support-include-resolved');
      const supportRefreshButton = document.getElementById('support-refresh');
      const supportReplyForm = document.getElementById('support-reply-admin-form');
      const supportReplySubmit = supportReplyForm
        ? supportReplyForm.querySelector('button[type="submit"]')
        : null;
      const supportReplyTextarea = document.getElementById('support-reply-admin');
      const supportReplyStatus = document.getElementById('support-reply-admin-status');
      const supportMarkResolvedButton = document.getElementById('support-mark-resolved');
      const supportReopenButton = document.getElementById('support-reopen');
      const supportDeleteButton = document.getElementById('support-delete-thread');
      const supportError = document.getElementById('support-error');
      const integrationTab = document.getElementById('dashboard-tab-integration');
      const adminSetupChecklist = document.getElementById('admin-setup-checklist');
      const adminSetupOpenIntegrations = document.getElementById('admin-setup-open-integrations');
      const setupCheckAppState = document.getElementById('setup-check-app-state');
      const setupCheckEmailState = document.getElementById('setup-check-email-state');
      const setupCheckPaypalState = document.getElementById('setup-check-paypal-state');
      const setupCheckPlexState = document.getElementById('setup-check-plex-state');
      const serviceSummaryAppState = document.getElementById('service-summary-app-state');
      const serviceSummaryAppCopy = document.getElementById('service-summary-app-copy');
      const serviceSummaryPaypalState = document.getElementById('service-summary-paypal-state');
      const serviceSummaryPaypalCopy = document.getElementById('service-summary-paypal-copy');
      const serviceSummarySmtpState = document.getElementById('service-summary-smtp-state');
      const serviceSummarySmtpCopy = document.getElementById('service-summary-smtp-copy');
      const serviceSummaryPlexState = document.getElementById('service-summary-plex-state');
      const serviceSummaryPlexCopy = document.getElementById('service-summary-plex-copy');
      const dashboardViewContainers = Array.from(
        document.querySelectorAll('[data-dashboard-view]')
      );
      const DASHBOARD_VIEW_STORAGE_KEY = 'plexDonateDashboardView';
      const DASHBOARD_VIEW_HASH_PREFIX = 'view-';
      const DASHBOARD_VIEW_DEFAULT = 'donors';
      const DASHBOARD_VIEW_ORDER = [
        'donors',
        'integration',
        'notifications',
        'support',
        'logs',
        'account',
      ];
      const DASHBOARD_VIEW_SET = new Set(DASHBOARD_VIEW_ORDER);
      const hasDashboardPreference = Boolean(parseDashboardViewFromHash());

      if (prospectShareCopy) {
        prospectShareCopy.disabled = true;
      }
      if (prospectShareRegenerate) {
        prospectShareRegenerate.disabled = true;
      }

      let csrfToken = null;
      const SESSION_TOKEN_QUERY_PARAM = 'session';
      let sessionToken = null;
      let loginRateLimitedUntil = null; // Timestamp when rate limit cooldown expires

      let openSubscriberActionMenu = null;
      let lastProspectShareTrigger = null;

      let activeDashboardView = DASHBOARD_VIEW_DEFAULT;
      let dashboardViewPreferenceLocked = hasDashboardPreference;

      function hasNonEmptyValue(value) {
        return value !== undefined && value !== null && String(value).trim() !== '';
      }

      function normalizeDashboardView(view) {
        if (!view) {
          return null;
        }
        const normalized = String(view).trim().toLowerCase();
        return DASHBOARD_VIEW_SET.has(normalized) ? normalized : null;
      }

      function getStoredDashboardView() {
        try {
          return normalizeDashboardView(
            localStorage.getItem(DASHBOARD_VIEW_STORAGE_KEY)
          );
        } catch (err) {
          return null;
        }
      }

      function storeDashboardView(view) {
        try {
          if (!normalizeDashboardView(view)) {
            localStorage.removeItem(DASHBOARD_VIEW_STORAGE_KEY);
            return;
          }
          localStorage.setItem(DASHBOARD_VIEW_STORAGE_KEY, view);
        } catch (err) {
          /* noop */
        }
      }

      function parseDashboardViewFromHash() {
        const hash = window.location.hash ? window.location.hash.slice(1) : '';
        if (!hash) {
          return null;
        }
        if (hash.startsWith(DASHBOARD_VIEW_HASH_PREFIX)) {
          const candidate = hash.slice(DASHBOARD_VIEW_HASH_PREFIX.length);
          return normalizeDashboardView(candidate);
        }
        return null;
      }

      function updateDashboardViewHash(view) {
        const normalized = normalizeDashboardView(view);
        try {
          const url = new URL(window.location.href);
          const nextHash = normalized
            ? `#${DASHBOARD_VIEW_HASH_PREFIX}${normalized}`
            : '';
          window.history.replaceState(
            {},
            '',
            `${url.pathname}${url.search}${nextHash}`
          );
        } catch (err) {
          if (normalized) {
            window.location.hash = `${DASHBOARD_VIEW_HASH_PREFIX}${normalized}`;
          } else {
            window.location.hash = '';
          }
        }
      }

      function applyActiveDashboardView() {
        dashboardViewContainers.forEach((container) => {
          const viewName = container.getAttribute('data-dashboard-view');
          const isActive = viewName === activeDashboardView;
          container.hidden = !isActive;
          if (isActive) {
            container.removeAttribute('aria-hidden');
          } else {
            container.setAttribute('aria-hidden', 'true');
          }
          container.classList.toggle('is-active', isActive);
        });

        dashboardLegendButtons.forEach((button) => {
          const target = button.getAttribute('data-dashboard-target');
          const isActive = target === activeDashboardView;
          button.setAttribute('aria-selected', isActive ? 'true' : 'false');
          button.setAttribute('tabindex', isActive ? '0' : '-1');
          button.classList.toggle('is-active', isActive);
        });
      }

      function setActiveDashboardView(view, options = {}) {
        const normalized = normalizeDashboardView(view) || DASHBOARD_VIEW_DEFAULT;
        const {
          persist = true,
          updateHash = true,
          force = false,
        } = options;

        if (!force && normalized === activeDashboardView) {
          return;
        }

        activeDashboardView = normalized;
        applyActiveDashboardView();

        if (activeDashboardView === 'support' && state.authenticated) {
          loadSupportRequests({ silent: true });
        }

        if (persist) {
          storeDashboardView(normalized);
        }

        if (updateHash) {
          updateDashboardViewHash(normalized);
        }
      }

      if (dashboardLegendButtons.length > 0) {
        const focusDashboardTabByIndex = (index) => {
          const button = dashboardLegendButtons[index];
          if (!button) {
            return;
          }
          button.focus();
          const target = button.getAttribute('data-dashboard-target');
          setActiveDashboardView(target);
        };

        dashboardLegendButtons.forEach((button) => {
          button.addEventListener('click', () => {
            dashboardViewPreferenceLocked = true;
            const target = button.getAttribute('data-dashboard-target');
            setActiveDashboardView(target);
          });
        });

        if (dashboardLegend) {
          dashboardLegend.addEventListener('keydown', (event) => {
            const { key } = event;
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
              return;
            }
            event.preventDefault();
            const activeElement = document.activeElement;
            let currentIndex = dashboardLegendButtons.indexOf(activeElement);
            if (currentIndex === -1) {
              currentIndex = dashboardLegendButtons.findIndex((button) =>
                button.getAttribute('data-dashboard-target') ===
                activeDashboardView
              );
            }
            if (key === 'Home') {
              focusDashboardTabByIndex(0);
              return;
            }
            if (key === 'End') {
              focusDashboardTabByIndex(dashboardLegendButtons.length - 1);
              return;
            }
            if (key === 'ArrowLeft') {
              const previousIndex =
                currentIndex <= 0
                  ? dashboardLegendButtons.length - 1
                  : currentIndex - 1;
              focusDashboardTabByIndex(previousIndex);
            } else if (key === 'ArrowRight') {
              const nextIndex = (currentIndex + 1) % dashboardLegendButtons.length;
              focusDashboardTabByIndex(nextIndex);
            }
          });
        }
      }

      if (adminSetupOpenIntegrations) {
        adminSetupOpenIntegrations.addEventListener('click', () => {
          dashboardViewPreferenceLocked = true;
          setActiveDashboardView('integration');
        });
      }

      const hashDashboardView = parseDashboardViewFromHash();
      const initialDashboardView = hashDashboardView || DASHBOARD_VIEW_DEFAULT;
      setActiveDashboardView(initialDashboardView, {
        persist: true,
        updateHash: false,
        force: true,
      });

      window.addEventListener('hashchange', () => {
        const nextViewFromHash = parseDashboardViewFromHash();
        if (nextViewFromHash) {
          setActiveDashboardView(nextViewFromHash, { updateHash: false });
        } else {
          setActiveDashboardView(DASHBOARD_VIEW_DEFAULT, { updateHash: false });
        }
      });

      function closeSubscriberActionMenu(menu, options = {}) {
        const targetMenu = menu || openSubscriberActionMenu;
        if (!targetMenu) {
          return;
        }
        const { focusToggle = false } = options;
        targetMenu.classList.remove('open');
        const panel = targetMenu.querySelector('.action-menu-panel');
        if (panel) {
          panel.hidden = true;
          panel.setAttribute('aria-hidden', 'true');
        }
        const toggle = targetMenu.querySelector('[data-menu-toggle]');
        if (toggle) {
          toggle.setAttribute('aria-expanded', 'false');
          if (focusToggle) {
            toggle.focus();
          }
        }
        if (openSubscriberActionMenu === targetMenu) {
          openSubscriberActionMenu = null;
        }
      }

      function openSubscriberActionMenuFor(menu) {
        if (!menu) {
          return;
        }
        if (openSubscriberActionMenu && openSubscriberActionMenu !== menu) {
          closeSubscriberActionMenu(openSubscriberActionMenu);
        }
        menu.classList.add('open');
        const panel = menu.querySelector('.action-menu-panel');
        if (panel) {
          panel.hidden = false;
          panel.setAttribute('aria-hidden', 'false');
        }
        const toggle = menu.querySelector('[data-menu-toggle]');
        if (toggle) {
          toggle.setAttribute('aria-expanded', 'true');
        }

        // Detect if menu should open upward to avoid viewport overflow
        window.requestAnimationFrame(() => {
          const toggleRect = toggle ? toggle.getBoundingClientRect() : menu.getBoundingClientRect();
          const panelHeight = panel ? panel.offsetHeight : 300; // Estimate if not yet rendered
          const spaceBelow = window.innerHeight - toggleRect.bottom;
          const spaceAbove = toggleRect.top;

          // Open upward if not enough space below and more space above
          if (spaceBelow < panelHeight + 20 && spaceAbove > spaceBelow) {
            menu.classList.add('open-upward');
          } else {
            menu.classList.remove('open-upward');
          }
        });

        openSubscriberActionMenu = menu;
        window.requestAnimationFrame(() => {
          const firstItem = menu.querySelector(
            '.action-menu-panel button[data-action]:not(:disabled)'
          );
          if (firstItem) {
            firstItem.focus();
          }
        });
      }

      function toggleSubscriberActionMenu(menu) {
        if (!menu) {
          return;
        }
        if (menu.classList.contains('open')) {
          closeSubscriberActionMenu(menu, { focusToggle: true });
        } else {
          openSubscriberActionMenuFor(menu);
        }
      }

      function normalizeSessionToken(token) {
        if (typeof token !== 'string') {
          return null;
        }
        const trimmed = token.trim();
        return trimmed ? trimmed : null;
      }

      function applySessionTokenToUrl(token) {
        try {
          const url = new URL(window.location.href);
          if (token) {
            url.searchParams.set(SESSION_TOKEN_QUERY_PARAM, token);
          } else {
            url.searchParams.delete(SESSION_TOKEN_QUERY_PARAM);
          }
          const nextUrl = `${url.pathname}${url.search}${url.hash}`;
          window.history.replaceState({}, '', nextUrl);
        } catch (err) {
          // Ignore URL update errors.
        }
      }

      function setSessionToken(token) {
        const normalized = normalizeSessionToken(token);
        if (normalized === sessionToken) {
          return;
        }
        sessionToken = normalized;
        applySessionTokenToUrl(sessionToken);
      }

      (function initializeSessionTokenFromUrl() {
        try {
          const url = new URL(window.location.href);
          const existing = url.searchParams.get(SESSION_TOKEN_QUERY_PARAM);
          if (existing) {
            setSessionToken(existing);
          }
        } catch (err) {
          sessionToken = null;
        }
      })();

      function withSessionToken(path) {
        if (!sessionToken) {
          return path;
        }
        try {
          const url = new URL(path, window.location.origin);
          url.searchParams.set(SESSION_TOKEN_QUERY_PARAM, sessionToken);
          return url.toString();
        } catch (err) {
          return path;
        }
      }

      function updateSessionTokenFromResponse(data) {
        if (!data || typeof data !== 'object') {
          return;
        }
        if (Object.prototype.hasOwnProperty.call(data, 'sessionToken')) {
          setSessionToken(data.sessionToken);
        }
      }

      let state = {
        authenticated: false,
        twoFactorPending: false,
        workspaceLoading: false,
        workspaceLoadingMessage: '',
        donors: [],
        shareLinks: [],
        events: [],
        prospectShare: null,
        settings: null,
        paypalPlan: null,
        paypalProduct: null,
        paypalPlanError: '',
        paypalPlanManageUrl: '',
        paypalPlanLoading: false,
        adminUsername: 'admin',
        adminTwoFactor: null,
        adminOnboarding: null,
        pendingTwoFactorSetup: null,
        timezone: null,
        plex: null,
        plexLibraries: null,
        support: {
          threads: [],
          activeThreadId: null,
          includeResolved: false,
          error: '',
          loaded: false,
        },
      };
      function setLoginStatus(message = '', stateAttr = '') {
        if (!statusMessage) {
          return;
        }
        statusMessage.textContent = message;
        statusMessage.classList.remove('error', 'success');
        if (stateAttr) {
          statusMessage.classList.add(stateAttr);
        }
      }

      const AUTO_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
      let autoRefreshTimerId = null;
      let dashboardDataPromise = null;
      let isSessionExpiring = false;
      let initialSessionValidationPending = true;

      const statusClearTimers = new WeakMap();
      let toastTimerId = null;

      function stopDashboardAutoRefresh() {
        if (autoRefreshTimerId) {
          window.clearInterval(autoRefreshTimerId);
          autoRefreshTimerId = null;
        }
      }

      async function autoRefreshDashboardData() {
        if (!state.authenticated) {
          stopDashboardAutoRefresh();
          return;
        }
        try {
          await loadDashboardData();
        } catch (err) {
          console.error('Automatic dashboard refresh failed', err);
        }
      }

      function startDashboardAutoRefresh() {
        stopDashboardAutoRefresh();
        autoRefreshTimerId = window.setInterval(
          autoRefreshDashboardData,
          AUTO_REFRESH_INTERVAL_MS
        );
      }

      function setWorkspaceLoading(isLoading, message = '') {
        state.workspaceLoading = Boolean(isLoading);
        state.workspaceLoadingMessage = isLoading
          ? message || 'Loading the admin workspace...'
          : '';
      }

      async function enterAdminWorkspace() {
        setWorkspaceLoading(
          true,
          'Signing you in and loading the admin workspace...'
        );
        render();
        try {
          await loadDashboardData();
          if (state.authenticated) {
            startDashboardAutoRefresh();
          }
        } finally {
          setWorkspaceLoading(false);
          render();
        }
      }

      function storeThemePreference(theme) {
        try {
          localStorage.setItem(THEME_STORAGE_KEY, theme);
        } catch (err) {
          /* noop */
        }
      }

      function applyTheme(theme, persist = true) {
        const normalized = theme === 'dark' ? 'dark' : 'light';
        rootElement.dataset.theme = normalized;
        if (persist) {
          storeThemePreference(normalized);
        }
        if (themeMeta) {
          themeMeta.setAttribute('content', normalized === 'dark' ? '#0f172a' : '#f8fafc');
        }
        if (themeToggleButton) {
          themeToggleButton.setAttribute('aria-pressed', normalized === 'dark' ? 'true' : 'false');
        }
      }

      applyTheme(rootElement.dataset.theme || 'light', false);

      if (themeToggleButton) {
        themeToggleButton.addEventListener('click', () => {
          const nextTheme = rootElement.dataset.theme === 'dark' ? 'light' : 'dark';
          applyTheme(nextTheme);
        });
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function formatDateTime(value) {
        if (!value) {
          return '?';
        }

        let date;
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (!trimmed) {
            return '?';
          }

          const sqliteMatch = trimmed.match(
            /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
          );
          if (sqliteMatch) {
            const [, year, month, day, hour, minute, second] = sqliteMatch;
            date = new Date(
              Date.UTC(
                Number(year),
                Number(month) - 1,
                Number(day),
                Number(hour),
                Number(minute),
                Number(second)
              )
            );
          } else {
            date = new Date(trimmed);
          }
        } else {
          date = new Date(value);
        }

        if (Number.isNaN(date.getTime())) {
          return String(value);
        }

        let timezone = typeof state.timezone === 'string' ? state.timezone.trim() : '';
        if (!timezone && typeof Intl !== 'undefined') {
          try {
            const resolved = Intl.DateTimeFormat().resolvedOptions();
            timezone = resolved && typeof resolved.timeZone === 'string'
              ? resolved.timeZone
              : '';
          } catch (err) {
            timezone = '';
          }
        }

        if (timezone) {
          try {
            return date.toLocaleString(undefined, { timeZone: timezone });
          } catch (err) {
            /* noop */
          }
        }

        return date.toLocaleString();
      }

      function formatTrialCountdown(accessExpiresAt) {
        if (!accessExpiresAt) {
          return null;
        }

        const expires = new Date(accessExpiresAt);
        if (Number.isNaN(expires.getTime())) {
          return null;
        }

        const now = new Date();
        const diffMs = expires.getTime() - now.getTime();
        const expired = diffMs <= 0;
        const clampedDiff = Math.max(diffMs, 0);
        const days = Math.floor(clampedDiff / (1000 * 60 * 60 * 24));
        const hours = Math.floor(
          (clampedDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
        );
        const minutes = Math.floor((clampedDiff % (1000 * 60 * 60)) / (1000 * 60));

        let remainingShort;
        if (expired) {
          remainingShort = 'Expired';
        } else if (days > 0) {
          remainingShort = `${days}d ${hours}h`;
        } else if (hours > 0) {
          remainingShort = `${hours}h ${minutes}m`;
        } else {
          remainingShort = `${minutes}m`;
        }

        const expiresOn = formatDateTime(expires);
        const label = expired ? 'Trial expired' : `${remainingShort} left`;

        return { remainingShort, expiresOn, expired, label };
      }

      function getPublicBaseUrl() {
        if (!state.settings || !state.settings.app) {
          return '';
        }
        const raw = state.settings.app.publicBaseUrl;
        if (!raw) {
          return '';
        }
        return String(raw).trim().replace(/\/+$/, '');
      }

      function buildShareUrl(link) {
        if (!link || typeof link !== 'object') {
          return '';
        }
        if (link.url) {
          return String(link.url);
        }
        if (link.token) {
          const configuredBase = getPublicBaseUrl();
          const origin = configuredBase || window.location.origin.replace(/\/$/, '');
          return `${origin}/share/${link.token}`;
        }
        return '';
      }

      function toTitleCase(value) {
        const normalized = String(value || '').replace(/_/g, ' ').trim();
        if (!normalized) {
          return 'Unknown';
        }
        return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
      }

      function formatPlanFrequency(frequency) {
        if (!frequency || typeof frequency !== 'object') {
          return '';
        }
        const count = Number(frequency.interval_count || frequency.intervalCount || 0);
        const unitRaw = frequency.interval_unit || frequency.intervalUnit;
        const unit = unitRaw ? String(unitRaw).toLowerCase() : '';
        if (!unit) {
          return count > 0 ? `${count}` : '';
        }
        if (!Number.isFinite(count) || count <= 0) {
          return unit;
        }
        const plural = count === 1 ? unit : `${unit}s`;
        return `${count} ${plural}`;
      }

      function buildPaypalPlanDetails(plan, product) {
        if (!plan || typeof plan !== 'object') {
          return '<p class="plan-error">Unable to display PayPal plan details.</p>';
        }

        const planId = plan.id || '';
        const statusLabel = toTitleCase(plan.status || 'unknown');
        const billingCycles = Array.isArray(plan.billing_cycles)
          ? plan.billing_cycles
          : [];
        const regularCycle =
          billingCycles.find((cycle) => cycle && cycle.tenure_type === 'REGULAR') ||
          billingCycles[0];

        let priceLabel = '?';
        if (
          regularCycle &&
          regularCycle.pricing_scheme &&
          regularCycle.pricing_scheme.fixed_price &&
          regularCycle.pricing_scheme.fixed_price.value != null
        ) {
          const fixed = regularCycle.pricing_scheme.fixed_price;
          const value = String(fixed.value);
          const currency = fixed.currency_code || '';
          priceLabel = `${value} ${currency}`.trim();
        }

        const frequencyLabel = formatPlanFrequency(regularCycle && regularCycle.frequency);
        const cycleLabel =
          priceLabel !== '?' && frequencyLabel
            ? `${priceLabel} every ${frequencyLabel}`
            : priceLabel !== '?'
              ? priceLabel
              : frequencyLabel || '?';

        let productLabel = '?';
        if (product && (product.name || product.id)) {
          if (product.name && (plan.product_id || product.id)) {
            const idLabel = plan.product_id || product.id;
            productLabel = `${escapeHtml(product.name)} (${escapeHtml(idLabel)})`;
          } else {
            productLabel = escapeHtml(product.name || product.id);
          }
        } else if (plan.product_id) {
          productLabel = escapeHtml(plan.product_id);
        }

        const createdAt = formatDateTime(plan.create_time);
        const updatedAt = formatDateTime(plan.update_time);

        return `
          <dl class="plan-details">
            <div>
              <dt>Plan ID</dt>
              <dd>${escapeHtml(planId)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>${escapeHtml(statusLabel)}</dd>
            </div>
            <div>
              <dt>Billing cycle</dt>
              <dd>${escapeHtml(cycleLabel)}</dd>
            </div>
            <div>
              <dt>Product</dt>
              <dd>${productLabel}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>${escapeHtml(createdAt)}</dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>${escapeHtml(updatedAt)}</dd>
            </div>
          </dl>
        `;
      }

      async function refreshAdminSession() {
        const response = await fetch(withSessionToken('/api/admin/session'), {
          credentials: 'include',
        });
        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
          ? await response.json()
          : {};

        if (!response.ok) {
          // If session is expired (401), set flag and throw without retry
          if (response.status === 401) {
            isSessionExpiring = true;
            stopDashboardAutoRefresh();
            throw new Error('Session expired');
          }
          const error = data.error || 'Failed to refresh session';
          throw new Error(error);
        }

        if (data && data.csrfToken) {
          csrfToken = data.csrfToken;
        }

        updateSessionTokenFromResponse(data);

        state.authenticated = Boolean(data.authenticated);
        if (data.adminUsername) {
          state.adminUsername = data.adminUsername;
        }
        render();

        return data;
      }

      async function api(path, options = {}) {
        // Prevent new requests if session is already expiring
        if (isSessionExpiring) {
          throw new Error('Session expired');
        }

        const { _retry, ...requestOptions } = options || {};
        const opts = { ...requestOptions };
        opts.credentials = 'include';
        opts.headers = opts.headers ? { ...opts.headers } : {};
        if (opts.body && typeof opts.body !== 'string') {
          opts.headers['Content-Type'] = 'application/json';
          opts.body = JSON.stringify(opts.body);
        }
        if (csrfToken && opts.method && opts.method !== 'GET') {
          opts.headers['X-CSRF-Token'] = csrfToken;
        }
        if (sessionToken) {
          opts.headers['X-Session-Token'] = sessionToken;
        }

        const requestUrl = withSessionToken(path);
        const response = await fetch(requestUrl, opts);
        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
          ? await response.json()
          : {};

        if (data && data.csrfToken) {
          csrfToken = data.csrfToken;
        }

        updateSessionTokenFromResponse(data);

        const isLoginRequest =
          typeof path === 'string' && path.startsWith('/api/admin/login');

        if (response.status === 401 && isLoginRequest) {
          const errorMessage = data.error || 'Authentication failed';
          const error = new Error(errorMessage);
          error.status = response.status;
          throw error;
        }

        if (response.status === 401) {
          // Session has expired or user is not authenticated
          // Set flag immediately to prevent cascading retry attempts
          isSessionExpiring = true;

          // Stop any background processes
          stopDashboardAutoRefresh();
          setSessionToken(null);

          // Clear all state
          state.authenticated = false;
          setWorkspaceLoading(false);
          state.donors = [];
          state.shareLinks = [];
          state.events = [];
          state.settings = null;
          clearSettingsFormDirtyFlags();
          state.paypalPlan = null;
          state.paypalProduct = null;
          state.paypalPlanError = '';
          state.paypalPlanManageUrl = '';
          state.paypalPlanLoading = false;
          state.prospectShare = null;
          state.plex = null;
          state.support = {
            threads: [],
            activeThreadId: null,
            includeResolved: false,
            error: '',
            loaded: false,
          };

          setLoginStatus('Authentication required. Please sign in again.', 'error');
          render();

          const loginPanelVisible = loginPanel && !loginPanel.classList.contains('hidden');
          const reloadDelayMs = loginPanelVisible ? 1500 : 150;

          // Reload the page to ensure clean state after showing the login message
          console.log('Session expired. Reloading page...');
          setTimeout(() => {
            if (!loginPanel || !loginPanel.classList.contains('hidden')) {
              window.location.reload();
            }
          }, reloadDelayMs);

          throw new Error('Authentication required');
        }

        if (
          response.status === 403 &&
          data &&
          data.error === 'Invalid CSRF token' &&
          !_retry &&
          !isSessionExpiring
        ) {
          csrfToken = null;
          try {
            await refreshAdminSession();
          } catch (err) {
            console.error('Failed to recover from CSRF token error', err);
            throw new Error(data.error || 'Invalid CSRF token');
          }
          return api(path, { ...requestOptions, _retry: true });
        }

        if (response.status === 429) {
          stopDashboardAutoRefresh();
          // Preserve the server's specific error message which includes timing details
          const errorMessage =
            data.error || 'Too many requests. Please wait before trying again.';
          console.warn('Rate limit exceeded:', errorMessage);
          const error = new Error(errorMessage);
          error.status = response.status;
          throw error;
        }

        if (!response.ok) {
          const errorMessage = data.error || 'Request failed';
          const error = new Error(errorMessage);
          error.status = response.status;
          throw error;
        }

        return data;
      }

      async function ensureCsrfToken() {
        if (csrfToken) {
          return csrfToken;
        }
        if (isSessionExpiring) {
          throw new Error('Session expired');
        }
        try {
          const data = await refreshAdminSession();
          csrfToken = data.csrfToken || csrfToken;
          return csrfToken;
        } catch (err) {
          console.error('Failed to refresh CSRF token', err);
          throw err;
        }
      }

      function getSupportThreads() {
        return Array.isArray(state.support && state.support.threads)
          ? state.support.threads
          : [];
      }

      function findSupportThread(threadId) {
        const threads = getSupportThreads();
        return threads.find(
          (thread) => thread && thread.request && thread.request.id === threadId
        );
      }

      function updateSupportThreadInState(updatedThread) {
        if (!updatedThread || !updatedThread.request) {
          return;
        }
        const threads = getSupportThreads();
        const filtered = threads.filter(
          (thread) =>
            !thread ||
            !thread.request ||
            thread.request.id !== updatedThread.request.id
        );
        filtered.push(updatedThread);
        filtered.sort((a, b) => {
          const aTime = a && a.request && a.request.updatedAt
            ? new Date(a.request.updatedAt).getTime()
            : 0;
          const bTime = b && b.request && b.request.updatedAt
            ? new Date(b.request.updatedAt).getTime()
            : 0;
          return bTime - aTime;
        });
        state.support.threads = filtered;
      }

      function removeSupportThreadFromState(threadId) {
        if (!threadId) {
          return;
        }
        const threads = getSupportThreads();
        const filtered = threads.filter(
          (thread) => !(thread && thread.request && thread.request.id === threadId)
        );
        state.support.threads = filtered;
        if (
          state.support.activeThreadId &&
          state.support.activeThreadId === threadId
        ) {
          state.support.activeThreadId = filtered.length
            ? filtered[0].request.id
            : null;
        }
      }

      function setSupportError(message = '', stateAttr = 'error') {
        if (!supportError) {
          return;
        }
        if (!message) {
          supportError.textContent = '';
          supportError.hidden = true;
          delete supportError.dataset.state;
          state.support.error = '';
          return;
        }
        supportError.textContent = message;
        supportError.hidden = false;
        if (stateAttr) {
          supportError.dataset.state = stateAttr;
        } else {
          delete supportError.dataset.state;
        }
        state.support.error = message;
      }

      function setSupportReplyStatusMessage(message = '', stateAttr = '') {
        if (!supportReplyStatus) {
          return;
        }
        supportReplyStatus.textContent = message;
        if (stateAttr) {
          supportReplyStatus.dataset.state = stateAttr;
        } else {
          delete supportReplyStatus.dataset.state;
        }
      }

      function renderSupportConversation() {
        if (!supportConversation) {
          return;
        }
        const thread = findSupportThread(state.support.activeThreadId);
        if (!thread) {
          supportConversation.hidden = true;
          setSupportReplyStatusMessage('');
          return;
        }

        supportConversation.hidden = false;
        const donorName =
          thread.request.donorDisplayName ||
          thread.request.donorName ||
          thread.request.donorEmail ||
          'Donor';
        if (supportRequestSubject) {
          supportRequestSubject.textContent =
            thread.request.subject || `Request #${thread.request.id}`;
        }
        const isResolved = Boolean(thread.request.resolved);
        if (supportRequestStatus) {
          supportRequestStatus.textContent = isResolved ? 'Resolved' : 'Open';
          supportRequestStatus.classList.toggle('support-status-open', !isResolved);
          supportRequestStatus.classList.toggle('support-status-resolved', isResolved);
        }
        if (supportRequestMeta) {
          const openedAt = formatDateTime(thread.request.createdAt);
          const updatedAt = formatDateTime(thread.request.updatedAt);
          supportRequestMeta.textContent = `${donorName} ? Updated ${updatedAt} ? Created ${openedAt}`;
        }
        if (supportMessageThread) {
          supportMessageThread.innerHTML = '';
          const messages = Array.isArray(thread.messages) ? thread.messages : [];
          if (messages.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'support-empty-state';
            empty.textContent = 'No messages yet.';
            supportMessageThread.appendChild(empty);
          } else {
            messages.forEach((message) => {
              const card = document.createElement('div');
              card.className = 'support-message-card';
              card.dataset.author = message.authorRole || 'donor';
              const authorEl = document.createElement('div');
              authorEl.className = 'support-message-author';
              authorEl.textContent =
                message.authorName ||
                (message.authorRole === 'admin' ? 'Admin' : donorName);
              const metaEl = document.createElement('div');
              metaEl.className = 'support-message-meta';
              metaEl.textContent = formatDateTime(message.createdAt);
              const bodyEl = document.createElement('div');
              bodyEl.textContent = message.body || '';
              card.append(authorEl, metaEl, bodyEl);
              supportMessageThread.appendChild(card);
            });
            supportMessageThread.scrollTop = supportMessageThread.scrollHeight;
          }
        }

        if (supportReplyTextarea) {
          supportReplyTextarea.value = '';
        }
        if (supportReplyStatus) {
          setSupportReplyStatusMessage('');
        }
        if (supportMarkResolvedButton) {
          supportMarkResolvedButton.hidden = isResolved;
        }
        if (supportReopenButton) {
          supportReopenButton.hidden = !isResolved;
        }
      }

      function renderSupportPanel() {
        if (!supportPanel || !supportRequestList) {
          return;
        }

        if (supportIncludeResolved) {
          supportIncludeResolved.checked = Boolean(state.support.includeResolved);
        }

        const threads = getSupportThreads();
        supportRequestList.innerHTML = '';

        if (!state.support.loaded) {
          const loading = document.createElement('div');
          loading.className = 'loading-spinner';
          loading.innerHTML = '<div class="loading-spinner-ring"></div><span>Loading support requests</span>';
          supportRequestList.appendChild(loading);
        } else if (threads.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty-state';
          empty.innerHTML = state.support.includeResolved
            ? `<div class="empty-state-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"/></svg></div><span class="empty-state-title">No support requests</span><span class="empty-state-description">There are no support requests to display.</span>`
            : `<div class="empty-state-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg></div><span class="empty-state-title">All caught up</span><span class="empty-state-description">No open support requests right now. Check back later or enable "Show resolved" to view past threads.</span>`;
          supportRequestList.appendChild(empty);
        } else {
          if (
            !threads.some((thread) => thread.request.id === state.support.activeThreadId)
          ) {
            state.support.activeThreadId = threads[0].request.id;
          }

          threads.forEach((thread) => {
            if (!thread || !thread.request) {
              return;
            }
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'support-request-card';
            card.setAttribute(
              'aria-current',
              thread.request.id === state.support.activeThreadId ? 'true' : 'false'
            );

            const subjectEl = document.createElement('h3');
            subjectEl.textContent =
              thread.request.subject || `Request #${thread.request.id}`;
            const statusEl = document.createElement('span');
            const resolved = Boolean(thread.request.resolved);
            statusEl.className = `support-status-pill ${resolved ? 'support-status-resolved' : 'support-status-open'}`;
            statusEl.textContent = resolved ? 'Resolved' : 'Open';
            const metaEl = document.createElement('div');
            metaEl.className = 'support-request-meta';
            const donorName =
              thread.request.donorDisplayName ||
              thread.request.donorName ||
              thread.request.donorEmail ||
              'Donor';
            metaEl.textContent = `${donorName} ? Updated ${formatDateTime(
              thread.request.updatedAt
            )}`;

            card.append(subjectEl, statusEl, metaEl);
            card.addEventListener('click', () => {
              state.support.activeThreadId = thread.request.id;
              renderSupportPanel();
            });

            supportRequestList.appendChild(card);
          });
        }

        if (state.support.error) {
          setSupportError(state.support.error);
        } else {
          setSupportError('');
        }

        renderSupportConversation();
        updateSupportBadge();
        renderAdminMetrics();
      }

      function updateSupportBadge() {
        const supportTab = document.getElementById('dashboard-tab-support');
        if (!supportTab) return;
        let badge = supportTab.querySelector('.tab-badge');
        const threads = Array.isArray(state.support.threads) ? state.support.threads : [];
        const openCount = threads.filter(t => t && t.request && !t.request.resolved).length;
        if (openCount > 0) {
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'tab-badge';
            supportTab.appendChild(badge);
          }
          badge.textContent = openCount > 99 ? '99+' : String(openCount);
        } else if (badge) {
          badge.remove();
        }
      }

      function resetPendingTwoFactorSetup() {
        state.pendingTwoFactorSetup = null;
        if (adminTwoFactorSetupPanel) {
          adminTwoFactorSetupPanel.classList.add('hidden');
        }
        if (adminTwoFactorQr) {
          adminTwoFactorQr.removeAttribute('src');
        }
        if (adminTwoFactorManualKey) {
          adminTwoFactorManualKey.value = '';
        }
        if (adminTwoFactorCode) {
          adminTwoFactorCode.value = '';
        }
        if (adminTwoFactorVerifyButton) {
          adminTwoFactorVerifyButton.disabled = true;
        }
      }

      function applyTwoFactorState(twoFactor) {
        state.adminTwoFactor =
          twoFactor && typeof twoFactor === 'object'
            ? {
                enabled: Boolean(twoFactor.enabled),
                setupCompletedAt: twoFactor.setupCompletedAt || null,
              }
            : {
                enabled: false,
                setupCompletedAt: null,
              };
      }

      function applyAdminOnboardingState(onboarding) {
        state.adminOnboarding =
          onboarding && typeof onboarding === 'object'
            ? {
                adminSetupRequired: Boolean(onboarding.adminSetupRequired),
                twoFactorPromptPending: Boolean(onboarding.twoFactorPromptPending),
              }
            : {
                adminSetupRequired: false,
                twoFactorPromptPending: false,
              };
      }

      function showLoginTotpForm() {
        state.twoFactorPending = true;
        if (adminSetupForm) {
          adminSetupForm.classList.add('hidden');
        }
        if (loginForm) {
          loginForm.classList.add('hidden');
        }
        if (loginTotpForm) {
          loginTotpForm.classList.remove('hidden');
        }
        if (loginHelp) {
          loginHelp.textContent =
            'Enter the rotating code from your authenticator app to finish signing in.';
        }
        if (loginTitle) {
          loginTitle.textContent = 'Two-Factor Verification';
        }
        if (loginTotpCodeInput) {
          loginTotpCodeInput.value = '';
          loginTotpCodeInput.focus();
        }
      }

      function showLoginPasswordForm() {
        state.twoFactorPending = false;
        const requiresSetup = Boolean(
          state.adminOnboarding && state.adminOnboarding.adminSetupRequired
        );
        if (adminSetupForm) {
          adminSetupForm.classList.toggle('hidden', !requiresSetup);
        }
        if (loginForm) {
          loginForm.classList.toggle('hidden', requiresSetup);
        }
        if (loginTotpForm) {
          loginTotpForm.classList.add('hidden');
        }
        if (loginTitle) {
          loginTitle.textContent = requiresSetup
            ? 'Complete First-Time Setup'
            : 'Admin Sign In';
        }
        if (loginHelp) {
          loginHelp.innerHTML = requiresSetup
            ? 'Create the first admin account for this Plex Donate install. Your existing donor and application data will remain untouched.'
            : 'Use your Plex Donate admin username and password to sign in.';
        }
        if (loginPasswordInput) {
          loginPasswordInput.value = '';
        }
        if (adminSetupUsernameInput) {
          adminSetupUsernameInput.value = state.adminUsername || '';
        }
        if (adminSetupPasswordInput) {
          adminSetupPasswordInput.value = '';
        }
        if (adminSetupConfirmPasswordInput) {
          adminSetupConfirmPasswordInput.value = '';
        }
      }

      function setServiceSummaryCard(stateEl, copyEl, configured, configuredText, missingText) {
        if (!stateEl || !copyEl) {
          return;
        }
        stateEl.dataset.status = configured ? 'active' : 'pending';
        stateEl.textContent = configured ? 'Ready' : 'Needs review';
        copyEl.textContent = configured ? configuredText : missingText;
      }

      function setSetupChecklistState(stateEl, configured) {
        if (!stateEl) {
          return;
        }
        stateEl.dataset.status = configured ? 'active' : 'pending';
        stateEl.textContent = configured ? 'Ready' : 'Needs review';
      }

      function getSetupConfiguration(settings) {
        const nextSettings = settings || {};
        const app = nextSettings.app || {};
        const paypal = nextSettings.paypal || {};
        const smtp = nextSettings.smtp || {};
        const plex = nextSettings.plex || {};
        return {
          appConfigured: [app.publicBaseUrl].some(hasNonEmptyValue),
          paypalConfigured: [
            paypal.clientId,
            paypal.clientSecret,
            paypal.webhookId,
            paypal.planId,
          ].every(hasNonEmptyValue),
          smtpConfigured: [smtp.host, smtp.user, smtp.pass, smtp.from].every(
            hasNonEmptyValue
          ),
          plexConfigured: [plex.baseUrl, plex.token].every(hasNonEmptyValue),
        };
      }

      function updateIntegrationBadge(settings) {
        if (!integrationTab) {
          return;
        }
        let badge = integrationTab.querySelector('.tab-badge');
        if (!state.authenticated) {
          if (badge) {
            badge.remove();
          }
          return;
        }
        if (!settings || typeof settings !== 'object') {
          if (badge) {
            badge.remove();
          }
          return;
        }
        const nextSettings = settings || {};
        const app = nextSettings.app || {};
        const paypal = nextSettings.paypal || {};
        const smtp = nextSettings.smtp || {};
        const plex = nextSettings.plex || {};
        const configuredCount = [
          [app.publicBaseUrl, app.overseerrBaseUrl].some(hasNonEmptyValue),
          [paypal.clientId, paypal.clientSecret, paypal.webhookId, paypal.planId].every(hasNonEmptyValue),
          [smtp.host, smtp.user, smtp.pass, smtp.from].every(hasNonEmptyValue),
          [plex.baseUrl, plex.token].every(hasNonEmptyValue),
        ].filter(Boolean).length;
        const missingCount = 4 - configuredCount;
        if (missingCount > 0) {
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'tab-badge';
            integrationTab.appendChild(badge);
          }
          badge.dataset.tone = 'warning';
          badge.textContent = String(missingCount);
        } else if (badge) {
          badge.remove();
        }
      }

      function renderServiceSummary() {
        const settings = state.settings || {};
        const app = settings.app || {};
        const paypal = settings.paypal || {};
        const smtp = settings.smtp || {};
        const plex = settings.plex || {};

        setServiceSummaryCard(
          serviceSummaryAppState,
          serviceSummaryAppCopy,
          [app.publicBaseUrl, app.overseerrBaseUrl].some(hasNonEmptyValue),
          'Public links and request URLs are configured.',
          'Add the public base URL and optional request URL used by donors.'
        );
        setServiceSummaryCard(
          serviceSummaryPaypalState,
          serviceSummaryPaypalCopy,
          [paypal.clientId, paypal.clientSecret, paypal.webhookId, paypal.planId].every(hasNonEmptyValue),
          'Billing credentials and plan details are saved.',
          'Save client credentials, webhook ID, and plan ID before checkout can work.'
        );
        setServiceSummaryCard(
          serviceSummarySmtpState,
          serviceSummarySmtpCopy,
          [smtp.host, smtp.user, smtp.pass, smtp.from].every(hasNonEmptyValue),
          'Email delivery is configured for invites and notifications.',
          'Complete SMTP settings so support, invites, and alerts can be delivered.'
        );
        setServiceSummaryCard(
          serviceSummaryPlexState,
          serviceSummaryPlexCopy,
          [plex.baseUrl, plex.token].every(hasNonEmptyValue),
          'Plex connection details are saved.',
          'Add your Plex server URL and token to send invites from the dashboard.'
        );
        updateIntegrationBadge(settings);
      }

      function renderSetupChecklist() {
        if (!adminSetupChecklist) {
          return;
        }
        const setup = getSetupConfiguration(state.settings || {});
        const allReady =
          setup.appConfigured &&
          setup.paypalConfigured &&
          setup.smtpConfigured &&
          setup.plexConfigured;

        adminSetupChecklist.classList.toggle('hidden', allReady);
        setSetupChecklistState(setupCheckAppState, setup.appConfigured);
        setSetupChecklistState(setupCheckEmailState, setup.smtpConfigured);
        setSetupChecklistState(setupCheckPaypalState, setup.paypalConfigured);
        setSetupChecklistState(setupCheckPlexState, setup.plexConfigured);
      }

      async function loadSupportRequests(options = {}) {
        if (!state.authenticated) {
          return false;
        }
        const { silent = false } = options;
        const query = state.support.includeResolved ? '?includeResolved=1' : '';
        state.support.loaded = false;
        if (!silent) {
          renderSupportPanel();
        }
        try {
          const response = await api(`/api/admin/support${query}`);
          const threads = Array.isArray(response.threads) ? response.threads : [];
          state.support.threads = threads;
          if (
            !threads.some((thread) => thread.request && thread.request.id === state.support.activeThreadId)
          ) {
            state.support.activeThreadId = threads.length > 0 ? threads[0].request.id : null;
          }
          state.support.error = '';
          state.support.loaded = true;
          renderSupportPanel();
          return true;
        } catch (err) {
          console.error('Failed to load support requests', err);
          state.support.threads = [];
          state.support.loaded = true;
          if (!silent) {
            setSupportError(
              err && err.message
                ? err.message
                : 'Failed to load support requests.'
            );
          } else {
            state.support.error = '';
            setSupportError('');
          }
          renderSupportPanel();
          return false;
        }
      }

      function formatSupportPayload({ subject, message }) {
        return {
          subject: subject ? subject.trim() : '',
          message: message ? message.trim() : '',
        };
      }

      function render() {
        renderAdminAccountPanel();
        renderAdminTwoFactorOnboardingBanner();
        renderProspectSharePanel();
        renderShareLinks();
        const shouldShowLoadingGate =
          initialSessionValidationPending || state.workspaceLoading;
        if (loadingGate) {
          loadingGate.classList.toggle('hidden', !shouldShowLoadingGate);
        }
        if (loadingGateMessage) {
          loadingGateMessage.textContent = initialSessionValidationPending
            ? 'Validating configuration and loading the admin workspace...'
            : state.workspaceLoadingMessage || 'Loading the admin workspace...';
        }
        if (state.workspaceLoading) {
          if (loginPageWrapper) {
            loginPageWrapper.classList.add('hidden');
          }
          loginPanel.classList.add('hidden');
          dashboard.classList.add('hidden');
          logoutButton.classList.add('hidden');
          if (prospectShareModal) {
            prospectShareModal.hidden = true;
          }
          return;
        }
        if (state.authenticated) {
          showLoginPasswordForm();
          if (loginPageWrapper) {
            loginPageWrapper.classList.add('hidden');
          }
          loginPanel.classList.add('hidden');
          dashboard.classList.remove('hidden');
          logoutButton.classList.remove('hidden');
          setLoginStatus('', '');
          renderSubscribers();
          renderEvents();
          renderSettings();
          renderSetupChecklist();
          renderSupportPanel();
        } else {
          if (loginPageWrapper) {
            loginPageWrapper.classList.remove('hidden');
          }
          loginPanel.classList.remove('hidden');
          dashboard.classList.add('hidden');
          logoutButton.classList.add('hidden');
          updateIntegrationBadge(null);
          updateSupportBadge();
          setLoginStatus('', '');
          if (state.twoFactorPending) {
            showLoginTotpForm();
          } else {
            showLoginPasswordForm();
          }
          if (
            loginUsernameInput &&
            !(
              state.adminOnboarding &&
              state.adminOnboarding.adminSetupRequired
            ) &&
            document.activeElement !== loginUsernameInput
          ) {
            loginUsernameInput.value = state.adminUsername || '';
          }
          if (
            adminSetupUsernameInput &&
            state.adminOnboarding &&
            state.adminOnboarding.adminSetupRequired &&
            document.activeElement !== adminSetupUsernameInput
          ) {
            adminSetupUsernameInput.value = state.adminUsername || '';
          }
          if (prospectShareModal) {
            prospectShareModal.hidden = true;
            document.body.style.overflow = '';
          }
        }
        applyActiveDashboardView();
      }

      function setFormStatus(form, message, stateAttr = '') {
        if (!form) {
          return;
        }
        const statusEl = form.querySelector('.form-status');
        if (!statusEl) {
          return;
        }
        statusEl.textContent = message;
        if (stateAttr) {
          statusEl.dataset.state = stateAttr;
        } else {
          delete statusEl.dataset.state;
        }
        if (stateAttr !== 'success') {
          const existing = statusClearTimers.get(form);
          if (existing) {
            clearTimeout(existing);
            statusClearTimers.delete(form);
          }
        }
      }

      function scheduleStatusClear(form, delay = 3000) {
        if (!form) {
          return;
        }
        const existing = statusClearTimers.get(form);
        if (existing) {
          clearTimeout(existing);
        }
        const timer = setTimeout(() => {
          const statusEl = form.querySelector('.form-status');
          if (statusEl && statusEl.dataset.state === 'success') {
            statusEl.textContent = '';
            delete statusEl.dataset.state;
          }
          statusClearTimers.delete(form);
        }, delay);
        statusClearTimers.set(form, timer);
      }

      function showDashboardToast(message, stateAttr = 'success', duration = 4000) {
        if (!dashboardToast) {
          return;
        }

        if (toastTimerId) {
          clearTimeout(toastTimerId);
          toastTimerId = null;
        }

        if (!message) {
          dashboardToast.classList.remove('toast-visible');
          dashboardToast.classList.add('toast-exit');
          setTimeout(() => {
            dashboardToast.textContent = '';
            dashboardToast.hidden = true;
            dashboardToast.classList.remove('toast-exit');
            delete dashboardToast.dataset.state;
          }, 350);
          return;
        }

        dashboardToast.textContent = message;
        if (stateAttr) {
          dashboardToast.dataset.state = stateAttr;
        } else {
          delete dashboardToast.dataset.state;
        }
        dashboardToast.hidden = false;
        dashboardToast.classList.remove('toast-exit');
        requestAnimationFrame(() => {
          dashboardToast.classList.add('toast-visible');
        });

        toastTimerId = setTimeout(() => {
          dashboardToast.classList.remove('toast-visible');
          dashboardToast.classList.add('toast-exit');
          setTimeout(() => {
            dashboardToast.textContent = '';
            dashboardToast.hidden = true;
            dashboardToast.classList.remove('toast-exit');
            delete dashboardToast.dataset.state;
            toastTimerId = null;
          }, 350);
        }, duration);
      }

      async function copyTextToClipboard(text) {
        const value = typeof text === 'string' ? text.trim() : '';
        if (!value) {
          return false;
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
          try {
            await navigator.clipboard.writeText(value);
            return true;
          } catch (err) {
            console.warn('Clipboard copy failed', err);
          }
        }

        const helper = document.createElement('textarea');
        helper.value = value;
        helper.setAttribute('readonly', 'readonly');
        helper.style.position = 'fixed';
        helper.style.top = '-9999px';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        helper.setSelectionRange(0, helper.value.length);

        let copied = false;
        try {
          copied = document.execCommand('copy');
        } catch (err) {
          copied = false;
        } finally {
          document.body.removeChild(helper);
        }

        return copied;
      }

      async function copyShareUrlWithFeedback(shareUrl, successMessage) {
        if (!shareUrl) {
          showDashboardToast('Unable to determine setup link URL.', 'error');
          return false;
        }

        const copied = await copyTextToClipboard(shareUrl);
        if (copied) {
          showDashboardToast(successMessage, 'success');
          return true;
        }

        showDashboardToast(`Copy this setup link manually: ${shareUrl}`, 'info', 8000);
        return false;
      }

      function getFormPayload(form) {
        const payload = {};
        form.querySelectorAll('[name]').forEach((input) => {
          if (input.dataset && input.dataset.transient === 'true') {
            return;
          }
          if (input.type === 'checkbox') {
            payload[input.name] = input.checked;
          } else {
            payload[input.name] = input.value;
          }
        });
        return payload;
      }

      function parseLibraryIdList(value) {
        if (value === undefined || value === null) {
          return [];
        }
        if (Array.isArray(value)) {
          const result = [];
          value.forEach((entry) => {
            result.push(...parseLibraryIdList(entry));
          });
          return result;
        }
        return String(value)
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
      }

      function normalizePlexLibraryValue(value, options = {}) {
        const { skipAvailabilityCheck = false } = options;
        const candidates = parseLibraryIdList(value);
        const seen = new Set();
        const normalized = [];
        candidates.forEach((entry) => {
          const id = String(entry).trim();
          if (!id || seen.has(id)) {
            return;
          }
          seen.add(id);
          normalized.push(id);
        });
        if (skipAvailabilityCheck) {
          return normalized;
        }
        if (Array.isArray(state.plexLibraries) && state.plexLibraries.length) {
          const allowed = new Set(
            state.plexLibraries.map((library) => String(library.id))
          );
          return normalized.filter((id) => allowed.has(id));
        }
        return normalized;
      }

      function getPlexLibraryRawSelection() {
        if (!plexLibraryInput) {
          return [];
        }
        const raw = plexLibraryInput.dataset.rawSelection || plexLibraryInput.value;
        return normalizePlexLibraryValue(raw, { skipAvailabilityCheck: true });
      }

      function getPlexLibrarySelection() {
        if (!plexLibraryInput) {
          return [];
        }
        return normalizePlexLibraryValue(plexLibraryInput.value);
      }

      function setPlexLibrarySelection(value, options = {}) {
        if (!plexLibraryInput) {
          return;
        }
        const { skipAvailabilityCheck = false, rawValue } = options;
        const rawSource = rawValue !== undefined ? rawValue : value;
        const normalizedRaw = normalizePlexLibraryValue(rawSource, {
          skipAvailabilityCheck: true,
        });
        plexLibraryInput.dataset.rawSelection = normalizedRaw.join(',');
        const normalized = normalizePlexLibraryValue(value, { skipAvailabilityCheck });
        plexLibraryInput.value = normalized.join(',');
      }

      function updatePlexLibraryToggleState() {
        if (!plexLibraryToggle) {
          return;
        }
        const availableCount = Array.isArray(state.plexLibraries)
          ? state.plexLibraries.length
          : 0;
        if (Array.isArray(state.plexLibraries)) {
          hasCachedPlexLibraries = availableCount > 0;
        }
        const disabled = availableCount === 0 && !hasCachedPlexLibraries;
        plexLibraryToggle.disabled = disabled;
        if (disabled) {
          plexLibraryToggle.setAttribute('aria-expanded', 'false');
          closePlexLibraryDropdown();
        }
      }

      function updatePlexLibraryHelp() {
        if (!plexLibraryHelp) {
          return;
        }
        if (Array.isArray(state.plexLibraries) && state.plexLibraries.length) {
          plexLibraryHelp.textContent =
            'Choose the Plex libraries that new invites should include.';
        } else {
          plexLibraryHelp.textContent =
            'Test the Plex connection to load your server\'s libraries.';
        }
      }

      function updatePlexLibraryToggleLabel() {
        if (!plexLibraryToggle) {
          return;
        }
        const selection = getPlexLibrarySelection();
        const rawSelection = getPlexLibraryRawSelection();
        const hasLoadedLibraries = Array.isArray(state.plexLibraries)
          ? state.plexLibraries.length > 0
          : false;
        const count = hasLoadedLibraries ? selection.length : rawSelection.length;

        if (count === 1) {
          plexLibraryToggle.textContent = '1 library selected';
        } else if (count > 1) {
          plexLibraryToggle.textContent = `${count} libraries selected`;
        } else {
          plexLibraryToggle.textContent = 'Select libraries';
        }
      }

      function updatePlexLibraryOptions() {
        if (!plexLibraryOptions) {
          return;
        }
        plexLibraryOptions.innerHTML = '';
        const libraries = Array.isArray(state.plexLibraries)
          ? state.plexLibraries
          : [];
        const hasLibraries = libraries.length > 0;
        if (plexLibraryEmpty) {
          plexLibraryEmpty.hidden = Array.isArray(state.plexLibraries)
            ? hasLibraries
            : true;
        }
        if (!hasLibraries) {
          return;
        }

        const selected = new Set(getPlexLibrarySelection());
        libraries.forEach((library) => {
          if (!library) {
            return;
          }
          const id = library.id != null ? String(library.id) : '';
          if (!id) {
            return;
          }
          const label = document.createElement('label');
          label.className = 'checkbox-row library-option';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = id;
          checkbox.checked = selected.has(id);
          checkbox.addEventListener('change', () => {
            const rawSelection = new Set(getPlexLibraryRawSelection());
            if (checkbox.checked) {
              rawSelection.add(id);
            } else {
              rawSelection.delete(id);
            }
            const nextSelection = Array.from(rawSelection);
            setPlexLibrarySelection(nextSelection, { rawValue: nextSelection });
            updatePlexLibrarySummary();
            updatePlexLibraryToggleLabel();
          });
          const name = document.createElement('span');
          name.textContent = library.title || 'Unnamed library';
          label.appendChild(checkbox);
          label.appendChild(name);
          plexLibraryOptions.appendChild(label);
        });
      }

      function updatePlexLibrarySummary() {
        if (!plexLibrarySummary) {
          return;
        }
        const rawSelection = getPlexLibraryRawSelection();
        const validatedSelection = getPlexLibrarySelection();
        const librariesLoaded = Array.isArray(state.plexLibraries);
        const hasLibraries = librariesLoaded
          ? state.plexLibraries.length > 0
          : false;
        const missing = rawSelection.filter(
          (id) => !validatedSelection.includes(id)
        );

        if (librariesLoaded && missing.length) {
          plexLibrarySummary.textContent =
            'Some previously selected libraries are no longer available. Test the Plex connection again to refresh the list.';
          plexLibrarySummary.hidden = false;
          return;
        }

        if (!librariesLoaded && rawSelection.length) {
          plexLibrarySummary.textContent =
            'Your saved library selection will appear after testing the Plex connection.';
          plexLibrarySummary.hidden = false;
          return;
        }

        if (librariesLoaded && hasLibraries && validatedSelection.length === 0) {
          plexLibrarySummary.textContent = 'No libraries selected yet.';
          plexLibrarySummary.hidden = false;
          return;
        }

        if (librariesLoaded && validatedSelection.length > 0) {
          const names = validatedSelection
            .map((id) => {
              const match = state.plexLibraries.find(
                (library) => String(library.id) === id
              );
              return match && match.title ? match.title : null;
            })
            .filter(Boolean);

          if (names.length) {
            plexLibrarySummary.textContent = `Selected libraries: ${names.join(', ')}.`;
            plexLibrarySummary.hidden = false;
            return;
          }
        }

        plexLibrarySummary.textContent = '';
        plexLibrarySummary.hidden = true;
      }

      function renderPlexLibrarySelector(options = {}) {
        if (!plexLibraryInput) {
          return;
        }
        const { preserveSelection = false, preferredSelection = null } = options;
        const savedValue =
          state.settings &&
          state.settings.plex &&
          state.settings.plex.librarySectionIds;

        if (!preserveSelection || !plexLibraryInput.value) {
          const initialValue =
            preferredSelection !== null && preferredSelection !== undefined
              ? preferredSelection
              : savedValue || '';
          setPlexLibrarySelection(initialValue, { skipAvailabilityCheck: true });
        } else if (
          preferredSelection !== null &&
          preferredSelection !== undefined
        ) {
          setPlexLibrarySelection(preferredSelection, {
            skipAvailabilityCheck: true,
          });
        }

        if (Array.isArray(state.plexLibraries)) {
          const rawSelection = getPlexLibraryRawSelection();
          setPlexLibrarySelection(rawSelection);
        }

        updatePlexLibraryToggleState();
        updatePlexLibraryHelp();
        if (plexLibraryDropdownOpen || plexLibraryOptionsDirty) {
          updatePlexLibraryOptions();
          plexLibraryOptionsDirty = false;
        }
        updatePlexLibrarySummary();
        updatePlexLibraryToggleLabel();
      }

      let plexLibraryDropdownOpen = false;
      let plexLibraryOptionsDirty = false;
      let hasCachedPlexLibraries = false;

      function closePlexLibraryDropdown(options = {}) {
        if (!plexLibraryDropdown) {
          return;
        }
        plexLibraryDropdown.hidden = true;
        plexLibraryDropdownOpen = false;
        document.removeEventListener('click', handlePlexLibraryDocumentClick, true);
        document.removeEventListener('keydown', handlePlexLibraryKeydown);
        if (options.focusToggle && plexLibraryToggle) {
          plexLibraryToggle.focus();
        }
        if (plexLibraryToggle) {
          plexLibraryToggle.setAttribute('aria-expanded', 'false');
        }
      }

      function openPlexLibraryDropdown() {
        if (!plexLibraryDropdown || !plexLibraryToggle) {
          return;
        }
        if (plexLibraryToggle.disabled) {
          return;
        }
        updatePlexLibraryOptions();
        plexLibraryOptionsDirty = false;
        plexLibraryDropdown.hidden = false;
        plexLibraryDropdownOpen = true;
        plexLibraryToggle.setAttribute('aria-expanded', 'true');
        document.addEventListener('click', handlePlexLibraryDocumentClick, true);
        document.addEventListener('keydown', handlePlexLibraryKeydown);
      }

      function handlePlexLibraryDocumentClick(event) {
        if (!plexLibraryDropdownOpen || !plexLibraryPicker) {
          return;
        }
        if (plexLibraryPicker.contains(event.target)) {
          return;
        }
        closePlexLibraryDropdown();
      }

      function handlePlexLibraryKeydown(event) {
        if (event.key === 'Escape') {
          closePlexLibraryDropdown({ focusToggle: true });
        }
      }

      if (plexLibraryToggle) {
        plexLibraryToggle.addEventListener('click', (event) => {
          event.preventDefault();
          if (plexLibraryToggle.disabled) {
            return;
          }
          if (plexLibraryDropdownOpen) {
            closePlexLibraryDropdown({ focusToggle: true });
          } else {
            openPlexLibraryDropdown();
          }
        });
      }

      if (plexLibraryApplyButton) {
        plexLibraryApplyButton.addEventListener('click', (event) => {
          event.preventDefault();
          closePlexLibraryDropdown({ focusToggle: true });
        });
      }

      if (plexLibraryClearButton) {
        plexLibraryClearButton.addEventListener('click', (event) => {
          event.preventDefault();
          setPlexLibrarySelection([], { rawValue: [] });
          updatePlexLibraryOptions();
          updatePlexLibrarySummary();
          updatePlexLibraryToggleLabel();
        });
      }

      closePlexLibraryDropdown();

      const ANNOUNCEMENT_TONE_LABELS = {
        info: 'Information',
        success: 'Success',
        warning: 'Warning',
        danger: 'Alert',
        neutral: 'Neutral',
      };

      function normalizeAnnouncementPreview(values) {
        const payload = values && typeof values === 'object' ? values : {};
        const enabled = payload.bannerEnabled === true || payload.bannerEnabled === 'true';
        const dismissible =
          payload.bannerDismissible === true || payload.bannerDismissible === 'true';
        const ctaEnabled =
          payload.bannerCtaEnabled === true || payload.bannerCtaEnabled === 'true';
        const toneRaw = typeof payload.bannerTone === 'string'
          ? payload.bannerTone.trim().toLowerCase()
          : '';
        const tone = Object.prototype.hasOwnProperty.call(
          ANNOUNCEMENT_TONE_LABELS,
          toneRaw
        )
          ? toneRaw
          : 'info';
        const title = typeof payload.bannerTitle === 'string'
          ? payload.bannerTitle.trim()
          : '';
        const body = typeof payload.bannerBody === 'string'
          ? payload.bannerBody.trim()
          : '';
        const ctaLabel = typeof payload.bannerCtaLabel === 'string'
          ? payload.bannerCtaLabel.trim()
          : '';
        const ctaUrl = typeof payload.bannerCtaUrl === 'string'
          ? payload.bannerCtaUrl.trim()
          : '';
        const ctaOpenInNewTab =
          payload.bannerCtaOpenInNewTab === true ||
          payload.bannerCtaOpenInNewTab === 'true';

        return {
          enabled,
          tone,
          title,
          body,
          dismissible,
          cta:
            enabled && ctaEnabled && ctaLabel && ctaUrl
              ? { label: ctaLabel, url: ctaUrl, openInNewTab: ctaOpenInNewTab }
              : null,
        };
      }

      function renderAnnouncementPreview() {
        if (!announcementPreview) {
          return;
        }
        const values = announcementsForm ? getFormPayload(announcementsForm) : {};
        const preview = normalizeAnnouncementPreview(values);

        if (announcementEmailButton) {
          announcementEmailButton.disabled = !(preview.title && preview.body);
        }

        if (announcementPreviewBanner) {
          announcementPreviewBanner.dataset.tone = preview.tone;
        }

        if (!preview.enabled) {
          if (announcementPreviewBanner) {
            announcementPreviewBanner.hidden = true;
          }
          if (announcementPreviewEmpty) {
            announcementPreviewEmpty.hidden = false;
          }
          return;
        }

        if (announcementPreviewEmpty) {
          announcementPreviewEmpty.hidden = true;
        }
        if (announcementPreviewBanner) {
          announcementPreviewBanner.hidden = false;
        }
        if (announcementPreviewChip) {
          const label = ANNOUNCEMENT_TONE_LABELS[preview.tone] || 'Information';
          announcementPreviewChip.textContent = label;
        }
        if (announcementPreviewTitle) {
          announcementPreviewTitle.textContent = preview.title || 'Add a banner title';
        }
        if (announcementPreviewBody) {
          announcementPreviewBody.textContent =
            preview.body || 'Write a short message to show donors on the dashboard.';
        }
        if (announcementPreviewDismiss) {
          announcementPreviewDismiss.hidden = !preview.dismissible;
          if (preview.dismissible) {
            announcementPreviewDismiss.dataset.interactive = 'true';
          } else {
            delete announcementPreviewDismiss.dataset.interactive;
          }
        }
        if (announcementPreviewCta) {
          if (preview.cta) {
            announcementPreviewCta.hidden = false;
            announcementPreviewCta.textContent = preview.cta.label;
          } else {
            announcementPreviewCta.hidden = true;
            announcementPreviewCta.textContent = '';
          }
        }
      }

      if (announcementsForm) {
        announcementsForm.addEventListener('input', renderAnnouncementPreview);
        announcementsForm.addEventListener('change', renderAnnouncementPreview);
      }

      function renderSettings() {
        if (settingsForms.length === 0) {
          return;
        }
        if (settingsPanel) {
          settingsPanel.hidden = Boolean(state.authenticated && !state.settings);
        }
        if (state.settings) {
          settingsForms.forEach((form) => {
            if (form.dataset && form.dataset.dirty === 'true') {
              return;
            }
            const group = form.dataset.group;
            const values = group && state.settings ? state.settings[group] : null;
            form.querySelectorAll('[name]').forEach((input) => {
              if (input.dataset && input.dataset.transient === 'true') {
                return;
              }
              if (input.type === 'checkbox') {
                input.checked = Boolean(values && values[input.name]);
              } else {
                const rawValue = values ? values[input.name] : '';
                input.value = rawValue == null ? '' : String(rawValue);
              }
            });
          });
        }
        renderPlexLibrarySelector({ preserveSelection: false });
        renderPaypalPlan();
        renderAnnouncementPreview();
        renderServiceSummary();
        renderSetupChecklist();
      }

      function renderPaypalPlan() {
        if (!paypalPlanSection || !paypalPlanBody) {
          return;
        }

        if (paypalPlanManageLink) {
          if (state.paypalPlanManageUrl) {
            paypalPlanManageLink.href = state.paypalPlanManageUrl;
            paypalPlanManageLink.hidden = false;
          } else {
            paypalPlanManageLink.hidden = true;
          }
        }

        if (state.paypalPlanLoading) {
          paypalPlanBody.classList.remove('empty');
          paypalPlanBody.innerHTML =
            '<p class="plan-loading">Loading PayPal plan details?</p>';
          return;
        }

        if (state.paypalPlanError) {
          paypalPlanBody.classList.remove('empty');
          paypalPlanBody.innerHTML = `<p class="plan-error">${escapeHtml(
            state.paypalPlanError
          )}</p>`;
          return;
        }

        if (!state.paypalPlan) {
          paypalPlanBody.classList.add('empty');
          paypalPlanBody.innerHTML =
            '<p>No PayPal subscription plan has been generated yet.</p>';
          if (paypalPlanManageLink) {
            paypalPlanManageLink.hidden = true;
          }
          return;
        }

        paypalPlanBody.classList.remove('empty');
        paypalPlanBody.innerHTML = buildPaypalPlanDetails(
          state.paypalPlan,
          state.paypalProduct
        );
      }

      function openProspectShareModal(trigger = null) {
        if (!prospectShareModal || !state.authenticated) {
          return;
        }
        if (trigger) {
          lastProspectShareTrigger = trigger;
        }
        prospectShareModal.hidden = false;
        document.body.style.overflow = 'hidden';
        const preferredFocusTarget =
          prospectShareForm &&
          (prospectShareForm.querySelector('[name="email"]') ||
            prospectShareForm.querySelector('button[type="submit"]'));
        if (preferredFocusTarget) {
          window.requestAnimationFrame(() => preferredFocusTarget.focus());
        }
      }

      function closeProspectShareModal() {
        if (!prospectShareModal || prospectShareModal.hidden) {
          return;
        }
        prospectShareModal.hidden = true;
        document.body.style.overflow = '';
        if (lastProspectShareTrigger && typeof lastProspectShareTrigger.focus === 'function') {
          lastProspectShareTrigger.focus();
        }
      }

      function renderProspectSharePanel() {
        if (!prospectShareModal) {
          return;
        }

        if (!state.authenticated) {
          prospectShareModal.hidden = true;
          document.body.style.overflow = '';
          if (prospectShareOpen) {
            prospectShareOpen.disabled = true;
          }
          if (prospectShareResult) {
            prospectShareResult.classList.add('hidden');
          }
          if (prospectShareCopy) {
            prospectShareCopy.disabled = true;
          }
          if (prospectShareRegenerate) {
            prospectShareRegenerate.disabled = true;
          }
          return;
        }

        if (prospectShareOpen) {
          prospectShareOpen.disabled = false;
        }

        const shareData = state.prospectShare || null;
        const prospect = shareData && shareData.prospect ? shareData.prospect : null;
        const shareLink = shareData && shareData.shareLink ? shareData.shareLink : null;
        const shareUrl = buildShareUrl(shareLink);

        if (prospectShareUrl) {
          if (shareUrl) {
            prospectShareUrl.href = shareUrl;
            prospectShareUrl.textContent = shareUrl;
          } else {
            prospectShareUrl.removeAttribute('href');
            prospectShareUrl.textContent = '';
          }
        }

        if (prospectShareNote) {
          prospectShareNote.textContent =
            prospect && prospect.note ? `Note: ${prospect.note}` : '';
        }

        if (prospectShareSummary) {
          const summaryParts = [];
          if (prospect && prospect.name) {
            summaryParts.push(prospect.name);
          }
          if (prospect && prospect.email) {
            summaryParts.push(prospect.email);
          }
          if (shareUrl) {
            prospectShareSummary.textContent =
              summaryParts.length > 0
                ? `Link ready for ${summaryParts.join(' ? ')}`
                : 'Share this link with your prospective supporter.';
          } else if (summaryParts.length > 0) {
            prospectShareSummary.textContent = `Preparing link for ${summaryParts.join(
              ' ? '
            )}`;
          } else {
            prospectShareSummary.textContent = '';
          }
        }

        if (!shareUrl) {
          if (prospectShareResult) {
            prospectShareResult.classList.add('hidden');
          }
          if (prospectShareCopy) {
            prospectShareCopy.disabled = true;
          }
          if (prospectShareRegenerate) {
            prospectShareRegenerate.disabled = !(prospect && prospect.id);
          }
          return;
        }

        if (prospectShareResult) {
          prospectShareResult.classList.remove('hidden');
        }
        if (prospectShareCopy) {
          prospectShareCopy.disabled = false;
        }
        if (prospectShareRegenerate) {
          prospectShareRegenerate.disabled = false;
        }
      }

      async function generateProspectShareLink({ regenerate = false } = {}) {
        if (!prospectShareForm) {
          return;
        }

        const submitButton = prospectShareForm.querySelector('button[type="submit"]');
        const previousDisabledState = submitButton ? submitButton.disabled : false;

        const formPayload = getFormPayload(prospectShareForm);
        const requestBody = {
          email: (formPayload.email || '').trim(),
          name: (formPayload.name || '').trim(),
          note: (formPayload.note || '').trim(),
        };

        const parsedProspectId = Number.parseInt(formPayload.prospectId, 10);
        if (Number.isFinite(parsedProspectId) && parsedProspectId > 0) {
          requestBody.prospectId = parsedProspectId;
        }
        if (regenerate) {
          requestBody.regenerate = true;
        }

        setFormStatus(
          prospectShareForm,
          regenerate
            ? 'Creating a fresh setup link?'
            : 'Creating setup link?',
          'info'
        );

        if (submitButton) {
          submitButton.disabled = true;
        }
        if (prospectShareRegenerate) {
          prospectShareRegenerate.disabled = true;
        }
        if (prospectShareCopy) {
          prospectShareCopy.disabled = true;
        }

        try {
          const response = await api('/api/admin/share-links/prospect', {
            method: 'POST',
            body: requestBody,
          });

          const prospect = response.prospect || null;
          const shareLink = response.shareLink || null;
          state.prospectShare = { prospect, shareLink };

          if (prospectShareForm) {
            const emailInput = prospectShareForm.querySelector('[name="email"]');
            if (emailInput) {
              emailInput.value = prospect && prospect.email ? prospect.email : '';
            }
            const nameInput = prospectShareForm.querySelector('[name="name"]');
            if (nameInput) {
              nameInput.value = prospect && prospect.name ? prospect.name : '';
            }
            const noteInput = prospectShareForm.querySelector('[name="note"]');
            if (noteInput) {
              noteInput.value = prospect && prospect.note ? prospect.note : '';
            }
            const idInput = prospectShareForm.querySelector('[name="prospectId"]');
            if (idInput) {
              idInput.value = prospect && prospect.id ? String(prospect.id) : '';
            }
          }

          renderProspectSharePanel();

          await refreshShareLinks();
          renderShareLinks();

          const shareUrl = buildShareUrl(shareLink);
          let copied = false;
          if (shareUrl && navigator.clipboard && navigator.clipboard.writeText) {
            try {
              await navigator.clipboard.writeText(shareUrl);
              copied = true;
            } catch (err) {
              console.warn('Clipboard copy failed', err);
            }
          }

          setFormStatus(
            prospectShareForm,
            copied
              ? 'Setup link copied to clipboard!'
              : 'Setup link ready! Use the buttons below to share.',
            'success'
          );
          openProspectShareModal();
          scheduleStatusClear(prospectShareForm, 4000);
        } catch (err) {
          setFormStatus(prospectShareForm, err.message, 'error');
        } finally {
          if (submitButton) {
            submitButton.disabled = previousDisabledState;
          }
          const hasProspect = Boolean(
            state.prospectShare &&
              state.prospectShare.prospect &&
              state.prospectShare.prospect.id
          );
          const hasShareLink = Boolean(
            buildShareUrl(state.prospectShare && state.prospectShare.shareLink)
          );
          if (prospectShareRegenerate) {
            prospectShareRegenerate.disabled = !hasProspect;
          }
          if (prospectShareCopy) {
            prospectShareCopy.disabled = !hasShareLink;
          }
        }
      }

      function getPlexCredentialSignature(settings) {
        if (!settings || !settings.plex) {
          return null;
        }
        const { baseUrl, token } = settings.plex;
        const normalize = (value) => (value == null ? '' : String(value));
        return [normalize(baseUrl), normalize(token)].join('::');
      }

      function applySettingsPayload(nextSettings) {
        const previousSettings = state.settings;
        const previousSignature = getPlexCredentialSignature(state.settings);
        const nextSignature = getPlexCredentialSignature(nextSettings);
        const credentialsChanged = previousSignature !== nextSignature;
        state.settings = nextSettings;
        if (!previousSettings && !anySettingsFormDirty()) {
          clearSettingsFormDirtyFlags();
        }
        if (credentialsChanged) {
          state.plexLibraries = null;
          hasCachedPlexLibraries = false;
        }
        plexLibraryOptionsDirty = true;
        settingsForms.forEach((form) => setFormStatus(form, ''));
        renderSettings();
      }

      function applyPaypalPlanPayload(payload) {
        if (!payload) {
          state.paypalPlan = null;
          state.paypalProduct = null;
          state.paypalPlanManageUrl = '';
          state.paypalPlanError = '';
          state.paypalPlanLoading = false;
          return;
        }
        state.paypalPlan = payload.plan || null;
        state.paypalProduct = payload.product || null;
        state.paypalPlanManageUrl = payload.manageUrl || '';
        state.paypalPlanError = payload.error || '';
        state.paypalPlanLoading = false;
      }

      async function loadSettings() {
        if (!settingsPanel) {
          return;
        }
        try {
          const response = await api('/api/admin/settings');
          applySettingsPayload(response.settings || {});
        } catch (err) {
          console.error(err);
        }
      }

      async function loadPaypalPlan() {
        if (!paypalPlanSection) {
          return;
        }

        const paypalSettings =
          state.settings && state.settings.paypal ? state.settings.paypal : null;

        if (!paypalSettings || !paypalSettings.planId) {
          state.paypalPlan = null;
          state.paypalProduct = null;
          state.paypalPlanManageUrl = '';
          state.paypalPlanError = '';
          state.paypalPlanLoading = false;
          renderPaypalPlan();
          return;
        }

        state.paypalPlanLoading = true;
        state.paypalPlanError = '';
        renderPaypalPlan();

        try {
          const response = await api('/api/admin/settings/paypal/plan');
          applyPaypalPlanPayload({
            plan: response.plan || null,
            product: response.product || null,
            manageUrl: response.manageUrl || '',
            error: response.error || '',
          });
        } catch (err) {
          applyPaypalPlanPayload({
            plan: null,
            product: null,
            manageUrl: '',
            error: err.message || 'Unable to load PayPal plan details.',
          });
        } finally {
          state.paypalPlanLoading = false;
          renderPaypalPlan();
        }
      }

      // Master-detail donors view functions
      function getFilteredDonors() {
        const donors = Array.isArray(state.donors) ? state.donors : [];

        return donors.filter(donor => {
          // Apply status filter
          const status = (donor.status || 'pending').toLowerCase();
          if (currentFilter !== 'all' && status !== currentFilter) {
            return false;
          }

          // Apply search query
          if (searchQuery) {
            const query = searchQuery.toLowerCase();
            const name = (donor.name || '').toLowerCase();
            const email = (donor.email || '').toLowerCase();
            const subId = (donor.subscriptionId || '').toLowerCase();
            return name.includes(query) || email.includes(query) || subId.includes(query);
          }

          return true;
        });
      }

      function updateFilterCounts() {
        const donors = Array.isArray(state.donors) ? state.donors : [];
        const counts = {
          all: donors.length,
          active: 0,
          pending: 0,
          cancelled: 0,
          suspended: 0
        };

        donors.forEach(donor => {
          const status = (donor.status || 'pending').toLowerCase();
          if (counts.hasOwnProperty(status)) {
            counts[status]++;
          }
        });

        Object.keys(counts).forEach(filter => {
          const countElement = document.querySelector(`[data-count-for="${filter}"]`);
          if (countElement) {
            countElement.textContent = counts[filter];
          }
        });
      }

      function renderAdminMetrics() {
        const donors = Array.isArray(state.donors) ? state.donors : [];
        const openSupportCount = Array.isArray(state.support && state.support.threads)
          ? state.support.threads.filter(
              (thread) => thread && thread.request && !thread.request.resolved
            ).length
          : 0;
        const activeCount = donors.filter((donor) => {
          const status = (donor.status || '').toLowerCase();
          return status === 'active' || status === 'trial';
        }).length;
        const plexSharedCount = donors.filter(
          (donor) => donor && (donor.plexShareState === 'shared' || donor.plexShared)
        ).length;
        const needsInviteCount = donors.filter((donor) => donor && donor.needsPlexInvite).length;
        const refreshErrorCount = donors.filter(
          (donor) =>
            donor &&
            typeof donor.paypalRefreshError === 'string' &&
            donor.paypalRefreshError.trim()
        ).length;
        const pendingCount = donors.filter(
          (donor) => (donor.status || '').toLowerCase() === 'pending'
        ).length;
        const attentionCount = needsInviteCount + refreshErrorCount + openSupportCount;

        const setMetric = (id, value) => {
          const el = document.getElementById(id);
          if (el) {
            el.textContent = String(value);
          }
        };
        const setNote = (id, text) => {
          const el = document.getElementById(id);
          if (el) {
            el.textContent = text;
          }
        };

        setMetric('metric-active-subscribers', activeCount);
        setMetric('metric-plex-shared', plexSharedCount);
        setMetric('metric-needs-attention', attentionCount);
        setMetric('metric-open-support', openSupportCount);
        setNote(
          'metric-active-note',
          activeCount === 1 ? '1 supporter can stream' : `${activeCount} supporters can stream`
        );
        setNote(
          'metric-plex-note',
          plexSharedCount === donors.length && donors.length > 0
            ? 'Everyone is matched in Plex'
            : `${needsInviteCount} invite${needsInviteCount === 1 ? '' : 's'} to send`
        );
        setNote(
          'metric-attention-note',
          attentionCount
            ? `${refreshErrorCount} billing note${refreshErrorCount === 1 ? '' : 's'}, ${pendingCount} pending`
            : 'Everything calm'
        );
        setNote(
          'metric-support-note',
          openSupportCount === 1 ? '1 open request' : `${openSupportCount} open requests`
        );
      }

      function renderDonorsList() {
        if (!donorsList) return;

        const filteredDonors = getFilteredDonors();
        donorsList.innerHTML = '';

        if (filteredDonors.length === 0) {
          const emptyMessage = document.createElement('div');
          emptyMessage.className = 'donors-empty-state';
          emptyMessage.textContent = searchQuery ? 'No donors match your search' : 'No donors found';
          donorsList.appendChild(emptyMessage);
          return;
        }

        const template = document.getElementById('donor-card');
        filteredDonors.forEach(donor => {
          const clone = template.content.cloneNode(true);
          const card = clone.querySelector('.donor-card');
          card.dataset.donorId = donor.id;

          const nameEl = clone.querySelector('.donor-card-name');
          const emailEl = clone.querySelector('.donor-card-email');
          const statusEl = clone.querySelector('.donor-card-status');
          const paymentEl = clone.querySelector('.donor-card-payment');
          const plexStatusEl = clone.querySelector('.donor-card-plex-status');
          const metaEl = clone.querySelector('.donor-card-meta');

          nameEl.textContent = donor.name || donor.email || 'Unknown';
          emailEl.textContent = donor.email || '?';

          const status = (donor.status || 'pending').toLowerCase();
          // Set data-status on card for color-coded borders
          card.dataset.status = status;
          statusEl.dataset.status = status;
          statusEl.textContent = status.replace(/_/g, ' ');

          // Enhanced payment display - show both amount and date
          const paymentText = formatAmount(donor);
          const dateText = donor.lastPaymentAt ? formatDateTime(donor.lastPaymentAt) : '';
          const paymentParts = [];
          if (paymentText) {
            paymentParts.push(`<i data-lucide="dollar-sign" class="donor-card-icon"></i>${paymentText}`);
          }
          if (dateText) {
            paymentParts.push(`<i data-lucide="calendar" class="donor-card-icon"></i>${dateText}`);
          }
          paymentEl.innerHTML = paymentParts.length > 0 ? paymentParts.join(' ') : '?';

          // Add Plex status indicator
          if (plexStatusEl) {
            let plexIcon = '';
            if (donor.hadPreexistingAccess) {
              plexIcon = '<i data-lucide="shield-check" class="donor-card-icon" style="color: #3b82f6;"></i>Pre-existing';
            } else if (donor.plexShareState === 'shared') {
              plexIcon = '<i data-lucide="play-circle" class="donor-card-icon"></i>Shared';
            } else if (donor.plexShareState === 'pending') {
              plexIcon = '<i data-lucide="clock" class="donor-card-icon"></i>Pending';
            } else if (donor.needsPlexInvite) {
              plexIcon = '<i data-lucide="mail" class="donor-card-icon"></i>Invite';
            }
            plexStatusEl.innerHTML = plexIcon;
          }

          if (metaEl && status === 'trial') {
            const countdown = formatTrialCountdown(donor.accessExpiresAt);
            if (countdown) {
              const trialBadge = document.createElement('span');
              trialBadge.className = 'donor-card-meta-item trial-countdown';
              trialBadge.innerHTML = `
                <span class="badge badge-trial"><i data-lucide="hourglass" class="donor-card-icon"></i>${escapeHtml(countdown.remainingShort)}</span>
                <span class="trial-countdown-date">Ends ${escapeHtml(countdown.expiresOn)}${countdown.expired ? ' (expired)' : ''}</span>
              `;
              metaEl.appendChild(trialBadge);
            }
          }

          if (selectedDonorId && String(donor.id) === String(selectedDonorId)) {
            card.classList.add('selected');
          }

          // Add hover tooltip
          const tooltip = document.createElement('div');
          tooltip.className = 'donor-card-tooltip';

          const tooltipRows = [];
          if (donor.subscriptionId) {
            tooltipRows.push(`
              <div class="donor-card-tooltip-row">
                <span class="donor-card-tooltip-label">Sub ID:</span>
                <span class="donor-card-tooltip-value">${donor.subscriptionId.substring(0, 12)}...</span>
              </div>
            `);
          }
          if (paymentText) {
            tooltipRows.push(`
              <div class="donor-card-tooltip-row">
                <span class="donor-card-tooltip-label">Amount:</span>
                <span class="donor-card-tooltip-value">${paymentText}</span>
              </div>
            `);
          }
          if (donor.hadPreexistingAccess) {
            tooltipRows.push(`
              <div class="donor-card-tooltip-row">
                <span class="donor-card-tooltip-label">Access:</span>
                <span class="donor-card-tooltip-value">ðŸ›¡ï¸ Pre-existing</span>
              </div>
            `);
          } else if (donor.plexShareState) {
            const plexLabel = donor.plexShareState === 'shared' ? '? Shared' :
                             donor.plexShareState === 'pending' ? '? Pending' : '?';
            tooltipRows.push(`
              <div class="donor-card-tooltip-row">
                <span class="donor-card-tooltip-label">Plex:</span>
                <span class="donor-card-tooltip-value">${plexLabel}</span>
              </div>
            `);
          }

          if (status === 'trial' && donor.accessExpiresAt) {
            const countdown = formatTrialCountdown(donor.accessExpiresAt);
            if (countdown) {
              tooltipRows.push(`
                <div class="donor-card-tooltip-row">
                  <span class="donor-card-tooltip-label">Trial ends:</span>
                  <span class="donor-card-tooltip-value">${escapeHtml(countdown.expiresOn)}${countdown.expired ? ' (expired)' : ''}</span>
                </div>
              `);
            }
          }

          tooltip.innerHTML = tooltipRows.join('');
          if (tooltipRows.length > 0) {
            card.appendChild(tooltip);
          }

          card.addEventListener('click', () => selectDonor(donor.id));
          card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectDonor(donor.id);
            }
            // Arrow key navigation
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const cards = Array.from(document.querySelectorAll('.donor-card'));
              const currentIndex = cards.indexOf(card);
              let nextIndex = currentIndex;

              if (e.key === 'ArrowDown' && currentIndex < cards.length - 1) {
                nextIndex = currentIndex + 1;
              } else if (e.key === 'ArrowUp' && currentIndex > 0) {
                nextIndex = currentIndex - 1;
              }

              if (nextIndex !== currentIndex) {
                cards[nextIndex].focus();
              }
            }
          });

          donorsList.appendChild(clone);
        });

        // Initialize Lucide icons after rendering
        if (typeof lucide !== 'undefined') {
          lucide.createIcons();
        }
      }

      function selectDonor(donorId) {
        selectedDonorId = donorId;
        const donors = Array.isArray(state.donors) ? state.donors : [];
        const donor = donors.find(d => String(d.id) === String(donorId));

        if (!donor) {
          selectedDonorId = null;
          renderDonorsList();
          showDonorsEmptyState();
          return;
        }

        // Update selected state in list
        document.querySelectorAll('.donor-card').forEach(card => {
          if (String(card.dataset.donorId) === String(donorId)) {
            card.classList.add('selected');
          } else {
            card.classList.remove('selected');
          }
        });

        renderDonorDetail(donor);

        // Handle mobile view
        if (donorsLayout && window.innerWidth <= 1024) {
          donorsLayout.classList.add('detail-active');
        }
      }

      function renderDonorDetail(donor) {
        if (!donorDetail) return;

        donorDetail.hidden = false;
        if (donorsEmptyState) {
          donorsEmptyState.hidden = true;
        }

        // Header
        if (donorDetailName) {
          donorDetailName.textContent = donor.name || donor.email || 'Unknown';
        }
        const emailHeaderEl = document.getElementById('donor-detail-email-header');
        if (emailHeaderEl) {
          emailHeaderEl.textContent = donor.email || '';
        }
        if (donorDetailStatus) {
          const status = (donor.status || 'pending').toLowerCase();
          donorDetailStatus.dataset.status = status;
          donorDetailStatus.textContent = status.replace(/_/g, ' ');
        }

        // Payment card
        if (donorDetailAmount) {
          donorDetailAmount.textContent = formatAmount(donor);
        }
        if (donorDetailLastPayment) {
          donorDetailLastPayment.textContent = donor.lastPaymentAt
            ? `Last payment: ${formatDateTime(donor.lastPaymentAt)}`
            : 'No recent payments';
        }

        // Plex status card
        const plexStatusEl = document.getElementById('donor-detail-plex-status');
        if (plexStatusEl) {
          const plexParts = [];
          if (donor.hadPreexistingAccess) {
            plexParts.push('<div class="donor-info-card-value" style="color: #3b82f6;"><i data-lucide="shield-check" style="width: 20px; height: 20px; display: inline-block; vertical-align: middle;"></i> Pre-existing Access</div>');
            plexParts.push('<div class="donor-info-card-label">Access will be preserved on cancellation</div>');
          } else if (donor.plexShareState === 'shared') {
            plexParts.push('<div class="donor-info-card-value" style="color: #10b981;"><i data-lucide="check-circle" style="width: 20px; height: 20px; display: inline-block; vertical-align: middle;"></i> Shared</div>');
            plexParts.push('<div class="donor-info-card-label">Access granted</div>');
          } else if (donor.plexShareState === 'pending') {
            plexParts.push('<div class="donor-info-card-value" style="color: #f59e0b;"><i data-lucide="clock" style="width: 20px; height: 20px; display: inline-block; vertical-align: middle;"></i> Pending</div>');
            plexParts.push('<div class="donor-info-card-label">Waiting for acceptance</div>');
          } else if (donor.needsPlexInvite) {
            plexParts.push('<div class="donor-info-card-value" style="color: #ef4444;"><i data-lucide="mail-x" style="width: 20px; height: 20px; display: inline-block; vertical-align: middle;"></i> Not invited</div>');
            plexParts.push('<div class="donor-info-card-label">Send Plex invite</div>');
          } else {
            plexParts.push('<div class="donor-info-card-value">?</div>');
          }
          plexStatusEl.innerHTML = plexParts.join('');
        }

        // Contact card
        if (donorDetailEmail) {
          donorDetailEmail.textContent = donor.email || '?';
        }
        if (donorDetailSubId) {
          donorDetailSubId.textContent = donor.subscriptionId || '?';
        }

        // Payment history visualization
        renderPaymentHistory(donor);

        // Invite details
        if (donorDetailInvite) {
          const invites = Array.isArray(donor.invites) ? donor.invites : [];
          const inviteParts = [];

          if (donor.hadPreexistingAccess) {
            inviteParts.push('<span class="badge badge-note" style="background-color: #3b82f6; color: white;">Pre-existing access - will be preserved</span>');
          } else if (donor.plexShareState === 'shared') {
            inviteParts.push('<span class="badge badge-visited">Plex shared</span>');
          } else if (donor.plexShareState === 'pending') {
            inviteParts.push('<span class="badge badge-note">Plex invite pending</span>');
          } else if (donor.needsPlexInvite) {
            inviteParts.push('<span class="badge badge-revoked">Needs Plex invite</span>');
          }

          if (invites.length > 0) {
            const invite = invites[0];
            if (invite.inviteUrl) {
              inviteParts.push(`<a href="${invite.inviteUrl}">Invite link</a>`);
            }
            if (invite.recipientEmail) {
              inviteParts.push(`<span class="badge badge-note">For ${escapeHtml(invite.recipientEmail)}</span>`);
            }
            if (invite.emailSentAt) {
              const date = new Date(invite.emailSentAt);
              inviteParts.push(`<span class="badge">Emailed ${date.toLocaleDateString()}</span>`);
            }
            if (invite.revokedAt) {
              const date = new Date(invite.revokedAt);
              inviteParts.push(`<span class="badge badge-revoked">Revoked ${date.toLocaleDateString()}</span>`);
            }
          }

          const shareUrl = buildShareUrl(donor.shareLink);
          if (shareUrl) {
            inviteParts.push(`<a href="${shareUrl}">Setup page</a>`);
            if (donor.shareLink.lastUsedAt) {
              const usedDate = new Date(donor.shareLink.lastUsedAt);
              inviteParts.push(`<span class="badge badge-visited">Visited ${usedDate.toLocaleDateString()}</span>`);
            }
          }

          donorDetailInvite.innerHTML = inviteParts.length > 0 ? inviteParts.join('<br />') : '?';
        }

        // Error/status notes
        const refreshError = typeof donor.paypalRefreshError === 'string' ? donor.paypalRefreshError.trim() : '';
        if (refreshError && donorDetailError && donorDetailErrorSection) {
          donorDetailError.textContent = refreshError;
          donorDetailErrorSection.hidden = false;
        } else if (donorDetailErrorSection) {
          donorDetailErrorSection.hidden = true;
        }

        // Actions (moved to top in HTML)
        renderDonorActions(donor);

        // Initialize Lucide icons after rendering
        if (typeof lucide !== 'undefined') {
          lucide.createIcons();
        }
      }

      function renderPaymentHistory(donor) {
        const paymentHistory = document.getElementById('payment-history');
        const paymentHistoryBars = document.getElementById('payment-history-bars');
        const paymentHistorySummary = document.getElementById('payment-history-summary');

        if (!paymentHistory || !paymentHistoryBars) return;

        const payments = Array.isArray(donor.payments) ? donor.payments : [];

        if (payments.length === 0) {
          paymentHistory.hidden = true;
          return;
        }

        paymentHistory.hidden = false;

        // Show last 6 payments
        const recentPayments = payments.slice(0, 6).reverse();
        const maxAmount = Math.max(...recentPayments.map(p => p.amount || 0), 1);

        paymentHistoryBars.innerHTML = '';

        recentPayments.forEach(payment => {
          const date = payment.createdAt ? new Date(payment.createdAt) : null;
          const amount = payment.amount || 0;
          const height = (amount / maxAmount) * 100;

          const barEl = document.createElement('div');
          barEl.className = 'payment-bar';
          barEl.title = `${date ? date.toLocaleDateString() : 'Unknown'}: $${amount.toFixed(2)}`;

          const fillEl = document.createElement('div');
          fillEl.className = 'payment-bar-fill';
          fillEl.style.height = `${height}%`;

          const labelEl = document.createElement('div');
          labelEl.className = 'payment-bar-label';
          labelEl.textContent = date ? date.toLocaleDateString('en-US', { month: 'short' }) : '?';

          const amountEl = document.createElement('div');
          amountEl.className = 'payment-bar-amount';
          amountEl.textContent = `$${amount.toFixed(0)}`;

          barEl.appendChild(fillEl);
          barEl.appendChild(labelEl);
          barEl.appendChild(amountEl);
          paymentHistoryBars.appendChild(barEl);
        });

        if (paymentHistorySummary) {
          const totalPayments = payments.length;
          const totalAmount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
          paymentHistorySummary.textContent = `${totalPayments} payment${totalPayments !== 1 ? 's' : ''} ? $${totalAmount.toFixed(2)} total`;
        }
      }

      function isRevokedStatus(status) {
        return ['trial_expired', 'cancelled', 'expired', 'suspended'].includes(status);
      }

      function renderDonorActions(donor) {
        if (!donorDetailActions) return;

        donorDetailActions.innerHTML = '';
        const plexState = state.plex;
        const status = (donor.status || 'pending').toLowerCase();
        const invites = Array.isArray(donor.invites) ? donor.invites : [];
        const activeInvite = invites.find(invite => !invite.revokedAt);
        const shareUrl = buildShareUrl(donor.shareLink);

        // Send Plex invite button
        // Enabled whenever Plex is configured, donor has an email, no active
        // shared access exists, and the subscriber has an active subscription
        // or active trial. A pending invite is informational only ? admin can
        // still click to get status feedback.
        const plexConfigured = Boolean(plexState && plexState.configured !== false);
        const statusAllowsInvite = status === 'active' || status === 'trial';
        const canInvite = plexConfigured && Boolean(donor.email) && !donor.plexShared && statusAllowsInvite;
        const inviteBtn = document.createElement('button');
        inviteBtn.className = 'secondary';
        inviteBtn.textContent = 'Send Plex invite';
        inviteBtn.disabled = !canInvite;
        inviteBtn.dataset.action = 'invite';
        inviteBtn.dataset.donorId = donor.id;
        if (!plexConfigured) {
          inviteBtn.title = 'Configure Plex settings to send invites.';
        } else if (!donor.email) {
          inviteBtn.title = 'Add an email address to send a Plex invite.';
        } else if (donor.plexShared) {
          inviteBtn.title = 'User already has Plex access.';
        } else if (!statusAllowsInvite) {
          inviteBtn.title = 'User must have an active subscription or trial to receive a Plex invite.';
        } else if (donor.plexPending) {
          inviteBtn.title = 'A Plex invite is already pending ? click to check status or resend.';
        } else {
          inviteBtn.title = 'Send a Plex invite to this subscriber.';
        }
        donorDetailActions.appendChild(inviteBtn);

        // Copy setup link
        const shareBtn = document.createElement('button');
        shareBtn.className = 'secondary';
        shareBtn.textContent = 'Copy setup link';
        shareBtn.disabled = !shareUrl;
        shareBtn.dataset.action = 'share';
        shareBtn.dataset.donorId = donor.id;
        shareBtn.title = shareUrl ? 'Copy the existing setup link' : 'Create a setup link first';
        donorDetailActions.appendChild(shareBtn);

        // Verify payment
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'secondary';
        refreshBtn.textContent = 'Refresh PayPal status';
        refreshBtn.dataset.action = 'refresh';
        refreshBtn.dataset.donorId = donor.id;
        refreshBtn.title = 'Refresh this subscriber from PayPal';
        donorDetailActions.appendChild(refreshBtn);

        // Generate new invite link
        const shareGenBtn = document.createElement('button');
        shareGenBtn.className = 'secondary';
        shareGenBtn.textContent = 'Create new setup link';
        shareGenBtn.dataset.action = 'share-generate';
        shareGenBtn.dataset.donorId = donor.id;
        shareGenBtn.title = 'Create a new setup link for account setup or recovery';
        donorDetailActions.appendChild(shareGenBtn);

        // Resend email
        const canResend = Boolean(activeInvite && activeInvite.inviteUrl);
        const resendBtn = document.createElement('button');
        resendBtn.className = 'secondary';
        resendBtn.textContent = 'Resend email';
        resendBtn.disabled = !canResend;
        resendBtn.dataset.action = 'resend';
        resendBtn.dataset.donorId = donor.id;
        resendBtn.title = canResend ? 'Resend the most recent invite email' : 'No active invite available to resend';
        donorDetailActions.appendChild(resendBtn);

        // Revoke Plex invite
        const canRevoke = Boolean(activeInvite);
        const revokeBtn = document.createElement('button');
        revokeBtn.className = 'danger secondary';
        revokeBtn.textContent = 'Revoke Plex invite';
        revokeBtn.disabled = !canRevoke;
        revokeBtn.dataset.action = 'revoke';
        revokeBtn.dataset.donorId = donor.id;
        revokeBtn.title = canRevoke ? 'Revoke the most recent active invite' : 'No active invite available to revoke';
        donorDetailActions.appendChild(revokeBtn);

        const canRevokePlex = Boolean(
          plexState &&
            plexState.configured !== false &&
            (donor.plexShared || donor.plexPending) &&
            !isRevokedStatus(status)
        );
        const revokePlexBtn = document.createElement('button');
        revokePlexBtn.className = 'danger secondary';
        revokePlexBtn.textContent = 'Revoke Plex access';
        revokePlexBtn.disabled = !canRevokePlex;
        revokePlexBtn.dataset.action = 'revoke-plex';
        revokePlexBtn.dataset.donorId = donor.id;
        revokePlexBtn.title = canRevokePlex
          ? 'Revoke Plex access for this subscriber'
          : isRevokedStatus(status)
          ? 'Plex access is already revoked or expired for this subscriber'
          : 'Revoke is available only for subscribers with Plex access or a pending share';
        donorDetailActions.appendChild(revokePlexBtn);

        // Remove subscriber
        const removeBtn = document.createElement('button');
        removeBtn.className = 'danger secondary';
        removeBtn.textContent = 'Remove subscriber';
        removeBtn.dataset.action = 'remove';
        removeBtn.dataset.donorId = donor.id;
        removeBtn.title = 'Remove this subscriber and all related records';
        donorDetailActions.appendChild(removeBtn);
      }

      function showDonorsEmptyState() {
        if (donorDetail) {
          donorDetail.hidden = true;
        }
        if (donorsEmptyState) {
          donorsEmptyState.hidden = false;
        }
        if (donorsLayout) {
          donorsLayout.classList.remove('detail-active');
        }
      }

      function renderSubscribers() {
        closeSubscriberActionMenu();

        // Use new master-detail layout if elements exist
        if (donorsList) {
          if (plexStatusNote) {
            plexStatusNote.textContent = '';
            plexStatusNote.hidden = true;
            delete plexStatusNote.dataset.state;
            const plexState = state.plex;
            if (plexState) {
              if (!plexState.configured) {
                plexStatusNote.textContent = 'Configure Plex settings to send invites from this dashboard.';
                plexStatusNote.hidden = false;
              } else if (plexState.error) {
                plexStatusNote.textContent = `Unable to refresh Plex members: ${plexState.error}`;
                plexStatusNote.dataset.state = 'error';
                plexStatusNote.hidden = false;
              }
            }
          }

          renderAdminMetrics();
          updateFilterCounts();
          renderDonorsList();

          // Re-render selected donor if exists
          if (selectedDonorId) {
            const donors = Array.isArray(state.donors) ? state.donors : [];
            const donor = donors.find(d => String(d.id) === String(selectedDonorId));
            if (donor) {
              renderDonorDetail(donor);
            } else {
              showDonorsEmptyState();
              selectedDonorId = null;
            }
          } else {
            showDonorsEmptyState();
          }
          return;
        }

        // Fallback to old table rendering if master-detail elements don't exist
        if (!subscribersTable) {
          return;
        }
        if (plexStatusNote) {
          plexStatusNote.textContent = '';
          plexStatusNote.hidden = true;
          delete plexStatusNote.dataset.state;
          const plexState = state.plex;
          if (plexState) {
            if (!plexState.configured) {
              plexStatusNote.textContent =
                'Configure Plex settings to send invites from this dashboard.';
              plexStatusNote.hidden = false;
            } else if (plexState.error) {
              plexStatusNote.textContent = `Unable to refresh Plex members: ${plexState.error}`;
              plexStatusNote.dataset.state = 'error';
              plexStatusNote.hidden = false;
            }
          }
        }

        const donors = Array.isArray(state.donors) ? state.donors : [];
        subscribersTable.innerHTML = '';
        if (donors.length === 0) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 5;
          cell.textContent = 'No subscribers yet.';
          cell.style.color = 'var(--text-muted-soft)';
          row.appendChild(cell);
          subscribersTable.appendChild(row);
          return;
        }

        const template = document.getElementById('subscriber-row');
        const plexState = state.plex;
        donors.forEach((donor) => {
          const clone = template.content.cloneNode(true);
          const row = clone.querySelector('tr');
          row.dataset.id = donor.id;
          const subscriberCell = clone.querySelector('.col-subscriber');
          const statusPill = clone.querySelector('.status-pill');
          const statusNote = clone.querySelector('.status-note');
          const lastPaymentCell = clone.querySelector('.col-last-payment');
          const inviteCell = clone.querySelector('.col-invite');
          const actionMenu = clone.querySelector('.action-menu');
          const actionMenuToggle = clone.querySelector('[data-menu-toggle]');
          const actionMenuPanel = clone.querySelector('.action-menu-panel');

          if (actionMenu) {
            actionMenu.classList.remove('open');
          }

          if (actionMenuToggle && actionMenuPanel) {
            const baseId = row.dataset.id
              ? `donor-${row.dataset.id}`
              : donor.subscriptionId
              ? `subscription-${donor.subscriptionId}`
              : `donor-${Math.random().toString(36).slice(2)}`;
            const sanitizedId = String(baseId).replace(/[^a-zA-Z0-9_-]/g, '-');
            const toggleId = `subscriber-actions-toggle-${sanitizedId}`;
            const panelId = `subscriber-actions-panel-${sanitizedId}`;
            actionMenuToggle.id = toggleId;
            actionMenuToggle.setAttribute('aria-controls', panelId);
            actionMenuToggle.setAttribute('aria-haspopup', 'menu');
            actionMenuToggle.setAttribute('aria-expanded', 'false');
            actionMenuPanel.id = panelId;
            actionMenuPanel.setAttribute('aria-labelledby', toggleId);
            actionMenuPanel.setAttribute('aria-hidden', 'true');
            actionMenuPanel.hidden = true;
          }

          subscriberCell.innerHTML = `<strong>${donor.name || donor.email || 'Unknown'}</strong><br /><span style="color:var(--text-muted-soft);font-size:0.85rem;">${donor.email || '?'}<br/>Sub ID: ${donor.subscriptionId}</span>`;

          const status = (donor.status || 'pending').toLowerCase();
          statusPill.dataset.status = status;
          statusPill.textContent = status.replace(/_/g, ' ');

          if (statusNote) {
            const refreshError =
              typeof donor.paypalRefreshError === 'string'
                ? donor.paypalRefreshError.trim()
                : '';
            if (refreshError) {
              statusNote.textContent = refreshError;
              statusNote.hidden = false;
            } else {
              statusNote.textContent = '';
              statusNote.hidden = true;
            }
          }

          const paymentText = formatAmount(donor);
          if (donor.lastPaymentAt) {
            const dateText = formatDateTime(donor.lastPaymentAt);
            if (paymentText) {
              lastPaymentCell.textContent = '';
              lastPaymentCell.append(document.createTextNode(dateText));
              lastPaymentCell.append(document.createElement('br'));
              const badge = document.createElement('span');
              badge.className = 'badge';
              badge.textContent = paymentText;
              lastPaymentCell.append(badge);
            } else {
              lastPaymentCell.textContent = dateText;
            }
          } else if (paymentText) {
            lastPaymentCell.innerHTML = `<span class="badge">${paymentText}</span>`;
          } else {
            lastPaymentCell.textContent = '?';
          }

          const invites = Array.isArray(donor.invites) ? donor.invites : [];
          const inviteParts = [];
          if (donor.plexShareState === 'shared') {
            inviteParts.push(
              '<span class="badge badge-visited" title="This subscriber already has Plex access.">Plex shared</span>'
            );
          } else if (donor.plexShareState === 'pending') {
            inviteParts.push(
              '<span class="badge badge-note" title="A Plex invite is pending acceptance.">Plex invite pending</span>'
            );
          } else if (donor.needsPlexInvite) {
            inviteParts.push(
              '<span class="badge badge-revoked" title="Send a Plex invite to grant access.">Needs Plex invite</span>'
            );
          }
          if (invites.length > 0) {
            const invite = invites[0];
            if (invite.inviteUrl) {
              inviteParts.push(`<a href="${invite.inviteUrl}">Invite link</a>`);
            }
            if (invite.recipientEmail) {
              inviteParts.push(
                `<span class="badge badge-note">For ${escapeHtml(
                  invite.recipientEmail
                )}</span>`
              );
            }
            if (invite.emailSentAt) {
              const date = new Date(invite.emailSentAt);
              inviteParts.push(`<span class="badge">Emailed ${date.toLocaleDateString()}</span>`);
            }
            if (invite.revokedAt) {
              const date = new Date(invite.revokedAt);
              inviteParts.push(`<span class="badge badge-revoked">Revoked ${date.toLocaleDateString()}</span>`);
            }
          }

          const shareUrl = buildShareUrl(donor.shareLink);
          if (shareUrl) {
            inviteParts.push(
              `<a href="${shareUrl}">Setup page</a>`
            );
            if (donor.shareLink.lastUsedAt) {
              const usedDate = new Date(donor.shareLink.lastUsedAt);
              inviteParts.push(
                `<span class="badge badge-visited">Visited ${usedDate.toLocaleDateString()}</span>`
              );
            }
          }

          const activeInvite = invites.find((invite) => !invite.revokedAt);
          const inviteButton = clone.querySelector('button[data-action="invite"]');
          const shareButton = clone.querySelector('button[data-action="share"]');
          const shareGenerateButton = clone.querySelector(
            'button[data-action="share-generate"]'
          );
          const resendButton = clone.querySelector('button[data-action="resend"]');
          const revokeButton = clone.querySelector('button[data-action="revoke"]');
          const revokePlexButton = clone.querySelector(
            'button[data-action="revoke-plex"]'
          );
          const removeButton = clone.querySelector('button[data-action="remove"]');

          const hasShareUrl = Boolean(shareUrl);

          if (inviteButton) {
            const canInvite = Boolean(donor.needsPlexInvite);
            inviteButton.disabled = !canInvite;
            let inviteTitle = '';
            if (!plexState || plexState.configured === false) {
              inviteTitle = 'Configure Plex settings to send invites.';
            } else if (!donor.email) {
              inviteTitle = 'Add an email address to send a Plex invite.';
            } else if (donor.plexShared) {
              inviteTitle = 'User already has Plex access.';
            } else if (donor.plexPending) {
              inviteTitle = 'A Plex invite has already been sent and is pending acceptance.';
            } else if (status === 'pending') {
              inviteTitle =
                'Pending subscribers must activate their subscription before a Plex invite can be sent.';
            } else if (canInvite) {
              inviteTitle = 'Send a Plex invite to this subscriber.';
            } else {
              inviteTitle = 'Plex invite is not available for this subscriber right now.';
            }
            inviteButton.title = inviteTitle;
          }

          if (shareButton) {
            shareButton.disabled = !hasShareUrl;
            shareButton.title = hasShareUrl
              ? 'Copy the existing setup link'
              : 'Create a setup link first';
          }

          if (shareGenerateButton) {
            shareGenerateButton.title = 'Create a new setup link for account setup or recovery';
          }

          if (resendButton) {
            const canResend = Boolean(activeInvite && activeInvite.inviteUrl);
            resendButton.disabled = !canResend;
            resendButton.title = canResend
              ? 'Resend the most recent invite email'
              : 'No active invite available to resend';
          }

          if (revokeButton) {
            const canRevoke = Boolean(activeInvite);
            revokeButton.disabled = !canRevoke;
            revokeButton.title = canRevoke
              ? 'Revoke the most recent active invite'
              : 'No active invite available to revoke';
          }

          if (revokePlexButton) {
            const canRevokePlex = Boolean(
              plexState &&
                plexState.configured !== false &&
                (donor.plexShared || donor.plexPending) &&
                !isRevokedStatus(status)
            );
            revokePlexButton.disabled = !canRevokePlex;
            revokePlexButton.title = canRevokePlex
              ? 'Revoke Plex access for this subscriber'
              : isRevokedStatus(status)
              ? 'Plex access is already revoked or expired for this subscriber'
              : 'Revoke is available only for subscribers with Plex access or a pending share';
          }

          if (removeButton) {
            removeButton.title = 'Remove this subscriber and all related records';
          }

          if (inviteParts.length > 0) {
            inviteCell.innerHTML = inviteParts.join('<br />');
          } else {
            inviteCell.textContent = '?';
          }

          subscribersTable.appendChild(clone);
        });
      }

      function formatAmount(donor) {
        const payment = donor.payments && donor.payments[0];
        if (payment && payment.amount) {
          return `${payment.amount} ${payment.currency || ''}`.trim();
        }
        if (donor.lastPaymentAt) {
          return '';
        }
        return 'No payment recorded';
      }

      function renderEvents() {
        eventsList.innerHTML = '';
        const eventsToShow = Array.isArray(state.events)
          ? state.events.slice(0, 8)
          : [];
        if (eventsToShow.length === 0) {
          const li = document.createElement('li');
          li.style.border = 'none';
          li.innerHTML = `<div class="empty-state">
            <div class="empty-state-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg></div>
            <span class="empty-state-title">No activity yet</span>
            <span class="empty-state-description">Webhook events and admin actions will appear here as they happen.</span>
          </div>`;
          eventsList.appendChild(li);
          return;
        }
        eventsToShow.forEach((event) => {
          const li = document.createElement('li');
          const payload = (() => {
            try {
              return JSON.stringify(JSON.parse(event.payload), null, 2);
            } catch (e) {
              return event.payload;
            }
          })();
          const timestamp = escapeHtml(formatDateTime(event.createdAt));
          const eventType = event && event.eventType ? escapeHtml(event.eventType) : 'Unknown event';
          const safePayload = escapeHtml(payload || '');
          li.innerHTML = `<time>${timestamp}</time><strong>${eventType}</strong><pre class="event-payload">${safePayload}</pre>`;
          eventsList.appendChild(li);
        });
    }

    async function refreshShareLinks() {
      if (!state.authenticated) {
        state.shareLinks = [];
        return;
      }
      try {
        const response = await api('/api/admin/share-links');
        state.shareLinks = response.shareLinks || [];
      } catch (err) {
        console.error(err);
        state.shareLinks = [];
      }
    }

      function renderAdminAccountPanel() {
        if (!adminAccountPanel) {
          return;
        }
      if (!state.authenticated) {
        adminAccountPanel.classList.add('hidden');
        if (adminCredentialsForm) {
          adminCredentialsForm.reset();
        }
        if (adminAccountDescription) {
          adminAccountDescription.textContent =
            'Update the username and password used to access this dashboard. Password changes require at least 12 characters.';
        }
        if (adminTwoFactorDescription) {
          adminTwoFactorDescription.textContent =
            'Add a QR-based authenticator app check for admin sign-in.';
        }
        resetPendingTwoFactorSetup();
        return;
      }

      adminAccountPanel.classList.remove('hidden');

      if (adminAccountDescription) {
        adminAccountDescription.textContent =
          'Update the username and password used to access this dashboard. Password changes require at least 12 characters.';
      }

      const twoFactorEnabled = Boolean(
        state.adminTwoFactor && state.adminTwoFactor.enabled
      );
      if (adminTwoFactorDescription) {
        adminTwoFactorDescription.textContent = twoFactorEnabled
          ? 'Authenticator app 2FA is enabled for admin sign-in.'
          : 'Authenticator app 2FA is currently off. Scan a QR code to enable it.';
      }
      if (adminTwoFactorStartButton) {
        adminTwoFactorStartButton.textContent = twoFactorEnabled
          ? 'Generate new QR code'
          : 'Set up 2FA';
      }
      if (adminTwoFactorDisableButton) {
        adminTwoFactorDisableButton.disabled = !twoFactorEnabled;
      }
      if (adminTwoFactorForm && !state.pendingTwoFactorSetup) {
        setFormStatus(adminTwoFactorForm, '');
      }

      if (adminCredentialsForm) {
        const usernameInput = adminCredentialsForm.querySelector("input[name='username']");
        if (usernameInput && document.activeElement !== usernameInput) {
          usernameInput.value = state.adminUsername || '';
        }

        adminCredentialsForm.querySelectorAll('input').forEach((input) => {
          input.disabled = false;
        });
      }

      if (adminTwoFactorSetupPanel && state.pendingTwoFactorSetup) {
        adminTwoFactorSetupPanel.classList.remove('hidden');
      } else if (adminTwoFactorSetupPanel) {
        adminTwoFactorSetupPanel.classList.add('hidden');
      }
      if (adminTwoFactorQr && state.pendingTwoFactorSetup && state.pendingTwoFactorSetup.qrCodeDataUrl) {
        adminTwoFactorQr.src = state.pendingTwoFactorSetup.qrCodeDataUrl;
      }
      if (adminTwoFactorManualKey) {
        adminTwoFactorManualKey.value =
          state.pendingTwoFactorSetup && state.pendingTwoFactorSetup.manualEntryKey
            ? state.pendingTwoFactorSetup.manualEntryKey
            : '';
      }
      if (adminTwoFactorVerifyButton) {
        adminTwoFactorVerifyButton.disabled = !state.pendingTwoFactorSetup;
      }
    }

    function renderAdminTwoFactorOnboardingBanner() {
      if (!adminTwoFactorOnboardingBanner) {
        return;
      }
      const shouldShow = Boolean(
        state.authenticated &&
        state.adminOnboarding &&
        state.adminOnboarding.twoFactorPromptPending &&
        !(state.adminTwoFactor && state.adminTwoFactor.enabled)
      );
      adminTwoFactorOnboardingBanner.classList.toggle('hidden', !shouldShow);
      adminTwoFactorOnboardingBanner.hidden = !shouldShow;
    }

    async function loadAdminAccount() {
      if (!state.authenticated) {
        return;
      }
      try {
        const response = await api('/api/admin/account');
        if (response && response.username) {
          state.adminUsername = response.username;
        }
        applyTwoFactorState(response && response.twoFactor ? response.twoFactor : null);
        applyAdminOnboardingState(response && response.onboarding ? response.onboarding : null);
      } catch (err) {
        console.error('Failed to load admin account details', err);
      }
    }

    async function loadDashboardData() {
      if (dashboardDataPromise) {
        return dashboardDataPromise;
      }

      dashboardDataPromise = (async () => {
        try {
          if (!state.authenticated) {
            return;
          }
          try {
            const query = state.support.includeResolved ? '?includeResolved=1' : '';
            const response = await api(`/api/admin/dashboard${query}`);
            if (response.adminUsername) {
              state.adminUsername = response.adminUsername;
            }
            applyTwoFactorState(response && response.twoFactor ? response.twoFactor : null);
            applyAdminOnboardingState(response && response.onboarding ? response.onboarding : null);
            const previousErrors = new Map(
              (Array.isArray(state.donors) ? state.donors : []).map((existing) => [
                String(existing.id),
                typeof existing.paypalRefreshError === 'string'
                  ? existing.paypalRefreshError
                  : '',
              ])
            );
            const donorsFromApi = Array.isArray(response.donors)
              ? response.donors.map((donor) => {
                  const normalizedError =
                    typeof donor.paypalRefreshError === 'string'
                      ? donor.paypalRefreshError
                      : '';
                  const normalizedStatus = (donor.status || '').toLowerCase();
                  const fallbackError = previousErrors.get(String(donor.id)) || '';
                  const effectiveError = normalizedError
                    ? normalizedError
                    : normalizedStatus === 'active'
                    ? ''
                    : fallbackError;
                  return {
                    ...donor,
                    paypalRefreshError: effectiveError,
                  };
                })
              : [];
            state.donors = donorsFromApi;
            state.plex = response.plex || null;
            state.events = response.events || [];
            applySettingsPayload(response.settings || {});
            applyPaypalPlanPayload(response.paypalPlan || null);
            state.shareLinks = response.shareLinks || [];
            const support = response.support || {};
            const threads = Array.isArray(support.threads) ? support.threads : [];
            state.support.threads = threads;
            if (
              !threads.some(
                (thread) =>
                  thread.request && thread.request.id === state.support.activeThreadId
              )
            ) {
              state.support.activeThreadId =
                threads.length > 0 ? threads[0].request.id : null;
            }
            state.support.error = '';
            state.support.loaded = true;
          } catch (err) {
            console.error('Failed to load dashboard data', err);
            if (err && err.status === 429) {
              showDashboardToast(
                err.message || 'Too many requests. Please wait before trying again.',
                'error',
                6000
              );
              return;
            }
            state.donors = [];
            state.plex = null;
            state.events = [];
            state.shareLinks = [];
            state.settings = null;
            clearSettingsFormDirtyFlags();
            state.paypalPlan = null;
            state.paypalProduct = null;
            state.paypalPlanError = '';
            state.paypalPlanManageUrl = '';
            state.paypalPlanLoading = false;
            state.support = {
              threads: [],
              activeThreadId: null,
              includeResolved: state.support.includeResolved,
              error: '',
              loaded: false,
            };
          }
        } finally {
          try {
            render();
          } finally {
            dashboardDataPromise = null;
          }
        }
      })();

      return dashboardDataPromise;
    }

    async function handleManualRefresh() {
      if (refreshButton) {
        refreshButton.disabled = true;
      }
      try {
        let syncResponse = null;
        let plexSyncFailed = false;

        // Sync Plex status first when available, but always do a full dashboard reload after.
        if (state.plex && state.plex.configured) {
          try {
            syncResponse = await api('/api/admin/plex/sync-status-now', {
              method: 'POST',
            });
          } catch (plexErr) {
            console.warn('Failed to sync Plex status during refresh:', plexErr);
            plexSyncFailed = true;
          }
        }

        await loadDashboardData();

        const detailLines = ['Subscriber list refreshed with the latest dashboard data.'];

        if (syncResponse) {
          if (typeof syncResponse.message === 'string' && syncResponse.message.trim()) {
            detailLines.push(syncResponse.message.trim());
          }
          if (Number.isFinite(syncResponse.accessEligibleDonorsChecked)) {
            detailLines.push(
              `${syncResponse.accessEligibleDonorsChecked} active/trial linked donor(s) checked against current Plex shares.`
            );
          }
          if (
            Number.isFinite(syncResponse.ignoredLinkedCount) &&
            syncResponse.ignoredLinkedCount > 0
          ) {
            detailLines.push(
              `${syncResponse.ignoredLinkedCount} inactive donor(s) still have Plex identity data on file and were not counted as current access issues.`
            );
          }
          if (
            Array.isArray(syncResponse.mismatchedDonors) &&
            syncResponse.mismatchedDonors.length > 0
          ) {
            const donorLabels = syncResponse.mismatchedDonors
              .slice(0, 5)
              .map((donor) => donor.name || donor.email || `Donor #${donor.id}`);
            detailLines.push(`Needs attention: ${donorLabels.join(', ')}.`);
          }
        } else if (plexSyncFailed) {
          detailLines.push('Plex sync did not complete, but the dashboard data was still reloaded.');
        }

        await showNoticeModal('Subscriber List Refreshed', 'The donor list has been updated.', {
          stateAttr:
            syncResponse && syncResponse.mismatchCount > 0
              ? 'error'
              : plexSyncFailed
              ? 'info'
              : 'success',
          details: detailLines,
          closeLabel: 'Close',
        });
      } catch (err) {
        console.error(err);
      } finally {
        if (refreshButton) {
          refreshButton.disabled = false;
        }
      }
    }

    async function checkSession() {
      try {
        const data = await api('/api/admin/session');
        csrfToken = data.csrfToken;
        state.authenticated = data.authenticated;
        state.twoFactorPending = Boolean(data && data.twoFactorPending);
        const timezoneValue =
          data && typeof data.timezone === 'string' ? data.timezone.trim() : '';
        state.timezone = timezoneValue ? timezoneValue : null;
        applyTwoFactorState(data && data.twoFactor ? data.twoFactor : null);
        applyAdminOnboardingState(data && data.onboarding ? data.onboarding : null);
        if (data.adminUsername) {
          state.adminUsername = data.adminUsername;
        } else if (!state.authenticated && !state.adminUsername) {
          state.adminUsername = 'admin';
        }
        if (state.authenticated) {
          render();
          await loadDashboardData();
          startDashboardAutoRefresh();
        } else {
          stopDashboardAutoRefresh();
          resetPendingTwoFactorSetup();
          state.settings = null;
          clearSettingsFormDirtyFlags();
          state.paypalPlan = null;
          state.paypalProduct = null;
          state.paypalPlanError = '';
          state.paypalPlanManageUrl = '';
          state.paypalPlanLoading = false;
          state.prospectShare = null;
          state.support = {
            threads: [],
            activeThreadId: null,
            includeResolved: false,
            error: '',
            loaded: false,
          };
          if (supportError) {
            supportError.textContent = '';
            supportError.hidden = true;
            delete supportError.dataset.state;
          }
          setSupportReplyStatusMessage('');
          renderSupportPanel();
        }
      } catch (err) {
        console.error(err);
        state.authenticated = false;
        state.twoFactorPending = false;
        setLoginStatus('Unable to verify your session. Please sign in again.', 'error');
      } finally {
        initialSessionValidationPending = false;
        render();
      }
    }

      function renderShareLinks() {
        if (!shareLinksPanel || !shareLinksTable) {
          return;
        }

        const links = Array.isArray(state.shareLinks) ? state.shareLinks : [];

        if (!state.authenticated) {
          shareLinksPanel.classList.add('hidden');
          shareLinksTable.innerHTML = '';
          return;
        }

        shareLinksPanel.classList.remove('hidden');
        shareLinksTable.innerHTML = '';

        if (links.length === 0) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 5;
          cell.textContent = 'No setup links yet.';
          cell.style.color = 'var(--text-muted-soft)';
          row.appendChild(cell);
          shareLinksTable.appendChild(row);
          return;
        }

        const template = document.getElementById('share-link-row');
        if (!template) {
          return;
        }

        links.forEach((link) => {
          const clone = template.content.cloneNode(true);
          const row = clone.querySelector('tr');
          row.dataset.id = link.id;
          const linkCell = clone.querySelector('.col-link');
          const ownerCell = clone.querySelector('.col-owner');
          const createdCell = clone.querySelector('.col-created');
          const lastUsedCell = clone.querySelector('.col-last-used');

          const shareUrl = buildShareUrl(link);
          linkCell.innerHTML = '';
          if (shareUrl) {
            const openLink = document.createElement('a');
            openLink.className = 'secondary link-open-button';
            openLink.href = shareUrl;
            openLink.target = '_blank';
            openLink.rel = 'noopener';
            openLink.textContent = 'Open setup page';
            openLink.title = shareUrl;
            linkCell.appendChild(openLink);
          } else {
            linkCell.textContent = 'Pending setup link configuration';
          }

          const ownerName = (() => {
            if (link.donor) {
              return link.donor.name || link.donor.email || 'User';
            }
            if (link.prospect) {
              return link.prospect.name || link.prospect.email || 'Prospect';
            }
            return 'Unknown';
          })();

          const ownerMeta = [];
          const typeLabel = link.donor
            ? 'User'
            : link.prospect
            ? 'Prospect'
            : 'Unassigned';
          ownerMeta.push(escapeHtml(typeLabel));
          if (link.donor && link.donor.email) {
            ownerMeta.push(escapeHtml(link.donor.email));
          } else if (link.prospect && link.prospect.email) {
            ownerMeta.push(escapeHtml(link.prospect.email));
          }
          if (link.donor && link.donor.subscriptionId) {
            ownerMeta.push(
              escapeHtml(`Sub ID: ${link.donor.subscriptionId}`)
            );
          }
          if (link.donor && link.donor.status) {
            ownerMeta.push(
              escapeHtml(
                `Status: ${link.donor.status.replace(/_/g, ' ')}`
              )
            );
          }

          ownerCell.innerHTML = `<strong>${escapeHtml(
            ownerName
          )}</strong><br /><span class="subtle-text">${ownerMeta.join(
            ' ? '
          )}</span>`;

          createdCell.textContent = formatDateTime(link.createdAt);
          lastUsedCell.textContent = link.lastUsedAt
            ? formatDateTime(link.lastUsedAt)
            : '?';

          shareLinksTable.appendChild(clone);
        });
      }

      if (togglePasswordVisibilityButton && loginPasswordInput) {
        togglePasswordVisibilityButton.addEventListener('click', () => {
          const shouldReveal = loginPasswordInput.type === 'password';
          loginPasswordInput.type = shouldReveal ? 'text' : 'password';
          togglePasswordVisibilityButton.textContent = shouldReveal ? 'Hide' : 'Show';
          togglePasswordVisibilityButton.setAttribute('aria-pressed', shouldReveal ? 'true' : 'false');
        });
      }

      if (loginForm) {
        const loginQueryParams = new URLSearchParams(window.location.search);
        const urlUsername = loginQueryParams.get('username');
        const urlPassword = loginQueryParams.get('password');
        if ((urlUsername || urlPassword) && loginUsernameInput && loginPasswordInput) {
          if (urlUsername) {
            loginUsernameInput.value = urlUsername;
          }
          if (urlPassword) {
            loginPasswordInput.value = urlPassword;
          }
          setLoginStatus('Credentials detected in URL; click Sign in to continue.');
        } else if (urlUsername || urlPassword) {
          setLoginStatus('Login credentials must be entered in the form.', 'error');
        }

        if (adminSetupForm) {
          adminSetupForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const username = adminSetupUsernameInput ? adminSetupUsernameInput.value.trim() : '';
            const password = adminSetupPasswordInput ? adminSetupPasswordInput.value : '';
            const confirmPassword = adminSetupConfirmPasswordInput
              ? adminSetupConfirmPasswordInput.value
              : '';

            if (!password) {
              setLoginStatus('Password is required.', 'error');
              return;
            }
            if (password !== confirmPassword) {
              setLoginStatus('Password and confirmation must match.', 'error');
              return;
            }
            if (password.trim().length < 12) {
              setLoginStatus('Password must be at least 12 characters long.', 'error');
              return;
            }

            setLoginStatus('Creating admin account...');
            if (adminSetupSubmitButton) {
              adminSetupSubmitButton.disabled = true;
            }

            try {
              await ensureCsrfToken();
              const response = await api('/api/admin/setup', {
                method: 'POST',
                body: { username, password, confirmPassword },
              });
              csrfToken = response.csrfToken;
              state.authenticated = true;
              state.twoFactorPending = false;
              state.adminUsername = response.adminUsername || username || 'admin';
              applyTwoFactorState(response && response.twoFactor ? response.twoFactor : null);
              applyAdminOnboardingState(response && response.onboarding ? response.onboarding : null);
              const setupTimezone =
                response && typeof response.timezone === 'string'
                  ? response.timezone.trim()
                  : '';
              if (setupTimezone) {
                state.timezone = setupTimezone;
              }
              isSessionExpiring = false;
              loginRateLimitedUntil = null;
              await enterAdminWorkspace();
              setLoginStatus('');
            } catch (err) {
              setLoginStatus(
                err && err.message ? err.message : 'Failed to complete admin setup.',
                'error'
              );
            } finally {
              if (adminSetupSubmitButton) {
                adminSetupSubmitButton.disabled = false;
              }
            }
          });
        }

        loginForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          if (!loginUsernameInput || !loginPasswordInput) {
            return;
          }

          // Reset session expiring flag to allow login attempt
          isSessionExpiring = false;

          // Check if we're still in rate limit cooldown
          if (loginRateLimitedUntil && Date.now() < loginRateLimitedUntil) {
            const remainingMinutes = Math.ceil((loginRateLimitedUntil - Date.now()) / 60000);
            setLoginStatus(
              `Too many login attempts. Please wait ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''} before trying again.`,
              'error'
            );
            return;
          }

          const username = loginUsernameInput.value.trim();
          const password = loginPasswordInput.value;
          if (!username) {
            setLoginStatus('Username is required', 'error');
            return;
          }
          if (!password) {
            setLoginStatus('Password is required', 'error');
            return;
          }
          setLoginStatus('Signing in?');
          if (loginSubmitButton) {
            loginSubmitButton.disabled = true;
          }
          try {
            await ensureCsrfToken();
            const response = await api('/api/admin/login', {
              method: 'POST',
              body: { username, password },
            });
            csrfToken = response.csrfToken;
            state.adminUsername = response.adminUsername || username;
            applyTwoFactorState(response && response.twoFactor ? response.twoFactor : null);
            applyAdminOnboardingState(response && response.onboarding ? response.onboarding : null);
            const loginTimezone =
              response && typeof response.timezone === 'string'
                ? response.timezone.trim()
                : '';
            if (loginTimezone) {
              state.timezone = loginTimezone;
            }
            loginPasswordInput.value = '';
            if (response && response.requiresTwoFactor) {
              state.authenticated = false;
              state.twoFactorPending = true;
              showLoginTotpForm();
              setLoginStatus('Enter the code from your authenticator app.');
            } else {
              state.authenticated = true;
              state.twoFactorPending = false;
              isSessionExpiring = false;
              loginRateLimitedUntil = null;
              await enterAdminWorkspace();
              setLoginStatus('');
            }
          } catch (err) {
            const errorMessage = err.message || 'Sign in failed';
            setLoginStatus(errorMessage, 'error');

            // If this is a rate limit error, set cooldown for 15 minutes
            if (errorMessage.toLowerCase().includes('too many')) {
              loginRateLimitedUntil = Date.now() + (15 * 60 * 1000); // 15 minutes
            }
          } finally {
            if (loginSubmitButton) {
              loginSubmitButton.disabled = false;
            }
          }
        });
      }

      if (supportIncludeResolved) {
        supportIncludeResolved.addEventListener('change', async () => {
          state.support.includeResolved = Boolean(supportIncludeResolved.checked);
          const success = await loadSupportRequests({ silent: true });
          if (success) {
            setSupportError('');
          } else {
            setSupportError('Failed to load support requests.', 'error');
          }
        });
      }

      if (supportRefreshButton) {
        supportRefreshButton.addEventListener('click', async () => {
          if (supportRefreshButton.disabled) {
            return;
          }
          supportRefreshButton.disabled = true;
          try {
            const success = await loadSupportRequests();
            if (success) {
              showDashboardToast('Support requests refreshed.', 'success');
            }
          } finally {
            supportRefreshButton.disabled = false;
          }
        });
      }

      if (supportReplyForm) {
        supportReplyForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const threadId = state.support.activeThreadId;
          if (!threadId) {
            setSupportReplyStatusMessage('Select a support request first.', 'error');
            return;
          }
          const messageValue = supportReplyTextarea
            ? supportReplyTextarea.value.trim()
            : '';
          if (!messageValue) {
            setSupportReplyStatusMessage('Enter a reply before sending.', 'error');
            return;
          }
          setSupportReplyStatusMessage('Sending reply?', 'info');
          const previousDisabled = supportReplySubmit
            ? supportReplySubmit.disabled
            : false;
          if (supportReplySubmit) {
            supportReplySubmit.disabled = true;
          }
          try {
            const payload = await api(`/api/admin/support/${threadId}/replies`, {
              method: 'POST',
              body: {
                message: messageValue,
                authorName: state.adminUsername || 'Admin',
              },
            });
            if (payload && payload.thread && payload.thread.request) {
              updateSupportThreadInState(payload.thread);
              state.support.loaded = true;
              state.support.activeThreadId = payload.thread.request.id;
              renderSupportPanel();
              setSupportReplyStatusMessage('Reply sent!', 'success');
              scheduleStatusClear(supportReplyForm, 4000);
              showDashboardToast('Reply sent to supporter.', 'success');
            } else {
              throw new Error('Unexpected response from server.');
            }
          } catch (err) {
            const message =
              err && err.message ? err.message : 'Failed to send reply.';
            setSupportReplyStatusMessage(message, 'error');
          } finally {
            if (supportReplySubmit) {
              supportReplySubmit.disabled = previousDisabled;
            }
          }
        });
      }

      async function updateSupportResolution(resolved) {
        const threadId = state.support.activeThreadId;
        if (!threadId) {
          setSupportError('Select a support request first.', 'error');
          return false;
        }
        try {
          const payload = await api(`/api/admin/support/${threadId}/resolve`, {
            method: 'POST',
            body: { resolved },
          });
          if (payload && payload.thread && payload.thread.request) {
            updateSupportThreadInState(payload.thread);
            state.support.loaded = true;
            state.support.activeThreadId = payload.thread.request.id;
            renderSupportPanel();
            setSupportError('');
            showDashboardToast(
              resolved
                ? 'Support request marked resolved.'
                : 'Support request reopened.',
              'success'
            );
            return true;
          }
          throw new Error('Unexpected response from server.');
        } catch (err) {
          const message =
            err && err.message
              ? err.message
              : 'Failed to update support request.';
          setSupportError(message, 'error');
          return false;
        }
      }

      if (supportMarkResolvedButton) {
        supportMarkResolvedButton.addEventListener('click', async () => {
          if (supportMarkResolvedButton.disabled) {
            return;
          }
          supportMarkResolvedButton.disabled = true;
          if (supportReopenButton) {
            supportReopenButton.disabled = true;
          }
          try {
            await updateSupportResolution(true);
          } finally {
            supportMarkResolvedButton.disabled = false;
            if (supportReopenButton) {
              supportReopenButton.disabled = false;
            }
          }
        });
      }

      if (supportReopenButton) {
        supportReopenButton.addEventListener('click', async () => {
          if (supportReopenButton.disabled) {
            return;
          }
          supportReopenButton.disabled = true;
          if (supportMarkResolvedButton) {
            supportMarkResolvedButton.disabled = true;
          }
          try {
            await updateSupportResolution(false);
          } finally {
            supportReopenButton.disabled = false;
            if (supportMarkResolvedButton) {
              supportMarkResolvedButton.disabled = false;
            }
          }
        });
      }

      if (supportDeleteButton) {
        supportDeleteButton.addEventListener('click', async () => {
          if (supportDeleteButton.disabled) {
            return;
          }
          const threadId = state.support.activeThreadId;
          if (!threadId) {
            setSupportError('Select a support request first.', 'error');
            return;
          }
          const confirmed = await showConfirmModal(
            'Delete support thread',
            'Delete this support request and all messages? This action cannot be undone.'
          );
          if (!confirmed) {
            return;
          }
          supportDeleteButton.disabled = true;
          try {
            await api(`/api/admin/support/${threadId}`, { method: 'DELETE' });
            removeSupportThreadFromState(threadId);
            state.support.loaded = true;
            renderSupportPanel();
            setSupportError('');
            showDashboardToast('Support request deleted.', 'success');
          } catch (err) {
            const message =
              err && err.message
                ? err.message
                : 'Failed to delete support request.';
            setSupportError(message, 'error');
          } finally {
            supportDeleteButton.disabled = false;
          }
        });
      }

      logoutButton.addEventListener('click', async () => {
        try {
          await api('/api/admin/logout', { method: 'POST' });
        } finally {
          stopDashboardAutoRefresh();
          setSessionToken(null);
          state.authenticated = false;
          setWorkspaceLoading(false);
          state.twoFactorPending = false;
          state.donors = [];
          state.shareLinks = [];
          state.events = [];
          state.settings = null;
          clearSettingsFormDirtyFlags();
          state.paypalPlan = null;
          state.paypalProduct = null;
          state.paypalPlanError = '';
          state.paypalPlanManageUrl = '';
          state.paypalPlanLoading = false;
          state.prospectShare = null;
          state.adminUsername = 'admin';
          applyTwoFactorState(null);
          applyAdminOnboardingState(null);
          resetPendingTwoFactorSetup();
          state.support = {
            threads: [],
            activeThreadId: null,
            includeResolved: false,
            error: '',
            loaded: false,
          };
          setSupportReplyStatusMessage('');
          setSupportError('');
          render();
        }
      });

      refreshButton.addEventListener('click', handleManualRefresh);

      if (adminTwoFactorOnboardingStartButton) {
        adminTwoFactorOnboardingStartButton.addEventListener('click', async () => {
          setActiveDashboardView('account');
          await beginTwoFactorSetup();
        });
      }

      if (adminTwoFactorOnboardingSkipButton) {
        adminTwoFactorOnboardingSkipButton.addEventListener('click', async () => {
          try {
            const response = await api('/api/admin/2fa/prompt/dismiss', { method: 'POST' });
            applyAdminOnboardingState(response && response.onboarding ? response.onboarding : null);
            render();
          } catch (err) {
            showDashboardToast(
              err && err.message ? err.message : 'Failed to dismiss 2FA reminder.',
              'error'
            );
          }
        });
      }

      if (prospectShareOpen) {
        prospectShareOpen.addEventListener('click', (event) => {
          openProspectShareModal(event.currentTarget);
        });
      }

      if (prospectShareClose) {
        prospectShareClose.addEventListener('click', () => {
          closeProspectShareModal();
        });
      }

      if (prospectShareModal) {
        prospectShareModal.addEventListener('click', (event) => {
          if (event.target === prospectShareModal) {
            closeProspectShareModal();
          }
        });
        prospectShareModal.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            closeProspectShareModal();
          }
        });
      }

      if (loginTotpForm) {
        loginTotpForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const code = loginTotpCodeInput ? loginTotpCodeInput.value.trim() : '';
          if (!code) {
            setLoginStatus('Authentication code is required.', 'error');
            return;
          }
          setLoginStatus('Verifying code...');
          isSessionExpiring = false;
          if (loginTotpSubmitButton) {
            loginTotpSubmitButton.disabled = true;
          }
          try {
            const response = await api('/api/admin/login/totp', {
              method: 'POST',
              body: { code },
            });
            csrfToken = response.csrfToken;
            state.authenticated = true;
            state.twoFactorPending = false;
            state.adminUsername = response.adminUsername || state.adminUsername;
            applyTwoFactorState(response && response.twoFactor ? response.twoFactor : null);
            applyAdminOnboardingState(response && response.onboarding ? response.onboarding : null);
            loginRateLimitedUntil = null;
            isSessionExpiring = false;
            await enterAdminWorkspace();
            setLoginStatus('');
          } catch (err) {
            setLoginStatus(err.message || 'Verification failed', 'error');
          } finally {
            if (loginTotpSubmitButton) {
              loginTotpSubmitButton.disabled = false;
            }
          }
        });
      }

      if (loginTotpCancelButton) {
        loginTotpCancelButton.addEventListener('click', async () => {
          try {
            await api('/api/admin/login/totp/cancel', { method: 'POST' });
          } catch (err) {
            console.error('Failed to cancel pending two-factor login', err);
          } finally {
            showLoginPasswordForm();
            setLoginStatus('');
          }
        });
      }

      if (prospectShareForm) {
        prospectShareForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          await generateProspectShareLink({ regenerate: false });
        });
      }

      if (adminCredentialsForm) {
        adminCredentialsForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const usernameInput = adminCredentialsForm.querySelector("input[name='username']");
          const currentPasswordInput = adminCredentialsForm.querySelector(
            "input[name='currentPassword']"
          );
          const newPasswordInput = adminCredentialsForm.querySelector("input[name='newPassword']");
          const confirmPasswordInput = adminCredentialsForm.querySelector(
            "input[name='confirmPassword']"
          );

          const username = usernameInput ? usernameInput.value.trim() : '';
          const currentPassword = currentPasswordInput ? currentPasswordInput.value : '';
          const newPassword = newPasswordInput ? newPasswordInput.value : '';
          const confirmPassword = confirmPasswordInput ? confirmPasswordInput.value : '';

          if (!currentPassword) {
            setFormStatus(adminCredentialsForm, 'Current password is required.', 'error');
            return;
          }

          if (newPassword || confirmPassword) {
            if (newPassword !== confirmPassword) {
              setFormStatus(adminCredentialsForm, 'New passwords do not match.', 'error');
              return;
            }
            if (newPassword.trim().length < 12) {
              setFormStatus(
                adminCredentialsForm,
                'New password must be at least 12 characters long.',
                'error'
              );
              return;
            }
          }

          setFormStatus(adminCredentialsForm, 'Saving?', 'pending');
          const submitButton = adminCredentialsForm.querySelector("button[type='submit']");
          if (submitButton) {
            submitButton.disabled = true;
          }

          const payload = {
            currentPassword,
          };
          if (username) {
            payload.username = username;
          }
          if (newPassword) {
            payload.newPassword = newPassword;
            payload.confirmPassword = confirmPassword;
          }

          try {
            const response = await api('/api/admin/account', {
              method: 'PUT',
              body: payload,
            });
            if (response && response.username) {
              state.adminUsername = response.username;
            }
            setFormStatus(adminCredentialsForm, 'Admin credentials updated.', 'success');
            scheduleStatusClear(adminCredentialsForm, 4000);
            if (currentPasswordInput) {
              currentPasswordInput.value = '';
            }
            if (newPasswordInput) {
              newPasswordInput.value = '';
            }
            if (confirmPasswordInput) {
              confirmPasswordInput.value = '';
            }
          } catch (err) {
            setFormStatus(
              adminCredentialsForm,
              err && err.message ? err.message : 'Failed to update admin credentials.',
              'error'
            );
          } finally {
            if (submitButton) {
              submitButton.disabled = false;
            }
            renderAdminAccountPanel();
          }
        });
      }

      if (prospectShareRegenerate) {
        prospectShareRegenerate.addEventListener('click', async () => {
          await generateProspectShareLink({ regenerate: true });
        });
      }

      if (prospectShareCopy) {
        prospectShareCopy.addEventListener('click', async () => {
          const shareLink = state.prospectShare ? state.prospectShare.shareLink : null;
          const shareUrl = buildShareUrl(shareLink);
          if (!shareUrl) {
            return;
          }
          const copied = await copyTextToClipboard(shareUrl);
          if (copied) {
            setFormStatus(prospectShareForm, 'Setup link copied to clipboard!', 'success');
            scheduleStatusClear(prospectShareForm, 4000);
          } else {
            setFormStatus(
              prospectShareForm,
              `Copy this setup link manually: ${shareUrl}`,
              'success'
            );
          }
        });
      }

      async function beginTwoFactorSetup({ source = 'settings' } = {}) {
        const targetForm = adminTwoFactorForm;
        if (targetForm) {
          setFormStatus(targetForm, 'Generating QR code...', 'pending');
        }
        try {
          const response = await api('/api/admin/2fa/setup', { method: 'POST' });
          state.pendingTwoFactorSetup = response && response.setup ? response.setup : null;
          applyTwoFactorState(response && response.twoFactor ? response.twoFactor : state.adminTwoFactor);
          applyAdminOnboardingState(response && response.onboarding ? response.onboarding : state.adminOnboarding);
          if (adminTwoFactorQr && state.pendingTwoFactorSetup) {
            adminTwoFactorQr.src = state.pendingTwoFactorSetup.qrCodeDataUrl || '';
          }
          if (adminTwoFactorManualKey && state.pendingTwoFactorSetup) {
            adminTwoFactorManualKey.value = state.pendingTwoFactorSetup.manualEntryKey || '';
          }
          if (adminTwoFactorSetupPanel) {
            adminTwoFactorSetupPanel.classList.remove('hidden');
          }
          if (adminTwoFactorVerifyButton) {
            adminTwoFactorVerifyButton.disabled = !state.pendingTwoFactorSetup;
          }
          setFormStatus(adminTwoFactorForm, 'Scan the QR code, then enter the 6-digit code from your app.', 'success');
          renderAdminAccountPanel();
        } catch (err) {
          const message = err && err.message ? err.message : 'Failed to generate setup QR code.';
          if (targetForm) {
            setFormStatus(targetForm, message, 'error');
          }
        }
      }

      async function verifyTwoFactorSetup(code) {
        if (!code) {
          setFormStatus(adminTwoFactorForm, 'Authentication code is required.', 'error');
          return;
        }
        try {
          const response = await api('/api/admin/2fa/setup/verify', {
            method: 'POST',
            body: { code },
          });
          applyTwoFactorState(response && response.twoFactor ? response.twoFactor : null);
          applyAdminOnboardingState(response && response.onboarding ? response.onboarding : null);
          resetPendingTwoFactorSetup();
          render();
          setFormStatus(adminTwoFactorForm, 'Two-factor authentication enabled.', 'success');
          scheduleStatusClear(adminTwoFactorForm, 4000);
        } catch (err) {
          const message = err && err.message ? err.message : 'Failed to verify authentication code.';
          setFormStatus(adminTwoFactorForm, message, 'error');
        }
      }

      if (adminTwoFactorStartButton) {
        adminTwoFactorStartButton.addEventListener('click', async () => {
          await beginTwoFactorSetup();
        });
      }

      if (adminTwoFactorVerifyButton) {
        adminTwoFactorVerifyButton.addEventListener('click', async () => {
          const code = adminTwoFactorCode ? adminTwoFactorCode.value.trim() : '';
          await verifyTwoFactorSetup(code);
        });
      }

      if (adminTwoFactorDisableButton) {
        adminTwoFactorDisableButton.addEventListener('click', async () => {
          const currentPassword = window.prompt('Enter your current admin password to turn off 2FA:');
          if (currentPassword === null) {
            return;
          }
          try {
            const response = await api('/api/admin/2fa', {
              method: 'DELETE',
              body: { currentPassword },
            });
            applyTwoFactorState(response && response.twoFactor ? response.twoFactor : null);
            applyAdminOnboardingState(response && response.onboarding ? response.onboarding : state.adminOnboarding);
            resetPendingTwoFactorSetup();
            renderAdminAccountPanel();
            setFormStatus(adminTwoFactorForm, 'Two-factor authentication turned off.', 'success');
            scheduleStatusClear(adminTwoFactorForm, 4000);
          } catch (err) {
            setFormStatus(
              adminTwoFactorForm,
              err && err.message ? err.message : 'Failed to turn off 2FA.',
              'error'
            );
          }
        });
      }

      if (prospectShareReset) {
        prospectShareReset.addEventListener('click', () => {
          if (!prospectShareForm) {
            return;
          }
          prospectShareForm.reset();
          const idInput = prospectShareForm.querySelector('[name="prospectId"]');
          if (idInput) {
            idInput.value = '';
          }
          state.prospectShare = null;
          if (prospectShareResult) {
            prospectShareResult.classList.add('hidden');
          }
          if (prospectShareCopy) {
            prospectShareCopy.disabled = true;
          }
          if (prospectShareRegenerate) {
            prospectShareRegenerate.disabled = true;
          }
          if (prospectShareSummary) {
            prospectShareSummary.textContent = '';
          }
          if (prospectShareNote) {
            prospectShareNote.textContent = '';
          }
          setFormStatus(prospectShareForm, '');
          renderProspectSharePanel();
        });
      }

      settingsForms.forEach((form) => {
        const handleDirty = () => markSettingsFormDirty(form);
        form.addEventListener('input', handleDirty);
        form.addEventListener('change', handleDirty);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const group = form.dataset.group;
          if (!group) {
            return;
          }
          const payload = getFormPayload(form);
          const submitButton = form.querySelector("button[type='submit']");
          try {
            if (submitButton) {
              submitButton.disabled = true;
            }
            setFormStatus(form, 'Saving?');
            const response = await api(`/api/admin/settings/${group}`, {
              method: 'PUT',
              body: payload,
            });
            if (!state.settings) {
              state.settings = {};
            }
            state.settings[group] = response.settings || {};
            delete form.dataset.dirty;
            if (group === 'paypal') {
              await loadPaypalPlan();
            }
            renderSettings();
            setFormStatus(form, 'Saved!', 'success');
            scheduleStatusClear(form);
          } catch (err) {
            setFormStatus(form, err.message || 'Failed to save settings', 'error');
          } finally {
            if (submitButton) {
              submitButton.disabled = false;
            }
          }
        });

        form.addEventListener('click', async (event) => {
          const button = event.target.closest('button[data-action]');
          if (!button) {
            return;
          }
          const action = button.dataset.action;
          if (!action) {
            return;
          }
          event.preventDefault();
          const group = form.dataset.group;
          if (!group) {
            return;
          }

          if (action === 'test') {
            const payload = getFormPayload(form);
            const previousDisabledState = button.disabled;
            try {
              button.disabled = true;
              setFormStatus(form, 'Testing?');
              const response = await api(`/api/admin/settings/${group}/test`, {
                method: 'POST',
                body: payload,
              });
              const result = response.result || {};
              const message =
                result.message ||
                response.message ||
                'Settings test completed successfully.';
              setFormStatus(form, message, 'success');
              if (group === 'plex') {
                if (Array.isArray(result.libraries)) {
                  state.plexLibraries = result.libraries
                    .map((library) => ({
                      id:
                        library && library.id != null
                          ? String(library.id)
                          : '',
                      title:
                        library && library.title
                          ? String(library.title)
                          : '',
                    }))
                    .filter((library) => library.id);
                  hasCachedPlexLibraries = state.plexLibraries.length > 0;
                  plexLibraryOptionsDirty = true;
                }
                const preferredSelection =
                  result.details && result.details.librarySectionIds
                    ? result.details.librarySectionIds
                    : null;
                renderPlexLibrarySelector({
                  preserveSelection: true,
                  preferredSelection,
                });
              }
              scheduleStatusClear(form);
            } catch (err) {
              setFormStatus(
                form,
                err.message || 'Failed to verify settings',
                'error'
              );
            } finally {
              button.disabled = previousDisabledState;
            }
            return;
          }

          if (action === 'test-ups') {
            const payload = getFormPayload(form);
            const previousDisabledState = button.disabled;
            try {
              button.disabled = true;
              setFormStatus(form, 'Sending UPS test email?');
              const response = await api('/api/admin/automation/ups/test', {
                method: 'POST',
                body: payload,
              });
              setFormStatus(
                form,
                response.message || 'UPS test email sent successfully.',
                'success'
              );
              scheduleStatusClear(form);
            } catch (err) {
              setFormStatus(
                form,
                err.message || 'Failed to send UPS test email.',
                'error'
              );
            } finally {
              button.disabled = previousDisabledState;
            }
            return;
          }

          if (action === 'test-ups-shutdown') {
            const payload = getFormPayload(form);
            const previousDisabledState = button.disabled;
            try {
              button.disabled = true;
              setFormStatus(form, 'Sending UPS shutdown test email?');
              const response = await api('/api/admin/automation/ups/test', {
                method: 'POST',
                body: {
                  ...payload,
                  event: 'shutdown_imminent',
                },
              });
              setFormStatus(
                form,
                response.message || 'UPS shutdown test email sent successfully.',
                'success'
              );
              scheduleStatusClear(form);
            } catch (err) {
              setFormStatus(
                form,
                err.message || 'Failed to send UPS shutdown test email.',
                'error'
              );
            } finally {
              button.disabled = previousDisabledState;
            }
            return;
          }

          if (action === 'send-announcement-email') {
            const values = getFormPayload(form);
            const title =
              typeof values.bannerTitle === 'string'
                ? values.bannerTitle.trim()
                : '';
            const bodyText =
              typeof values.bannerBody === 'string'
                ? values.bannerBody.trim()
                : '';

            if (!title || !bodyText) {
              showDashboardToast(
                'Add a banner title and message before emailing supporters.',
                'error'
              );
              return;
            }

            const confirmed = await showConfirmModal(
              'Send announcement email',
              'This will email the current announcement to all supporters with an email address on file. Continue?'
            );
            if (!confirmed) {
              return;
            }

            const previousDisabledState = button.disabled;
            try {
              button.disabled = true;
              setFormStatus(form, 'Sending announcement email?');
              const response = await api('/api/admin/announcements/email', {
                method: 'POST',
                body: values,
              });
              const sentCount = response.sent || 0;
              const toastMessage =
                sentCount === 1
                  ? 'Announcement email sent to 1 supporter.'
                  : `Announcement email sent to ${sentCount} supporters.`;
              showDashboardToast(toastMessage, 'success');
              setFormStatus(form, 'Announcement email sent!', 'success');
              scheduleStatusClear(form);
            } catch (err) {
              const message =
                err && err.message
                  ? err.message
                  : 'Failed to send announcement email.';
              showDashboardToast(message, 'error');
              setFormStatus(form, message, 'error');
            } finally {
              button.disabled = previousDisabledState;
            }
            return;
          }

        });
      });

      if (subscribersTable) {
        subscribersTable.addEventListener('click', async (event) => {
          const toggle = event.target.closest('[data-menu-toggle]');
          if (toggle) {
            const menu = toggle.closest('.action-menu');
            toggleSubscriberActionMenu(menu);
            return;
          }
  
          const button = event.target.closest('button[data-action]');
          if (!button) return;
          const row = event.target.closest('tr');
          const donorId = row && row.dataset.id;
          if (!donorId) return;
          const action = button.dataset.action;
          const menu = button.closest('.action-menu');
          if (menu) {
            closeSubscriberActionMenu(menu);
          }
          button.disabled = true;
          let requiresReload = true;
          try {
            if (action === 'invite') {
              requiresReload = false;
              const response = await api(`/api/admin/subscribers/${donorId}/invite`, {
                method: 'POST',
              });
              if (response && response.plex) {
                state.plex = response.plex;
              }
              if (response && response.donor) {
                const donors = Array.isArray(state.donors) ? [...state.donors] : [];
                const index = donors.findIndex(
                  (item) => String(item.id) === String(response.donor.id)
                );
                if (index !== -1) {
                  donors[index] = { ...donors[index], ...response.donor };
                } else {
                  donors.push(response.donor);
                }
                state.donors = donors;
              } else {
                requiresReload = true;
              }
              const inviteMessage =
                (response && response.message) || 'Plex invite created successfully.';
              showDashboardToast(inviteMessage, (response && response.info) ? 'info' : 'success');
            } else if (action === 'share' || action === 'share-generate') {
              const regenerate = action === 'share-generate' ? true : event.shiftKey;
              const options = { method: 'POST' };
              if (regenerate) {
                options.body = { regenerate: true };
              }
              const response = await api(
                `/api/admin/subscribers/${donorId}/share-link`,
                options
              );
              const shareLink = response.shareLink || {};
              const configuredBase = getPublicBaseUrl();
              const origin =
                configuredBase || window.location.origin.replace(/\/$/, '');
              const shareUrl =
                shareLink.url ||
                (shareLink.token ? `${origin}/share/${shareLink.token}` : '');
              if (!shareUrl) {
                throw new Error('Unable to determine setup link URL');
              }
              await copyShareUrlWithFeedback(
                shareUrl,
                action === 'share-generate'
                  ? 'New setup link created and copied to clipboard.'
                  : regenerate
                    ? 'Setup link regenerated and copied to clipboard.'
                    : 'Setup link copied to clipboard.'
              );
            } else if (action === 'refresh') {
              requiresReload = false;
              const response = await api(`/api/admin/subscribers/${donorId}/refresh`, {
                method: 'POST',
              });
              const normalizedError =
                typeof response.error === 'string' ? response.error : '';
              const donors = Array.isArray(state.donors) ? [...state.donors] : [];
              const index = donors.findIndex(
                (item) => String(item.id) === String(donorId)
              );
              if (index !== -1) {
                const updatedDonor = response.donor || null;
                donors[index] = {
                  ...donors[index],
                  ...(updatedDonor || {}),
                  paypalRefreshError: normalizedError,
                };
              }
              state.donors = donors;
            } else if (action === 'resend') {
              await api(`/api/admin/subscribers/${donorId}/email`, { method: 'POST' });
            } else if (action === 'revoke') {
              if (!(await showConfirmModal('Revoke Plex invite', 'Revoke the latest Plex invite for this subscriber? They will lose access to that invite URL.'))) {
                return;
              }
              await api(`/api/admin/subscribers/${donorId}/revoke`, { method: 'POST' });
            } else if (action === 'revoke-plex') {
              if (!(await showConfirmModal('Revoke Plex access', 'This will remove the subscriber\'s access to your Plex server. They will need a new invite to regain access.'))) {
                button.disabled = false;
                return;
              }
              requiresReload = false;
              const response = await api(`/api/admin/subscribers/${donorId}/revoke-plex`, {
                method: 'POST',
              });
              if (response && response.plex) {
                state.plex = response.plex;
              }
              if (response && response.donor) {
                const donors = Array.isArray(state.donors) ? [...state.donors] : [];
                const index = donors.findIndex((item) => String(item.id) === String(response.donor.id));
                if (index !== -1) {
                  donors[index] = { ...donors[index], ...response.donor };
                }
                state.donors = donors;
              } else {
                requiresReload = true;
              }
              const successMessage = (response && response.message) || 'Plex access revoked successfully.';
              showDashboardToast(successMessage, 'success');
            } else if (action === 'remove') {
              if (!(await showConfirmModal('Remove subscriber', 'This will permanently delete this subscriber and all related invites, payments, and setup links. This action cannot be undone.'))) {
                return;
              }
              await api(`/api/admin/subscribers/${donorId}`, { method: 'DELETE' });
            }
            if (requiresReload) {
              await loadDashboardData();
            } else {
              render();
            }
          } catch (err) {
            console.error(err);
            showDashboardToast(err.message || 'Action failed', 'error', 6000);
          } finally {
            button.disabled = false;
          }
        });
      }

      if (shareLinksTable) {
        shareLinksTable.addEventListener('click', async (event) => {
          const button = event.target.closest('button[data-action]');
          if (!button) {
            return;
          }
          const row = event.target.closest('tr');
          const linkId = row && row.dataset.id;
          if (!linkId) {
            return;
          }
          const action = button.dataset.action;
          const links = Array.isArray(state.shareLinks) ? state.shareLinks : [];
          const link = links.find((item) => String(item.id) === String(linkId));
          if (!link) {
            showDashboardToast('Unable to locate this setup link.', 'error');
            return;
          }

          if (action === 'copy') {
            const shareUrl = buildShareUrl(link);
            if (!shareUrl) {
              showDashboardToast(
                'This setup link does not have a shareable URL yet.',
                'error'
              );
              return;
            }
            await copyShareUrlWithFeedback(
              shareUrl,
              'Setup link copied to clipboard.'
            );
            return;
          }

          if (action === 'remove') {
            const confirmation = await showConfirmModal(
              'Remove setup link',
              'Remove this setup link? Anyone with the URL will lose access to that setup page.'
            );
            if (!confirmation) {
              return;
            }
            const previousDisabledState = button.disabled;
            try {
              button.disabled = true;
              await api(`/api/admin/share-links/${linkId}`, { method: 'DELETE' });
              await refreshShareLinks();
              renderShareLinks();
            } catch (err) {
              showDashboardToast(err.message || 'Failed to remove setup link.', 'error');
            } finally {
              button.disabled = previousDisabledState;
            }
          }
        });
      }

      document.addEventListener('click', (event) => {
        if (!openSubscriberActionMenu) {
          return;
        }
        if (event.target.closest('.action-menu') === openSubscriberActionMenu) {
          return;
        }
        closeSubscriberActionMenu();
      });

      document.addEventListener('focusin', (event) => {
        if (!openSubscriberActionMenu) {
          return;
        }
        if (event.target.closest('.action-menu') === openSubscriberActionMenu) {
          return;
        }
        closeSubscriberActionMenu();
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && openSubscriberActionMenu) {
          closeSubscriberActionMenu(null, { focusToggle: true });
        }
      });

      // Master-detail donors view event listeners
      if (donorsFilterTabs) {
        donorsFilterTabs.forEach(tab => {
          tab.addEventListener('click', () => {
            currentFilter = tab.dataset.filter;
            donorsFilterTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderDonorsList();
          });
        });
      }

      if (donorsSearchInput) {
        donorsSearchInput.addEventListener('input', (e) => {
          searchQuery = e.target.value;
          renderDonorsList();
        });
      }

      // Donor detail action buttons
      if (donorDetailActions) {
        donorDetailActions.addEventListener('click', async (event) => {
          const button = event.target.closest('button[data-action]');
          if (!button) return;

          const action = button.dataset.action;
          const donorId = button.dataset.donorId;
          if (!donorId) return;

          button.disabled = true;
          let requiresReload = true;

          try {
            if (action === 'invite') {
              requiresReload = false;
              const response = await api(`/api/admin/subscribers/${donorId}/invite`, {
                method: 'POST',
              });
              if (response && response.plex) {
                state.plex = response.plex;
              }
              if (response && response.donor) {
                const donors = Array.isArray(state.donors) ? [...state.donors] : [];
                const index = donors.findIndex(item => String(item.id) === String(response.donor.id));
                if (index !== -1) {
                  donors[index] = { ...donors[index], ...response.donor };
                } else {
                  donors.push(response.donor);
                }
                state.donors = donors;
              } else {
                requiresReload = true;
              }
              const inviteMessage = (response && response.message) || 'Plex invite created successfully.';
              showDashboardToast(inviteMessage, (response && response.info) ? 'info' : 'success');
            } else if (action === 'share' || action === 'share-generate') {
              const regenerate = action === 'share-generate' ? true : event.shiftKey;
              const options = { method: 'POST' };
              if (regenerate) {
                options.body = { regenerate: true };
              }
              const response = await api(`/api/admin/subscribers/${donorId}/share-link`, options);
              const shareLink = response.shareLink || {};
              const configuredBase = getPublicBaseUrl();
              const origin = configuredBase || window.location.origin.replace(/\/$/, '');
              const shareUrl = shareLink.url || (shareLink.token ? `${origin}/share/${shareLink.token}` : '');
              if (!shareUrl) {
                throw new Error('Unable to determine setup link URL');
              }
              await copyShareUrlWithFeedback(
                shareUrl,
                action === 'share-generate'
                  ? 'New setup link created and copied to clipboard.'
                  : regenerate
                    ? 'Setup link regenerated and copied to clipboard.'
                    : 'Setup link copied to clipboard.'
              );
            } else if (action === 'refresh') {
              requiresReload = false;
              const response = await api(`/api/admin/subscribers/${donorId}/refresh`, {
                method: 'POST',
              });
              if (response && response.donor) {
                const donors = Array.isArray(state.donors) ? [...state.donors] : [];
                const index = donors.findIndex(item => String(item.id) === String(response.donor.id));
                if (index !== -1) {
                  donors[index] = { ...donors[index], ...response.donor };
                }
                state.donors = donors;
              } else {
                requiresReload = true;
              }
              const successMessage = (response && response.message) || 'PayPal subscription refreshed.';
              showDashboardToast(successMessage, 'success');
            } else if (action === 'resend') {
              const response = await api(`/api/admin/subscribers/${donorId}/resend`, {
                method: 'POST',
              });
              const successMessage = (response && response.message) || 'Email resent successfully.';
              showDashboardToast(successMessage, 'success');
            } else if (action === 'revoke') {
              if (!(await showConfirmModal('Revoke Plex invite', 'Revoke this Plex invite? The recipient will lose access to that invite URL.'))) {
                button.disabled = false;
                return;
              }
              requiresReload = false;
              const response = await api(`/api/admin/subscribers/${donorId}/revoke`, {
                method: 'POST',
              });
              if (response && response.donor) {
                const donors = Array.isArray(state.donors) ? [...state.donors] : [];
                const index = donors.findIndex(item => String(item.id) === String(response.donor.id));
                if (index !== -1) {
                  donors[index] = { ...donors[index], ...response.donor };
                }
                state.donors = donors;
              } else {
                requiresReload = true;
              }
              const successMessage = (response && response.message) || 'Invite revoked successfully.';
              showDashboardToast(successMessage, 'success');
            } else if (action === 'revoke-plex') {
              if (!(await showConfirmModal('Revoke Plex access', 'This will remove the subscriber\'s access to your Plex server. They will need a new invite to regain access.'))) {
                button.disabled = false;
                return;
              }
              requiresReload = false;
              const response = await api(`/api/admin/subscribers/${donorId}/revoke-plex`, {
                method: 'POST',
              });
              if (response && response.plex) {
                state.plex = response.plex;
              }
              if (response && response.donor) {
                const donors = Array.isArray(state.donors) ? [...state.donors] : [];
                const index = donors.findIndex(item => String(item.id) === String(response.donor.id));
                if (index !== -1) {
                  donors[index] = { ...donors[index], ...response.donor };
                }
                state.donors = donors;
              } else {
                requiresReload = true;
              }
              const successMessage = (response && response.message) || 'Plex access revoked successfully.';
              showDashboardToast(successMessage, 'success');
            } else if (action === 'remove') {
              if (!(await showConfirmModal('Remove subscriber', 'Remove this subscriber and all related records? This action cannot be undone.'))) {
                button.disabled = false;
                return;
              }
              await api(`/api/admin/subscribers/${donorId}`, { method: 'DELETE' });
              const donors = Array.isArray(state.donors) ? [...state.donors] : [];
              state.donors = donors.filter(item => String(item.id) !== String(donorId));
              selectedDonorId = null;
              showDashboardToast('User removed successfully.', 'success');
              renderSubscribers();
              return;
            }

            if (requiresReload) {
              await refreshSubscribers();
            }
            renderSubscribers();
          } catch (err) {
            showDashboardToast(err.message || 'An error occurred', 'error');
            button.disabled = false;
          } finally {
            if (!requiresReload) {
              button.disabled = false;
            }
          }
        });
      }

      // Add back button for mobile detail view
      if (donorDetail && donorsLayout) {
        const backButton = document.createElement('button');
        backButton.className = 'secondary';
        backButton.textContent = 'Back to list';
        backButton.style.display = 'none';
        backButton.style.marginBottom = '16px';
        backButton.id = 'donor-detail-back';

        const detailHeader = donorDetail.querySelector('.donor-detail-header');
        if (detailHeader) {
          donorDetail.insertBefore(backButton, detailHeader);
        }

        backButton.addEventListener('click', () => {
          donorsLayout.classList.remove('detail-active');
          selectedDonorId = null;
          renderDonorsList();
          showDonorsEmptyState();
        });

        // Show/hide back button based on screen size
        const updateBackButtonVisibility = () => {
          if (window.innerWidth <= 1024) {
            backButton.style.display = 'block';
          } else {
            backButton.style.display = 'none';
          }
        };

        window.addEventListener('resize', updateBackButtonVisibility);
        updateBackButtonVisibility();
      }

      checkSession();

      // Initialize Lucide icons on page load
      if (typeof lucide !== 'undefined') {
        lucide.createIcons();
      }


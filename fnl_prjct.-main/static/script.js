(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);

  let authMode = 'login';
  let currentUser = null;
  let events = [];
  let registrations = [];
  let categories = [];
  let activeCategory = 'All';
  let searchTerm = '';
  let activeTab = 'dashboard';

  // notifications
  let notifications = [];
  let unreadCount = 0;
  let notifTimer = null;

  // BACK: tabs that can be stored in browser history
  const VALID_TABS = ['dashboard', 'events', 'mine', 'profile', 'attended'];

  // ----- input rules -----
  // Student ID: exactly 8 digits in the format 0000-1000.
  // Name: letters only (spaces, periods, apostrophes and hyphens allowed).
  const STUDENT_ID_RE = /^\d{4}-\d{4}$/;
  const NAME_RE = /^\p{L}+(?:[ .'’\-]+\p{L}+)*\.?$/u;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Must match PASSWORD_MIN_LENGTH in app.py
  const PASSWORD_MIN_LENGTH = 8;

  const STUDENT_ID_MESSAGE =
    'Student ID should look like 0000-1000.';
  const NAME_MESSAGE =
    'Names can only use letters, spaces, periods, apostrophes and hyphens.';
  const PASSWORD_MESSAGE =
    `Password needs at least ${PASSWORD_MIN_LENGTH} characters.`;
  const EMAIL_MESSAGE =
    "That doesn't look like a valid email. Try name@example.com.";

  // One "empty field" message per input, so they don't all read the same.
  // The key is the input's id.
  const REQUIRED_MESSAGES = {
    'auth-student-id': 'Please enter your student ID.',
    'auth-name': 'Please enter your full name.',
    'auth-email': 'Please enter your email address.',
    'auth-password': 'Please enter your password.',
    'profile-course': 'Please select your course.',
    'profile-year': 'Please select your year level.',
    'profile-section': 'Please enter your section (e.g. A).',
    default: 'Please fill out this field.'
  };

  const COURSES = ['BSCS', 'BSIT'];
  const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];

  // A user has class info once course, year level and section are all saved.
  function hasClassInfo(user) {
    return Boolean(user && user.course && user.year && user.section);
  }

  // "BSCS 1A" style label, e.g. BSCS + 1st Year + A
  function classLabel(user) {
    if (!hasClassInfo(user)) return '';
    const yearNumber = (String(user.year).match(/^\d/) || [''])[0];
    return `${user.course} ${yearNumber}${user.section}`;
  }

  // ----- per-field messages (like Google Forms) -----
  // The message is created the first time it is needed and is only visible
  // while its .field has the "has-error" class.
  // If no message is passed, the one written for that specific field is used.
  function showFieldError(input, message = null, anchor = null) {
    const field = input.closest('.field');
    if (!field) return;

    let error = field.querySelector('.field-error');

    if (!error) {
      error = document.createElement('div');
      error.className = 'field-error';
      error.setAttribute('role', 'alert');

      const target = anchor || input.closest('.input-with-icon') || input;
      target.parentNode.insertBefore(error, target);
    }

    let text = message ||
      REQUIRED_MESSAGES[input.id] ||
      REQUIRED_MESSAGES.default;

    // On sign up the person is creating a password, not entering one.
    if (!message && input.id === 'auth-password' && authMode === 'signup') {
      text = `Please create a password with at least ${PASSWORD_MIN_LENGTH} characters.`;
    }

    error.textContent = text;
    field.classList.add('has-error');
  }

  function clearFieldError(input) {
    const field = input.closest('.field');
    if (field) field.classList.remove('has-error');
  }

  function clearAllFieldErrors(root) {
    if (!root) return;
    root.querySelectorAll('.field.has-error').forEach((field) => {
      field.classList.remove('has-error');
    });
  }

  // Remove wrong characters while the user types or pastes,
  // and hide a field's message as soon as the user fixes it.
  document.addEventListener('input', (event) => {
    const field = event.target;

    if (!field || !field.id) return;

    if (field.id === 'auth-student-id') {
      // digits only, max 8, auto-insert "-" after the 4th digit
      const digits = field.value.replace(/\D/g, '').slice(0, 8);
      field.value = digits.length > 4
        ? `${digits.slice(0, 4)}-${digits.slice(4)}`
        : digits;
    }

    if (field.id === 'auth-name' || field.id === 'registration-name') {
      field.value = field.value.replace(/[0-9_]|[^\p{L} .'’\-]/gu, '');
    }

    if (field.id === 'profile-section') {
      field.value = field.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    }

    clearFieldError(field);
  });

  // Radio buttons and dropdowns also clear their message when changed.
  document.addEventListener('change', (event) => {
    if (event.target && event.target.closest) {
      clearFieldError(event.target);
    }
  });

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401 && path !== '/api/auth/login') {
        showAuth();
      }

      throw new Error(data.error || 'Something went wrong. Please try again.');
    }

    return data;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
  }

  function fmtDate(value) {
    if (!value) return 'Date to be announced';

    const date = new Date(`${value}T00:00:00`);

    if (Number.isNaN(date.getTime())) return value;

    return date.toLocaleDateString('en-PH', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  // An event is finished when the server says so (marked done by the admin
  // or its date/time has passed). The date check is only a fallback.
  function isEventFinished(event) {
    if (!event) return false;

    if (typeof event.isFinished === 'boolean') {
      return event.isFinished;
    }

    const when = new Date(`${event.date}T${event.time || '23:59'}`);

    return !Number.isNaN(when.getTime()) && when < new Date();
  }

  // Course, section, year level and attendance answer of a registration.
  function registrationDetails(registration) {
    const classInfo = [
      registration.course,
      registration.section,
      registration.year
    ].filter(Boolean).join(' · ');

    const attending =
      `Attending: ${registration.attending === 'no' ? 'No' : 'Yes'}`;

    return classInfo ? `${classInfo} · ${attending}` : attending;
  }

  // ----- toast notifications -----
  // type: "success" (green) or "error" (red). Toasts stack at the top right.
  function showToast(message, type = 'success', duration = 4000) {
    const root = $('#toast-root');
    if (!root) return;

    const toast = document.createElement('div');
    toast.className = 'toast' + (type === 'error' ? ' error' : '');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = type === 'error' ? '✕' : '✓';

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '✕';

    toast.append(icon, text, close);
    root.appendChild(toast);

    let timer;
    const dismiss = () => {
      clearTimeout(timer);
      toast.classList.add('leaving');
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    };

    close.addEventListener('click', dismiss);
    timer = setTimeout(dismiss, duration);
  }

  function showAuth() {
    $('#auth-view').hidden = false;
    $('#participant-app').hidden = true;
    $('#modal-root').innerHTML = '';
    stopNotificationPolling();
    setNotifPanel(false);
  }

  function showApp() {
    $('#auth-view').hidden = true;
    $('#participant-app').hidden = false;
    $('#header-user').textContent = currentUser?.name || '';

    // Update the name and avatar initial in the user's sidebar
    const userName = currentUser?.name || 'User';
    const sidebarNameElem = document.getElementById('sidebar-user-name');
    const sidebarAvatarElem = document.getElementById('account-avatar-initial');

    if (sidebarNameElem) sidebarNameElem.textContent = userName;
    if (sidebarAvatarElem) sidebarAvatarElem.textContent = userName.charAt(0).toUpperCase();

    startNotificationPolling();
  }

  // ----- sign in / sign up screen -----

  // Turn off the browser's own validation bubbles so our red messages show.
  $('#auth-form').noValidate = true;

  function setAuthMode(mode) {
    authMode = mode;

    const isSignup = mode === 'signup';

    // Tabs (hidden by CSS, kept in sync anyway)
    $('#login-tab').classList.toggle('active', !isSignup);
    $('#signup-tab').classList.toggle('active', isSignup);

    // Extra sign-up fields
    $('#student-id-field').hidden = !isSignup;
    $('#name-field').hidden = !isSignup;
    $('#auth-student-id').required = isSignup;
    $('#auth-name').required = isSignup;

    // Forgot password only makes sense when logging in
    $('#login-options').hidden = isSignup;

    // Password rules: minimum length + hint (hint only on sign up)
    const passwordInput = $('#auth-password');
    passwordInput.minLength = PASSWORD_MIN_LENGTH;
    passwordInput.autocomplete = isSignup
      ? 'new-password'
      : 'current-password';
    passwordInput.placeholder = isSignup
      ? `Password (at least ${PASSWORD_MIN_LENGTH} characters)`
      : 'Password';
    $('#password-hint').textContent =
      `Minimum of ${PASSWORD_MIN_LENGTH} characters.`;
    $('#password-hint').hidden = !isSignup;

    // Texts
    $('#auth-title').innerHTML = isSignup
      ? 'Sign Up<span></span>'
      : 'Log In<span></span>';

    $('#auth-subtitle').textContent = isSignup
      ? 'Create an account to register for events.'
      : 'Log in to discover and register for events.';

    $('#art-title').textContent = isSignup ? 'Hello there!' : 'Welcome!';

    $('#art-text').textContent = isSignup
      ? 'Create a free account to discover and join school events.'
      : 'You can sign in to access your existing account and join school events.';

    $('#auth-submit').textContent = isSignup ? 'Create Account' : 'Login';

    $('#auth-switch-text').textContent = isSignup
      ? 'Already registered?'
      : 'New here?';

    $('#auth-switch-btn').textContent = isSignup
      ? 'Log in'
      : 'Create an Account';

    // Clear previous values and errors when switching modes
    $('#auth-form').reset();
    clearAllFieldErrors($('#auth-form'));
    $('#auth-error').textContent = '';
    $('#auth-error').hidden = true;
  }

  $('#login-tab').addEventListener('click', () => setAuthMode('login'));
  $('#signup-tab').addEventListener('click', () => setAuthMode('signup'));

  $('#auth-switch-btn').addEventListener('click', () => {
    setAuthMode(authMode === 'signup' ? 'login' : 'signup');
  });

  $('#forgot-btn').addEventListener('click', () => {
    showToast('Please contact your administrator to reset your password.');
  });

  // Show the number keypad on phones for the Student ID box.
  $('#auth-student-id').setAttribute('inputmode', 'numeric');
  // 8 digits + 1 dash = 9 characters
  $('#auth-student-id').setAttribute('maxlength', '9');

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const error = $('#auth-error');
    const button = $('#auth-submit');
    const submittedMode = authMode;

    const studentIdInput = $('#auth-student-id');
    const nameInput = $('#auth-name');
    const emailInput = $('#auth-email');
    const passwordInput = $('#auth-password');

    const studentId = studentIdInput.value.trim();
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    error.hidden = true;
    clearAllFieldErrors($('#auth-form'));

    // ----- missing fields: show a specific message on each empty one -----
    const required = submittedMode === 'signup'
      ? [
        [studentIdInput, studentId],
        [nameInput, name],
        [emailInput, email],
        [passwordInput, password]
      ]
      : [
        [emailInput, email],
        [passwordInput, password]
      ];

    const missing = required.filter(([, value]) => !value);

    if (missing.length) {
      missing.forEach(([input]) => showFieldError(input));
      missing[0][0].focus();
      return;
    }

    // Student ID must be exactly 0000-1000 (sign up only)
    if (submittedMode === 'signup' && !STUDENT_ID_RE.test(studentId)) {
      showFieldError(studentIdInput, STUDENT_ID_MESSAGE);
      studentIdInput.focus();
      return;
    }

    if (submittedMode === 'signup' && !NAME_RE.test(name)) {
      showFieldError(nameInput, NAME_MESSAGE);
      nameInput.focus();
      return;
    }

    if (!EMAIL_RE.test(email)) {
      showFieldError(emailInput, EMAIL_MESSAGE);
      emailInput.focus();
      return;
    }

    // Only enforce the minimum length on sign up. On login, a wrong
    // password should just fail with the server's generic message.
    if (submittedMode === 'signup' && password.length < PASSWORD_MIN_LENGTH) {
      showFieldError(passwordInput, PASSWORD_MESSAGE);
      passwordInput.focus();
      return;
    }

    button.disabled = true;
    button.textContent = 'Please wait...';

    try {
      // ===== SIGN UP: create the account, then go to the sign-in form =====
      if (submittedMode === 'signup') {
        await api('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            student_id: studentId,
            name,
            email,
            password
          })
        });

        // If the server signs the new user in automatically, end that
        // session so the person must log in on their own.
        try {
          await api('/api/auth/logout', { method: 'POST', body: '{}' });
        } catch (ignored) {
          // No session to end; nothing to do.
        }

        // Switch to the sign-in form and keep the email filled in.
        setAuthMode('login');
        $('#auth-email').value = email;
        $('#auth-password').focus();

        showToast('Account created successfully! Please sign in.');
        return;
      }

      // ===== LOGIN =====
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      const userData = await api('/api/auth/me');

      // Admins use the same form and are sent to the admin page.
      if (userData.role === 'admin') {
        // BACK: replace() so the login page isn't kept in history
        window.location.replace('/admin');
        return;
      }

      if (userData.role !== 'participant' || !userData.user) {
        throw new Error('This account cannot sign in here.');
      }

      currentUser = userData.user;

      await loadData();

      // BACK: start every login on the dashboard, and record it in history
      activeTab = 'dashboard';
      history.replaceState({ tab: 'dashboard' }, '', '#dashboard');

      showApp();
      renderAll();

      showToast(`Login successful! Welcome, ${currentUser.name || 'participant'}.`);

      setAuthMode('login');
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      showToast(err.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = authMode === 'signup' ? 'Create Account' : 'Login';
    }
  });

  // Helper for the custom Logout Confirmation Dialog
  function confirmUserLogout() {
    return new Promise((resolve) => {
      const modal = $('#user-confirm-modal');
      const okBtn = $('#user-logout-ok-btn');
      const cancelBtn = $('#user-logout-cancel-btn');

      if (!modal || !okBtn || !cancelBtn) {
        // Fall back to the native confirm if the modal element is missing
        resolve(confirm('Are you sure you want to log out?'));
        return;
      }

      modal.hidden = false;
      okBtn.focus();

      function finish(result) {
        modal.hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        modal.removeEventListener('click', onOverlay);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }

      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onOverlay = (e) => { if (e.target === modal) finish(false); };
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      modal.addEventListener('click', onOverlay);
      document.addEventListener('keydown', onKey);
    });
  }

  // BACK: one logout function for both Logout buttons.
  // No toast and no delay: log out, then go straight to the sign-in page.
  // replace() keeps the logged-in page out of the history.
  async function logout() {
    try {
      stopNotificationPolling();
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
      window.location.replace('/');
    } catch (error) {
      showToast(error.message || 'Unable to log out.', 'error');
    }
  }

  // Sidebar Logout Button with confirmation modal
  $('#sidebar-logout-btn').addEventListener('click', async () => {
    const confirmed = await confirmUserLogout();
    if (!confirmed) return;
    await logout();
  });

  async function loadData() {
    const [eventData, categoryData, registrationData, notificationData] = await Promise.all([
      api('/api/events'),
      api('/api/categories'),
      api('/api/my-registrations'),
      api('/api/notifications').catch(() => ({ items: [], unread: 0 }))
    ]);

    events = Array.isArray(eventData) ? eventData : [];
    categories = Array.isArray(categoryData) ? categoryData : [];
    registrations = Array.isArray(registrationData) ? registrationData : [];
    notifications = Array.isArray(notificationData.items) ? notificationData.items : [];
    unreadCount = Number(notificationData.unread || 0);
  }

  // Browse Events shows upcoming events only.
  function getFilteredEvents() {
    return events.filter((event) => {
      if (isEventFinished(event)) return false;

      const categoryMatches =
        activeCategory === 'All' || event.category === activeCategory;

      const searchable = [
        event.title,
        event.location,
        event.category,
        event.description
      ].join(' ').toLowerCase();

      return categoryMatches &&
        (!searchTerm || searchable.includes(searchTerm.toLowerCase()));
    }).sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  function eventCard(event) {
    const registered = Number(event.registered || 0);
    const capacity = Number(event.capacity || 0);
    const spots = Math.max(0, capacity - registered);
    const finished = isEventFinished(event);
    const full = spots <= 0;

    const stubPrice = finished ? 'ENDED' : (full ? 'FULL' : 'OPEN');
    const stubSpots = finished
      ? 'Registration closed'
      : (full ? 'No slots left' : `${spots} slots left`);
    const badge = finished
      ? 'EVENT FINISHED'
      : (full ? 'FULLY BOOKED' : 'REGISTER NOW');

    return `
      <article class="ticket-card ${full || finished ? 'sold-out' : ''}"
        data-event-id="${escapeHtml(event.id)}"
        ${finished ? 'data-finished="true"' : ''}>
        <div class="ticket-main">
          <span class="cat-tag">${escapeHtml(event.category || 'Event')}</span>
          <h3 class="ticket-title">${escapeHtml(event.title)}</h3>
          <div class="ticket-meta">
            <div>📅 ${escapeHtml(fmtDate(event.date))} · ${escapeHtml(event.time || 'Time TBA')}</div>
            <div>📍 ${escapeHtml(event.location || 'Location TBA')}</div>
          </div>
          <div class="ticket-desc">${escapeHtml(event.description || '')}</div>
        </div>
        <div class="ticket-stub">
          <div class="stub-label">REGISTRATION</div>
          <div class="stub-price">${stubPrice}</div>
          <div class="stub-spots">${stubSpots}</div>
          <div class="admit-badge">${badge}</div>
        </div>
      </article>
    `;
  }

  function renderStats() {
    // Only upcoming events count as "available".
    const statEvents = $('#stat-events');
    if (statEvents) {
      statEvents.textContent = events.filter(
        event => !isEventFinished(event)
      ).length;
    }

    const statMine = $('#stat-mine');
    if (statMine) {
      statMine.textContent = registrations.length;
    }
  }

  function renderFilters() {
    const options = ['All', ...categories];

    if (!options.includes(activeCategory)) {
      activeCategory = 'All';
    }

    $('#filters-row').innerHTML = `
      <div class="filters">
        ${options.map(category => `
          <button type="button"
            class="chip ${category === activeCategory ? 'active' : ''}"
            data-category="${escapeHtml(category)}">
            ${escapeHtml(category)}
          </button>
        `).join('')}
      </div>
    `;

    $('#filters-row').querySelectorAll('[data-category]').forEach(button => {
      button.addEventListener('click', () => {
        activeCategory = button.dataset.category;
        renderFilters();
        renderEvents();
      });
    });
  }

  function attachEventCardHandlers(container) {
    container.querySelectorAll('[data-event-id]').forEach(card => {
      card.addEventListener('click', () => {
        const selectedEvent = events.find(
          item => String(item.id) === String(card.dataset.eventId)
        );

        if (!selectedEvent) return;

        // Finished events cannot be opened.
        if (isEventFinished(selectedEvent)) {
          showToast('This event has already finished.', 'error');
          return;
        }

        openRegistrationModal(selectedEvent);
      });
    });
  }

  function renderEvents() {
    const list = getFilteredEvents();

    $('#events-count').textContent =
      `${list.length} event${list.length === 1 ? '' : 's'}`;

    $('#grid').innerHTML = list.length
      ? list.map(eventCard).join('')
      : '<div class="empty-state" style="grid-column:1/-1">No events found. Try another search or category.</div>';

    attachEventCardHandlers($('#grid'));
  }

  function renderMine() {
    const sorted = [...registrations].sort((a, b) =>
      new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0)
    );

    $('#mine-list').innerHTML = sorted.length
      ? sorted.map(registration => {
        const event = events.find(
          item => String(item.id) === String(registration.eventId)
        );
        const date = event
          ? `${fmtDate(event.date)} · ${event.time || ''}`
          : 'Event details unavailable';

        const status = String(
          registration.attendanceStatus || 'registered'
        ).toLowerCase();

        // The "absent" label is not shown in My Registrations.
        const showStatus = status !== 'absent';

        // No cancelling once attended, marked absent, or the event finished.
        const canCancel =
          status !== 'attended' &&
          status !== 'absent' &&
          !isEventFinished(event);

        return `
            <div class="my-ticket-row">
              <div>
                <div class="mt-title">
                  ${escapeHtml(registration.eventTitle || event?.title || 'Event')}
                </div>
                <div class="mt-sub">${escapeHtml(date)}</div>
                <div class="mt-sub">
                  ${escapeHtml(registrationDetails(registration))}
                </div>
                ${showStatus
            ? `<div class="attendance-status">${escapeHtml(status.toUpperCase())}</div>`
            : ''}
              </div>
              ${canCancel ? `
                <button type="button" class="btn btn-ghost"
                  data-cancel-id="${escapeHtml(registration.id)}">
                  Cancel Registration
                </button>
              ` : ''}
            </div>
          `;
      }).join('')
      : '<div class="empty-state">No registrations yet. Browse events to register for a free spot.</div>';

    $('#mine-list').querySelectorAll('[data-cancel-id]').forEach(button => {
      button.addEventListener('click', async () => {
        if (!confirm('Cancel this registration?')) return;

        button.disabled = true;

        try {
          await api(
            `/api/registrations/${encodeURIComponent(button.dataset.cancelId)}/cancel`,
            { method: 'POST', body: '{}' }
          );

          await loadData();
          renderAll();
          showToast('Registration cancelled.');
        } catch (error) {
          showToast(error.message, 'error');
          button.disabled = false;
        }
      });
    });
  }

  function renderProfile() {
    const name = currentUser?.name || 'Participant';
    const studentId = currentUser?.student_id || currentUser?.studentId || '';
    const email = currentUser?.email || '';
    const label = classLabel(currentUser);

    const courseOptions = COURSES.map(course => `
      <option value="${course}" ${currentUser?.course === course ? 'selected' : ''}>${course}</option>
    `).join('');

    const yearOptions = YEAR_LEVELS.map(year => `
      <option value="${year}" ${currentUser?.year === year ? 'selected' : ''}>${year}</option>
    `).join('');

    $('#profile-content').innerHTML = `
      <div class="profile-card">
        <div class="profile-avatar">👤</div>
        <div class="profile-details">
          <span class="dashboard-card-label">PARTICIPANT ACCOUNT</span>
          <h3>${escapeHtml(name)}</h3>
          <p><strong>Student ID:</strong> ${escapeHtml(studentId || 'Not available')}</p>
          <p><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p><strong>Class:</strong> ${label ? escapeHtml(label) : 'Not set yet'}</p>
          <div class="profile-meta">Registrations: ${registrations.length}</div>
          <p class="profile-note">
            Your account information is used for your event registrations.
          </p>
        </div>
      </div>

      <div class="admin-panel" style="margin-top: 20px;">
        <span class="dashboard-card-label">CLASS INFORMATION</span>
        <h3>Course, Year &amp; Section</h3>
        <p class="profile-note" style="margin: 0 0 16px; color: var(--muted);">
          Save this once. It is used automatically whenever you register for an event.
        </p>

        <form id="profile-form" novalidate>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px;">
            <div class="field">
              <label for="profile-course">Course</label>
              <select id="profile-course">
                <option value="">Select your course</option>
                ${courseOptions}
              </select>
            </div>

            <div class="field">
              <label for="profile-year">Year Level</label>
              <select id="profile-year">
                <option value="">Select year level</option>
                ${yearOptions}
              </select>
            </div>

            <div class="field">
              <label for="profile-section">Section</label>
              <input id="profile-section" type="text" maxlength="5"
                placeholder="e.g. A" autocomplete="off"
                value="${escapeHtml(currentUser?.section || '')}">
            </div>
          </div>

          <button type="submit" class="btn btn-gold" id="profile-save">
            Save Profile
          </button>
        </form>
      </div>
    `;

    const form = $('#profile-form');

    form.addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();

      const courseInput = $('#profile-course');
      const yearInput = $('#profile-year');
      const sectionInput = $('#profile-section');
      const button = $('#profile-save');

      const course = courseInput.value;
      const year = yearInput.value;
      const section = sectionInput.value.trim().toUpperCase();

      clearAllFieldErrors(form);

      const missing = [];
      if (!course) missing.push(courseInput);
      if (!year) missing.push(yearInput);
      if (!section) missing.push(sectionInput);

      if (missing.length) {
        missing.forEach(input => showFieldError(input));
        missing[0].focus();
        return;
      }

      if (!/^[A-Za-z0-9]{1,5}$/.test(section)) {
        showFieldError(sectionInput, 'Section can only contain letters or numbers.');
        sectionInput.focus();
        return;
      }

      button.disabled = true;
      button.textContent = 'Saving...';

      try {
        const data = await api('/api/profile', {
          method: 'PUT',
          body: JSON.stringify({ course, year, section })
        });

        currentUser = data.user;
        renderProfile();
        showToast(`Profile saved! You are now ${classLabel(currentUser)}.`);
      } catch (err) {
        showToast(err.message, 'error');
        button.disabled = false;
        button.textContent = 'Save Profile';
      }
    });
  }

  function renderAttended() {
    const attended = registrations.filter(
      registration =>
        String(registration.attendanceStatus || '').toLowerCase() === 'attended'
    );

    $('#attended-list').innerHTML = attended.length
      ? attended.map(registration => {
        const event = events.find(
          item => String(item.id) === String(registration.eventId)
        );

        return `
            <div class="my-ticket-row">
              <div>
                <div class="mt-title">
                  ${escapeHtml(registration.eventTitle || event?.title || 'Event')}
                </div>
                <div class="mt-sub">
                  ${event
            ? escapeHtml(`${fmtDate(event.date)} · ${event.time || ''}`)
            : 'Event details unavailable'}
                </div>
              </div>
              <span class="attendance-status">ATTENDED</span>
            </div>
          `;
      }).join('')
      : '<div class="empty-state">Your attended events will appear here after the admin records your attendance.</div>';
  }

  // ----- notifications (bell at the top right) -----
  const NOTIF_ICONS = {
    event_created: '📅',
    event_updated: '✏️',
    event_cancelled: '⚠️',
    reminder: '⏰',
    registration: '✅',
    registration_cancelled: '↩️',
    waitlist_promoted: '🎉'
  };

  function fmtWhen(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-PH', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  function renderNotificationBadge() {
    const badge = $('#notif-badge');
    const bell = $('#notif-bell');
    if (!badge || !bell) return;

    badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    badge.hidden = unreadCount <= 0;
    bell.classList.toggle('has-unread', unreadCount > 0);
    bell.setAttribute(
      'aria-label',
      unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'
    );
  }

  function renderNotifications() {
    renderNotificationBadge();

    const readAll = $('#notif-read-all');
    if (readAll) readAll.hidden = unreadCount <= 0;

    $('#notifications-list').innerHTML = notifications.length
      ? notifications.map(n => `
          <div class="notif-item ${n.isRead ? '' : 'unread'}"
            data-notif-id="${escapeHtml(n.id)}">
            <div class="notif-icon">${NOTIF_ICONS[n.type] || '🔔'}</div>
            <div class="notif-body">
              <div class="notif-msg">${escapeHtml(n.message)}</div>
              <div class="notif-time">${escapeHtml(fmtWhen(n.createdAt))}</div>
            </div>
            ${n.isRead ? '' : '<span class="notif-dot" aria-label="Unread"></span>'}
          </div>
        `).join('')
      : '<div class="notif-empty">No notifications yet.<br>New events, updates and reminders will show up here.</div>';
  }

  // ----- bell: open / close the dropdown -----
  function setNotifPanel(open) {
    const panel = $('#notif-panel');
    const bell = $('#notif-bell');
    if (!panel || !bell) return;
    panel.hidden = !open;
    bell.setAttribute('aria-expanded', String(open));
  }

  $('#notif-bell').addEventListener('click', (event) => {
    event.stopPropagation();
    setNotifPanel($('#notif-panel').hidden);
  });

  // click outside closes it (ignore clicks on items that were just re-rendered)
  document.addEventListener('click', (event) => {
    if (!event.target.isConnected) return;
    const wrap = $('#notif-wrap');
    if (wrap && !wrap.contains(event.target)) setNotifPanel(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setNotifPanel(false);
  });

  // shake the bell when a new notification arrives
  function ringBell() {
    const bell = $('#notif-bell');
    if (!bell) return;
    bell.classList.remove('ring');
    void bell.offsetWidth; // restart the animation
    bell.classList.add('ring');
  }

  // Click one notification to mark it as read.
  $('#notifications-list').addEventListener('click', async (event) => {
    const item = event.target.closest('[data-notif-id]');
    if (!item) return;

    const note = notifications.find(n => String(n.id) === item.dataset.notifId);
    if (!note || note.isRead) return;

    try {
      await api(`/api/notifications/${encodeURIComponent(note.id)}/read`, {
        method: 'POST',
        body: '{}'
      });
      note.isRead = true;
      unreadCount = Math.max(0, unreadCount - 1);
      renderNotifications();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  $('#notif-read-all').addEventListener('click', async () => {
    try {
      await api('/api/notifications/read-all', { method: 'POST', body: '{}' });
      notifications.forEach(n => { n.isRead = true; });
      unreadCount = 0;
      renderNotifications();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  // Check for new notifications every 30 seconds while logged in.
  async function refreshNotifications() {
    try {
      const before = unreadCount;
      const data = await api('/api/notifications');
      notifications = Array.isArray(data.items) ? data.items : [];
      unreadCount = Number(data.unread || 0);
      renderNotifications();

      if (unreadCount > before) {
        ringBell();
        showToast('You have a new notification.');
        // a new event or an update: refresh the lists too
        await loadData();
        renderStats();
        renderEvents();
        renderMine();
        renderAttended();
      }
    } catch (error) {
      // ignore; the next check will try again
    }
  }

  function stopNotificationPolling() {
    if (notifTimer) {
      clearInterval(notifTimer);
      notifTimer = null;
    }
  }

  function startNotificationPolling() {
    stopNotificationPolling();
    notifTimer = setInterval(refreshNotifications, 30000);
  }

  function updateActiveTab() {
    const views = {
      dashboard: '#dashboard-view',
      events: '#events-view',
      mine: '#mine-view',
      profile: '#profile-view',
      attended: '#attended-view'
    };

    Object.entries(views).forEach(([tab, selector]) => {
      $(selector).hidden = activeTab !== tab;
    });

    document.querySelectorAll('[data-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.tab === activeTab);
    });

    const titles = {
      dashboard: 'Dashboard',
      events: 'Browse Events',
      mine: 'My Registrations',
      profile: 'My Profile',
      attended: 'Attended Events'
    };

    $('#search-wrap').hidden = activeTab !== 'events';
    $('#welcome-banner').hidden = activeTab !== 'dashboard';
  }

  // BACK: switch tab and record it in browser history.
  // nav = "push"    -> new history entry (default)
  //       "replace" -> overwrite the current entry
  function setTab(tab, { nav = 'push' } = {}) {
    if (!VALID_TABS.includes(tab)) tab = 'dashboard';

    if (nav === 'replace') {
      history.replaceState({ tab }, '', '#' + tab);
    } else if (tab !== activeTab) {
      history.pushState({ tab }, '', '#' + tab);
    }

    activeTab = tab;
    updateActiveTab();
  }

  // BACK: browser Back / Forward
  window.addEventListener('popstate', (event) => {
    // Close the registration popup, the logout dialog and the bell if open
    $('#modal-root').innerHTML = '';
    const logoutModal = $('#user-confirm-modal');
    if (logoutModal) logoutModal.hidden = true;
    setNotifPanel(false);

    // Only switch tabs while someone is logged in
    if (!currentUser) return;

    const wanted = (event.state && event.state.tab) || location.hash.slice(1);
    activeTab = VALID_TABS.includes(wanted) ? wanted : 'dashboard';
    updateActiveTab();
  });

  function renderAll() {
    renderStats();
    renderFilters();
    renderEvents();
    renderMine();
    renderProfile();
    renderAttended();
    renderNotifications();
    updateActiveTab();
  }

  // Logout from the topbar user name button (if it exists).
  // Uses the same confirm dialog + logout() as the sidebar button.
  const headerLogoutBtn = document.getElementById('header-logout-btn');

  if (headerLogoutBtn) {
    headerLogoutBtn.addEventListener('click', async () => {
      const confirmed = await confirmUserLogout();
      if (!confirmed) return;
      await logout();
    });
  }

  function openRegistrationModal(event) {
    // Finished events cannot be opened or registered for.
    if (isEventFinished(event)) {
      showToast('This event has already finished.', 'error');
      return;
    }

    const registered = Number(event.registered || 0);
    const capacity = Number(event.capacity || 0);
    const spots = Math.max(0, capacity - registered);

    if (spots <= 0) {
      showToast('This event has no slots left.', 'error');
      return;
    }

    const alreadyRegistered = registrations.some(
      item => String(item.eventId) === String(event.id)
    );

    if (alreadyRegistered) {
      showToast('You are already registered for this event.', 'error');
      return;
    }

    // The class information must be saved in My Profile first.
    if (!hasClassInfo(currentUser)) {
      showToast(
        'Please set your course, year level and section in My Profile first.',
        'error'
      );
      setTab('profile');
      return;
    }

    // Display the registration modal.
    $('#modal-root').innerHTML = `
      <div class="overlay" id="registration-overlay">
        <div class="modal">

          <div class="modal-head">
            <div>
              <h3>${escapeHtml(event.title)}</h3>
              <div class="sub">
                ${escapeHtml(fmtDate(event.date))} ·
                ${escapeHtml(event.time || 'Time TBA')} ·
                ${escapeHtml(event.location || 'Location TBA')}
              </div>
            </div>

            <button
              type="button"
              class="close-x"
              id="registration-close"
              aria-label="Close"
            >✕</button>
          </div>

          <div class="modal-body">

            <p>
              You will be registered using your saved profile details.
            </p>

            <!-- Saved student information -->
            <div style="
              margin-bottom:16px;
              padding:14px 16px;
              background:var(--page);
              border:1px solid var(--line);
              border-radius:10px;
            ">
              <div class="mt-title">
                ${escapeHtml(currentUser.name || '')}
              </div>

              <div class="mt-sub">
                ${escapeHtml(classLabel(currentUser))}
                · ${escapeHtml(currentUser.course || '')}
                · ${escapeHtml(currentUser.year || '')}
                · Section ${escapeHtml(currentUser.section || '')}
              </div>

              <div class="mt-sub">
                To change this information, update it in My Profile.
              </div>
            </div>

            <!-- Attendance confirmation -->
            <div class="field">
              <label>Will you attend this event?</label>

              <div
                id="registration-attending-group"
                style="
                  display:flex;
                  gap:24px;
                  margin-top:10px;
                "
              >
                <label style="
                  display:flex;
                  align-items:center;
                  gap:8px;
                  font-weight:600;
                  cursor:pointer;
                ">
                  <input
                    type="radio"
                    name="registration-attending"
                    value="yes"
                    style="width:auto;margin:0;"
                  >
                  Yes
                </label>

                <label style="
                  display:flex;
                  align-items:center;
                  gap:8px;
                  font-weight:600;
                  cursor:pointer;
                ">
                  <input
                    type="radio"
                    name="registration-attending"
                    value="no"
                    style="width:auto;margin:0;"
                  >
                  No
                </label>
              </div>
            </div>

            <!-- Registration buttons -->
            <div style="
              display:flex;
              justify-content:flex-end;
              gap:10px;
              margin-top:24px;
            ">
              <button
                type="button"
                class="btn btn-secondary"
                id="registration-cancel"
              >
                Cancel
              </button>

              <button
                type="button"
                class="btn btn-primary"
                id="registration-submit"
              >
                Confirm Registration
              </button>
            </div>

          </div>
        </div>
      </div>
    `;

    const overlay = $('#registration-overlay');
    const closeButton = $('#registration-close');
    const cancelButton = $('#registration-cancel');
    const submitButton = $('#registration-submit');

    // Close the modal.
    function closeRegistrationModal() {
      $('#modal-root').innerHTML = '';
    }

    closeButton.addEventListener('click', closeRegistrationModal);
    cancelButton.addEventListener('click', closeRegistrationModal);

    // Close when clicking outside the modal.
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        closeRegistrationModal();
      }
    });

    // Confirm registration.
    submitButton.addEventListener('click', async function () {
      const attendingInput = document.querySelector(
        'input[name="registration-attending"]:checked'
      );

      if (!attendingInput) {
        showToast(
          'Please select whether you will attend this event.',
          'error'
        );
        return;
      }

      const attending = attendingInput.value;

      submitButton.disabled = true;
      submitButton.textContent = 'Processing...';

      try {
        const response = await api(
          `/api/events/${event.id}/register`,
          {
            method: 'POST',
            body: JSON.stringify({ attending })
          }
        );

        if (response && response.error) {
          throw new Error(response.error);
        }

        showToast(
          attending === 'yes'
            ? 'Successfully registered for the event!'
            : 'Your response has been recorded.',
          'success'
        );

        closeRegistrationModal();

        // Refresh the data AND the screen so the registration count,
        // My Registrations list, event slots and notifications
        // update right away.
        await loadData();
        renderAll();

      } catch (error) {
        console.error('Registration error:', error);

        showToast(
          error.message || 'Unable to complete registration.',
          'error'
        );

        submitButton.disabled = false;
        submitButton.textContent = 'Confirm Registration';
      }
    });
  }

  // BACK: sidebar and dashboard links go through setTab()
  document.querySelectorAll('.side-link').forEach(button => {
    button.addEventListener('click', () => {
      setTab(button.dataset.tab);
    });
  });

  document.querySelectorAll('[data-go-tab]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      setTab(button.dataset.goTab);
    });
  });

  $('#search').addEventListener('input', event => {
    searchTerm = event.target.value.trim();
    renderEvents();
  });

  async function init() {
    setAuthMode('login');

    try {
      const data = await api('/api/auth/me');

      if (data.role === 'admin') {
        // BACK: replace() so this page isn't kept in history
        window.location.replace('/admin');
        return;
      }

      if (data.role === 'participant' && data.user) {
        currentUser = data.user;
        await loadData();

        // BACK: open the tab named in the URL (so refresh keeps your place)
        const fromHash = location.hash.slice(1);
        activeTab = VALID_TABS.includes(fromHash) ? fromHash : 'dashboard';
        history.replaceState({ tab: activeTab }, '', '#' + activeTab);

        showApp();
        renderAll();
        return;
      }
    } catch (error) {
      // No active session; show the login form.
    }

    showAuth();
  }

  init();
})();
/* Settings > Database Backup (admin page).
   Load it AFTER admin.js:
   <script src="{{ url_for('static', filename='backup.js') }}"></script> */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);

  const EXPORT_URL = '/api/admin/backup/export';
  const IMPORT_URL = '/api/admin/backup/import';
  const MAX_MB = 25;

  const view = $('[data-view="settings"]');
  if (!view) return;

  const settingsNav = $('.nav-item[data-tab="settings"]');
  const exportBtn = $('#backup-export-btn');
  const importBtn = $('#backup-import-btn');
  const fileInput = $('#backup-file');
  const drop = $('#backup-drop');
  const fileLabel = $('#backup-file-label');
  const message = $('#backup-message');

  const DEFAULT_LABEL = 'Click to choose or drop a .sql file here';

  /* ------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------ */
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function toast(text, type = 'success') {
    const root = $('#toast-container');
    if (!root) return;

    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = type === 'error' ? '✕' : '✓';

    const body = document.createElement('span');
    body.className = 'toast-text';
    body.textContent = text;

    el.append(icon, body);
    root.appendChild(el);

    setTimeout(() => {
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, 5000);
  }

  function setMessage(text, type = '') {
    message.textContent = text;
    message.className = 'message' + (type ? ' ' + type : '');
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ------------------------------------------------------------------
     Opening the Settings page from the sidebar
     (works next to admin.js without touching it)
     ------------------------------------------------------------------ */
  function showSettings() {
    document.querySelectorAll('.view').forEach((v) => {
      v.hidden = v !== view;
    });

    document.querySelectorAll('.nav-item').forEach((button) => {
      button.classList.toggle('active', button === settingsNav);
    });

    const title = $('#page-title');
    if (title) title.textContent = 'Settings';

    if (location.hash !== '#settings') {
      history.pushState(null, '', '#settings');
    }
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('.nav-item, [data-go]');
    if (!target) return;

    const goingToSettings = target === settingsNav;

    // run after admin.js has done its own switching
    setTimeout(() => {
      if (goingToSettings) showSettings();
      else view.hidden = true;
    }, 0);
  });

  window.addEventListener('hashchange', () => {
    if (location.hash === '#settings') showSettings();
  });

  window.addEventListener('load', () => {
    if (location.hash === '#settings') setTimeout(showSettings, 0);
  });

  /* ------------------------------------------------------------------
     EXPORT
     ------------------------------------------------------------------ */
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    const original = exportBtn.textContent;
    exportBtn.textContent = 'Exporting...';
    setMessage('');

    try {
      const response = await fetch(EXPORT_URL, { credentials: 'same-origin' });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Export failed. Please try again.');
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match ? match[1] : 'database_backup.sql';

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast('Database exported successfully.');
      setMessage(`Exported "${filename}" (${formatSize(blob.size)}).`, 'success');
    } catch (error) {
      toast(error.message, 'error');
      setMessage(error.message, 'error');
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = original;
    }
  });

  /* ------------------------------------------------------------------
     IMPORT: choose file (click or drag and drop)
     ------------------------------------------------------------------ */
  function clearFile() {
    fileInput.value = '';
    fileLabel.textContent = DEFAULT_LABEL;
    drop.classList.remove('has-file');
    importBtn.disabled = true;
  }

  function chooseFile(file) {
    setMessage('');

    if (!file) {
      clearFile();
      return;
    }

    if (!file.name.toLowerCase().endsWith('.sql')) {
      clearFile();
      toast('Please choose a .sql file.', 'error');
      return;
    }

    if (file.size > MAX_MB * 1024 * 1024) {
      clearFile();
      toast(`The file is too large (limit is ${MAX_MB} MB).`, 'error');
      return;
    }

    fileLabel.textContent = `${file.name} (${formatSize(file.size)})`;
    drop.classList.add('has-file');
    importBtn.disabled = false;
  }

  fileInput.addEventListener('change', () => chooseFile(fileInput.files[0]));

  ['dragenter', 'dragover'].forEach((name) => {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.add('is-over');
    });
  });

  ['dragleave', 'drop'].forEach((name) => {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.remove('is-over');
    });
  });

  drop.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (!file) return;

    // put the dropped file into the input so the form value stays in sync
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    chooseFile(file);
  });

  /* ------------------------------------------------------------------
     IMPORT: confirmation dialog + upload
     ------------------------------------------------------------------ */
  function confirmImport(fileName) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'details-overlay';
      overlay.innerHTML = `
        <div class="details-modal confirm-modal" role="alertdialog" aria-modal="true">
          <h2>Import database?</h2>
          <p>
            This replaces the current data with the contents of
            <strong>${escapeHtml(fileName)}</strong>.
            A safety copy of the current database is saved on the server first.
          </p>
          <div class="details-footer">
            <button type="button" class="btn btn-outline" data-act="cancel">Cancel</button>
            <button type="button" class="btn btn-danger" data-act="ok">Yes, import</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);
      overlay.querySelector('[data-act="ok"]').focus();

      function finish(result) {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(result);
      }

      function onKey(event) {
        if (event.key === 'Escape') finish(false);
      }

      document.addEventListener('keydown', onKey);

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) finish(false);
        const act = event.target.closest('[data-act]');
        if (act) finish(act.dataset.act === 'ok');
      });
    });
  }

  importBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    const confirmed = await confirmImport(file.name);
    if (!confirmed) return;

    importBtn.disabled = true;
    const original = importBtn.textContent;
    importBtn.textContent = 'Importing...';
    setMessage('Importing... please do not close this page.');

    try {
      const body = new FormData();
      body.append('file', file);

      // no Content-Type header: the browser sets it for the file upload
      const response = await fetch(IMPORT_URL, {
        method: 'POST',
        credentials: 'same-origin',
        body
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || 'Import failed. Please try again.');
      }

      const extra = data.safety_backup
        ? ` Your previous data was saved as backups/${data.safety_backup}.`
        : '';

      toast('Database imported successfully.');
      setMessage(
        `Import complete (${data.statements} statements ran).${extra} Reloading...`,
        'success'
      );

      clearFile();
      setTimeout(() => location.reload(), 2500);
    } catch (error) {
      toast(error.message, 'error');
      setMessage(error.message, 'error');
      importBtn.disabled = false;
    } finally {
      importBtn.textContent = original;
    }
  });
})();
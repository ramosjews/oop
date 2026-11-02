const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let allEvents = [];
let allParticipants = [];
let allRegistrations = [];
let editingEventId = null;

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `Request failed (${response.status})`);
  }
  return data;
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.users)) return data.users;
  if (Array.isArray(data.registrations)) return data.registrations;
  return [];
}

function showMessage(id, message, type = "") {
  const element = $("#" + id);
  if (!element) return;
  element.textContent = message;
  element.className = "message" + (type ? " " + type : "");
}

function showToast(message, type = "success", duration = 4000) {
  const container = $("#toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "toast" + (type === "error" ? " error" : "");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = type === "error" ? "✕" : "✓";

  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.textContent = "✕";

  toast.append(icon, text, close);
  container.appendChild(toast);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };
  close.addEventListener("click", dismiss);
  timer = setTimeout(dismiss, duration);
}

function confirmDialog({
  title = "Confirm",
  message = "",
  confirmText = "Confirm",
  cancelText = "Cancel"
} = {}) {
  return new Promise((resolve) => {
    const modal = $("#confirm-modal");
    const okBtn = $("#confirm-ok-btn");
    const cancelBtn = $("#confirm-cancel-btn");
    const previousFocus = document.activeElement;

    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    modal.hidden = false;
    okBtn.focus();

    function finish(result) {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKey);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      resolve(result);
    }

    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onOverlay = (e) => { if (e.target === modal) finish(false); };
    const onKey = (e) => { if (e.key === "Escape") finish(false); };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
  });
}

function setView(viewName) {
  $$(".view").forEach(view => {
    view.hidden = view.dataset.view !== viewName;
  });

  $$(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.tab === viewName);
  });

  const titles = {
    dashboard: "Dashboard",
    "add-event": "Add Event",
    events: "Events",
    finished: "Finished Events",
    participants: "Participants",
    registrations: "Registrations",
    attendance: "Attendance"
  };

  const pageTitle = $("#page-title");
  if (pageTitle) pageTitle.textContent = titles[viewName] || "Dashboard";

  if (viewName === "dashboard") loadDashboard();
  if (viewName === "events") loadEvents();
  if (viewName === "finished") loadFinished();
  if (viewName === "participants") loadParticipants();
  if (viewName === "registrations") loadRegistrations();
  if (viewName === "attendance") loadAttendance();
}

$$(".nav-item").forEach(button => {
  button.addEventListener("click", () => {
    const view = button.dataset.tab;
    if (view === "add-event") openEventForm();
    else setView(view);
  });
});

$$("[data-go]").forEach(button => {
  button.addEventListener("click", () => {
    const view = button.dataset.go;
    if (view === "add-event") openEventForm();
    else setView(view);
  });
});

const NEW_CATEGORY = "__new__";

function syncCategoryInput() {
  const select = $("#event-category");
  const input = $("#event-category-new");
  if (!select || !input) return;

  const adding = select.value === NEW_CATEGORY;
  input.hidden = !adding;
  input.required = adding;
  if (adding) input.focus();
  else input.value = "";
}

async function loadCategories(selected = "") {
  const select = $("#event-category");
  if (!select) return;

  let names = [];
  try {
    names = asArray(await api("/api/categories")).map(String);
  } catch (error) { }

  if (selected && !names.includes(selected)) names.push(selected);

  select.innerHTML =
    '<option value="">-- Select Existing Category --</option>' +
    names.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join("") +
    `<option value="${NEW_CATEGORY}">+ Add New Category...</option>`;

  select.value = selected || "";
  syncCategoryInput();
}

$("#event-category")?.addEventListener("change", syncCategoryInput);
$("#add-event-form")?.addEventListener("reset", () => setTimeout(syncCategoryInput, 0));

function getEventField(name) {
  const form = $("#add-event-form");
  return form.elements.namedItem(name);
}

function openEventForm(eventData = null) {
  const form = $("#add-event-form");
  if (!form) return;

  form.reset();
  loadCategories(eventData ? eventData.category : "");
  editingEventId = eventData ? eventData.id : null;

  const heading = $("#event-form-title");
  const button = $("#save-event-btn");

  if (eventData) {
    setView("add-event");
    if (heading) heading.textContent = "Edit Event";
    if (button) button.textContent = "Update Event";

    const fields = {
      title: eventData.title,
      category: eventData.category,
      date: String(eventData.date || "").slice(0, 10),
      time: eventData.time,
      location: eventData.location,
      capacity: eventData.capacity ?? 100,
      description: eventData.description
    };

    Object.entries(fields).forEach(([name, value]) => {
      const field = getEventField(name);
      if (field) field.value = value ?? "";
    });
    showMessage("event-form-message", "");
  } else {
    setView("add-event");
    if (heading) heading.textContent = "Create New Event";
    if (button) button.textContent = "Save Event";
    const capacityField = getEventField("capacity");
    if (capacityField) capacityField.value = 100;
    showMessage("event-form-message", "");
  }
}

async function loadDashboard() {
  try {
    const [eventsData, usersData, registrationsData] = await Promise.all([
      api("/api/events"),
      api("/api/admin/users"),
      api("/api/admin/registrations")
    ]);

    allEvents = asArray(eventsData);
    allParticipants = asArray(usersData);
    allRegistrations = asArray(registrationsData);

    $("#total-events").textContent = allEvents.length;
    $("#total-participants").textContent = allParticipants.filter(user => (user.role || "participant") !== "admin").length;
    $("#total-registrations").textContent = allRegistrations.length;
    $("#total-attendance").textContent = allRegistrations.filter(registration => registration.attendanceStatus === "attended").length;

    const upcoming = allEvents.filter(event => !event.isFinished);
    $("#dashboard-events").innerHTML = upcoming.length
      ? upcoming.slice(0, 4).map(event => eventCard(event, false)).join("")
      : '<div class="empty">No upcoming events.</div>';
  } catch (error) {
    $("#dashboard-events").innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

function eventCard(event, showActions = true) {
  const capacity = Number(event.capacity || 0);
  const registered = Number(event.registered || 0);

  return `
    <article class="event-card">
      <span class="event-category">${escapeHTML(event.category || "General")}</span>
      <h3>${escapeHTML(event.title || "Untitled event")}</h3>
      <p>
        <strong>Date:</strong> ${escapeHTML(event.date || "Not set")}<br>
        <strong>Time:</strong> ${escapeHTML(event.time || "Not set")}<br>
        <strong>Location:</strong> ${escapeHTML(event.location || "Not set")}<br>
        <strong>Registrations:</strong> ${registered} / ${capacity || "Unlimited"}
      </p>
      <p>${escapeHTML(event.description || "No description provided.")}</p>

      ${showActions ? `
        <div class="event-actions">
          ${event.isFinished ? "" : `
            <button type="button" class="btn btn-success" data-finish-event="${escapeHTML(event.id)}">✓ Mark as Done</button>
          `}
          <button type="button" class="btn btn-outline" onclick="window.open('/api/admin/events/${escapeHTML(event.id)}/attendance-sheet', '_blank')">📄 Attendance Sheet</button>
          <button type="button" class="btn btn-dark" data-edit-event="${escapeHTML(event.id)}">Edit</button>
          <button type="button" class="btn btn-danger" data-delete-event="${escapeHTML(event.id)}">Delete</button>
        </div>
      ` : ""}
    </article>
  `;
}

async function loadEvents() {
  const list = $("#events-list");
  list.innerHTML = '<div class="empty">Loading events...</div>';

  try {
    const [eventsData, registrationsData] = await Promise.all([
      api("/api/events"),
      api("/api/admin/registrations")
    ]);
    allEvents = asArray(eventsData);
    allRegistrations = asArray(registrationsData);
    renderEvents();
    showMessage("events-message", "");
  } catch (error) {
    list.innerHTML = '<div class="empty">Unable to load events.</div>';
    showMessage("events-message", error.message, "error");
  }
}

function renderEvents() {
  const search = ($("#event-search").value || "").toLowerCase().trim();
  const filtered = allEvents
    .filter(event => !event.isFinished)
    .filter(event =>
      [event.title, event.category, event.location, event.description].some(value =>
        String(value || "").toLowerCase().includes(search)
      )
    );

  $("#events-list").innerHTML = filtered.length
    ? filtered.map(event => eventCard(event, true)).join("")
    : '<div class="empty">No matching upcoming events found.</div>';
}

$("#event-search")?.addEventListener("input", renderEvents);
$("#refresh-events-btn")?.addEventListener("click", loadEvents);

$("#events-list")?.addEventListener("click", async (event) => {
  const finishButton = event.target.closest("[data-finish-event]");
  const editButton = event.target.closest("[data-edit-event]");
  const deleteButton = event.target.closest("[data-delete-event]");

  if (finishButton) {
    const eventId = finishButton.dataset.finishEvent;
    const current = allEvents.find(item => String(item.id) === String(eventId));
    if (!current) return;

    if (!confirm(`Mark "${current.title}" as finished? It will move to Finished Events.`)) return;

    try {
      await api(`/api/events/${encodeURIComponent(eventId)}/finish`, { method: "POST" });
      showMessage("events-message", "Event moved to Finished Events.", "success");
      await loadEvents();
      await loadDashboard();
    } catch (error) {
      showMessage("events-message", error.message, "error");
    }
    return;
  }

  if (editButton) {
    const eventId = editButton.dataset.editEvent;
    const current = allEvents.find(item => String(item.id) === String(eventId));
    if (!current) return;
    openEventForm(current);
    return;
  }

  if (deleteButton) {
    const eventId = deleteButton.dataset.deleteEvent;
    const current = allEvents.find(item => String(item.id) === String(eventId));
    if (!current) return;

    if (!confirm(`Delete "${current.title}"? This action cannot be undone.`)) return;

    try {
      await api(`/api/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
      showMessage("events-message", "Event deleted successfully.", "success");
      await loadEvents();
      await loadDashboard();
    } catch (error) {
      showMessage("events-message", error.message, "error");
    }
  }
});

$("#add-event-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#save-event-btn");
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  payload.capacity = Number(payload.capacity);
  if (payload.category === NEW_CATEGORY) {
    payload.category = $("#event-category-new").value.trim();
  }

  if (!String(payload.title || "").trim() || !Number.isInteger(payload.capacity) || payload.capacity < 1) {
    showMessage("event-form-message", "Please complete all required fields properly.", "error");
    return;
  }

  const isEditing = editingEventId !== null;
  const url = isEditing ? `/api/events/${encodeURIComponent(editingEventId)}` : "/api/events";
  const method = isEditing ? "PUT" : "POST";

  const confirmed = await confirmDialog({
    title: isEditing ? "Update this event?" : "Create this event?",
    message: isEditing ? `Save your changes to "${payload.title}"?` : `"${payload.title}" will be added to upcoming events.`,
    confirmText: isEditing ? "Yes, Update" : "Yes, Create"
  });
  if (!confirmed) return;

  button.disabled = true;
  button.textContent = isEditing ? "Updating..." : "Saving...";

  try {
    await api(url, { method, body: JSON.stringify(payload) });
    editingEventId = null;
    form.reset();
    await loadCategories();
    showToast(isEditing ? `"${payload.title}" updated successfully!` : `"${payload.title}" created successfully!`, "success");
    await loadDashboard();
    if (isEditing) setView("events");
  } catch (error) {
    showMessage("event-form-message", error.message, "error");
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = editingEventId !== null ? "Update Event" : "Save Event";
  }
});

function countAttended(eventId) {
  return allRegistrations.filter(registration =>
    String(registration.eventId) === String(eventId) &&
    registration.attendanceStatus === "attended"
  ).length;
}

function renderFinished() {
  const search = ($("#finished-search").value || "").toLowerCase().trim();
  const finished = allEvents
    .filter(event => event.isFinished)
    .filter(event => [event.title, event.category, event.location].some(value => String(value || "").toLowerCase().includes(search)))
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));

  $("#finished-table").innerHTML = finished.length
    ? finished.map(event => `
          <tr data-finished-id="${escapeHTML(event.id)}">
            <td>${escapeHTML(event.title || "—")}</td>
            <td>${escapeHTML(event.category || "—")}</td>
            <td>${escapeHTML(event.date || "—")} ${escapeHTML(event.time || "")}</td>
            <td>${escapeHTML(event.location || "—")}</td>
            <td>${escapeHTML(event.registered ?? 0)}</td>
            <td>${countAttended(event.id)}</td>
            <td><button type="button" class="btn btn-outline" data-view-finished="${escapeHTML(event.id)}">View Details</button></td>
          </tr>
        `).join("")
    : '<tr><td colspan="7">No finished events yet.</td></tr>';
}

async function loadFinished() {
  try {
    const [eventsData, registrationsData] = await Promise.all([
      api("/api/events"),
      api("/api/admin/registrations")
    ]);
    allEvents = asArray(eventsData);
    allRegistrations = asArray(registrationsData);
    renderFinished();
    showMessage("finished-message", "");
  } catch (error) {
    showMessage("finished-message", error.message, "error");
    $("#finished-table").innerHTML = '<tr><td colspan="7">Unable to load finished events.</td></tr>';
  }
}

$("#finished-search")?.addEventListener("input", renderFinished);
$("#refresh-finished-btn")?.addEventListener("click", loadFinished);

function detailItem(label, valueHTML, full = false) {
  return `
    <div class="detail-item${full ? " full" : ""}">
      <dt>${escapeHTML(label)}</dt>
      <dd>${valueHTML}</dd>
    </div>
  `;
}

let detailsReturnFocus = null;

function openFinishedDetails(eventId) {
  const current = allEvents.find(item => String(item.id) === String(eventId));
  if (!current) return;

  const capacity = Number(current.capacity || 0);
  const registered = Number(current.registered || 0);
  const finishedHow = current.finishedAt ? "Marked as done by admin on " + formatDateTime(current.finishedAt) : "Finished automatically";

  $("#details-title").textContent = current.title || "Untitled event";
  $("#details-body").innerHTML = [
    detailItem("Category", escapeHTML(current.category || "—")),
    detailItem("Date & Time", `${escapeHTML(current.date || "—")} | ${escapeHTML(current.time || "—")}`),
    detailItem("Location", escapeHTML(current.location || "—")),
    detailItem("Registered / Capacity", `${registered} / ${capacity || "Unlimited"}`),
    detailItem("Attended Count", `${countAttended(current.id)} Participant(s)`),
    detailItem("Status", escapeHTML(finishedHow), true),
    detailItem("Description", escapeHTML(current.description || "No description provided."), true),
    detailItem(
      "Attendance Sheet",
      `<div class="modal-action-row" style="margin-top: 0;">
         <button type="button" class="btn btn-gold print-btn" onclick="window.open('/api/admin/events/${escapeHTML(current.id)}/attendance-sheet', '_blank')">🖨️ Print Official Attendance Sheet</button>
       </div>`,
      true
    )
  ].join("");

  detailsReturnFocus = document.activeElement;
  $("#event-details-modal").hidden = false;
  $("#details-close-btn").focus();
}

function closeFinishedDetails() {
  $("#event-details-modal").hidden = true;
  if (detailsReturnFocus && typeof detailsReturnFocus.focus === "function") {
    detailsReturnFocus.focus();
  }
  detailsReturnFocus = null;
}

$("#finished-table")?.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-finished-id]");
  if (!row) return;
  openFinishedDetails(row.dataset.finishedId);
});

$("#details-close-btn")?.addEventListener("click", closeFinishedDetails);
$("#details-done-btn")?.addEventListener("click", closeFinishedDetails);

function fillSectionFilter(selectId, yearSelectId) {
  const select = $("#" + selectId);
  if (!select) return;

  const yearSelect = yearSelectId ? $("#" + yearSelectId) : null;
  const year = yearSelect ? yearSelect.value : "";
  const current = select.value;
  const sections = new Map();

  allRegistrations.forEach(registration => {
    if (year && registration.year !== year) return;
    const section = String(registration.section || "").trim();
    if (section && !sections.has(section.toLowerCase())) {
      sections.set(section.toLowerCase(), section);
    }
  });

  const sorted = [...sections.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  select.innerHTML =
    '<option value="">All Sections</option>' +
    sorted.map(section => `<option value="${escapeHTML(section)}">${escapeHTML(section)}</option>`).join("");

  const kept = sorted.find(section => section.toLowerCase() === current.toLowerCase());
  select.value = kept || "";
}

function matchesYearSection(registration, year, section) {
  if (year && (!registration || registration.year !== year)) return false;
  if (section) {
    const value = String(registration?.section || "").trim().toLowerCase();
    if (value !== section.toLowerCase()) return false;
  }
  return true;
}

/* ===================== PARTICIPANTS ===================== */

function renderParticipants() {
  const search = ($("#participant-search").value || "").toLowerCase().trim();

  const filtered = allParticipants
    .filter(user => (user.role || "participant") !== "admin")
    .filter(user =>
      [user.name, user.email, user.student_id, user.studentId, user.role].some(value =>
        String(value || "").toLowerCase().includes(search)
      )
    );

  $("#participants-table").innerHTML = filtered.length
    ? filtered.map(user => `
        <tr>
          <td>${escapeHTML(user.name || "—")}</td>
          <td>${escapeHTML(user.email || "—")}</td>
          <td>${escapeHTML(user.student_id || user.studentId || "—")}</td>
          <td>${escapeHTML(user.role || "participant")}</td>
          <td style="text-align: right;">
            <button type="button" class="btn btn-outline" style="padding: 4px 10px; font-size: 0.8rem; color: #e74c3c; border-color: #e74c3c;" data-delete-participant="${escapeHTML(user.id)}">Delete</button>
          </td>
        </tr>
      `).join("")
    : '<tr><td colspan="5">No participants found.</td></tr>';
}

async function loadParticipants() {
  try {
    const usersData = await api("/api/admin/users");
    allParticipants = asArray(usersData);
    renderParticipants();
    showMessage("participants-message", "");
  } catch (error) {
    showMessage("participants-message", error.message, "error");
    $("#participants-table").innerHTML = '<tr><td colspan="5">Unable to load participants.</td></tr>';
  }
}

$("#participant-search")?.addEventListener("input", renderParticipants);
$("#refresh-participants-btn")?.addEventListener("click", loadParticipants);

// Delete button in the Participants table
$("#participants-table")?.addEventListener("click", async (event) => {
  const deleteBtn = event.target.closest("[data-delete-participant]");
  if (!deleteBtn) return;

  const userId = deleteBtn.dataset.deleteParticipant;
  const current = allParticipants.find(item => String(item.id) === String(userId));
  const userName = current ? (current.name || "this student") : "this student";

  const confirmed = await confirmDialog({
    title: "Delete Student Account?",
    message: `Are you sure you want to delete ${userName}'s account? This action cannot be undone.`,
    confirmText: "Yes, Delete",
    cancelText: "Cancel"
  });

  if (!confirmed) return;

  deleteBtn.disabled = true;

  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
    showToast("Student account deleted successfully.", "success");
    await loadParticipants();
    await loadDashboard();
  } catch (error) {
    showToast(error.message || "Failed to delete student account.", "error");
    deleteBtn.disabled = false;
  }
});

/* ===================== REGISTRATIONS ===================== */

function fillEventFilter() {
  const select = $("#registration-event");
  if (!select) return;

  const current = select.value;
  const eventMap = new Map();
  allRegistrations.forEach(r => {
    if (r.eventId && r.eventTitle) {
      eventMap.set(String(r.eventId), r.eventTitle);
    }
  });

  const sortedEvents = [...eventMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));

  select.innerHTML =
    '<option value="">All Events</option>' +
    sortedEvents.map(([id, title]) => `<option value="${escapeHTML(id)}">${escapeHTML(title)}</option>`).join("");

  select.value = eventMap.has(current) ? current : "";
}

function renderRegistrations() {
  const search = ($("#registration-search").value || "").toLowerCase().trim();
  const eventFilter = $("#registration-event")?.value || "";
  const yearFilter = $("#registration-year").value;
  const sectionFilter = $("#registration-section").value;

  const filtered = allRegistrations
    .filter(registration => {
      if (eventFilter && String(registration.eventId) !== String(eventFilter)) return false;
      return matchesYearSection(registration, yearFilter, sectionFilter);
    })
    .filter(registration =>
      [registration.name, registration.email, registration.eventTitle, registration.student_id, registration.studentId, registration.course, registration.section, registration.year].some(value =>
        String(value || "").toLowerCase().includes(search)
      )
    );

  $("#registrations-table").innerHTML = filtered.length
    ? filtered.map(registration => `
        <tr>
          <td>${escapeHTML(registration.name || "—")}</td>
          <td>${escapeHTML(registration.email || "—")}</td>
          <td>${escapeHTML(registration.eventTitle || "—")}</td>
          <td>${escapeHTML(registration.course || "—")}</td>
          <td>${escapeHTML(registration.section || "—")}</td>
          <td>${escapeHTML(registration.year || "—")}</td>
          <td>${registration.attending === "no" ? "No" : "Yes"}</td>
          <td>${escapeHTML(formatDateTime(registration.registeredAt))}</td>
        </tr>
      `).join("")
    : '<tr><td colspan="8">No registrations found.</td></tr>';
}

async function loadRegistrations() {
  try {
    const [eventsData, registrationsData] = await Promise.all([
      api("/api/events"),
      api("/api/admin/registrations")
    ]);
    allEvents = asArray(eventsData);
    allRegistrations = asArray(registrationsData);

    fillEventFilter();
    fillSectionFilter("registration-section", "registration-year");
    renderRegistrations();
    showMessage("registrations-message", "");
  } catch (error) {
    showMessage("registrations-message", error.message, "error");
    $("#registrations-table").innerHTML = '<tr><td colspan="8">Unable to load registrations.</td></tr>';
  }
}

$("#registration-search")?.addEventListener("input", renderRegistrations);
$("#registration-event")?.addEventListener("change", renderRegistrations);
$("#registration-year")?.addEventListener("change", () => {
  fillSectionFilter("registration-section", "registration-year");
  renderRegistrations();
});
$("#registration-section")?.addEventListener("change", renderRegistrations);
$("#refresh-registrations-btn")?.addEventListener("click", loadRegistrations);

/* ===================== ATTENDANCE ===================== */

function renderAttendance() {
  const search = ($("#attendance-search").value || "").toLowerCase().trim();

  const activeRegistrations = allRegistrations.filter(registration => {
    const event = allEvents.find(e => String(e.id) === String(registration.eventId));
    if (!event || event.isFinished) return false;
    return true;
  });

  const filtered = activeRegistrations.filter(registration =>
    [registration.name, registration.email, registration.eventTitle].some(value =>
      String(value || "").toLowerCase().includes(search)
    )
  );

  $("#attendance-table").innerHTML = filtered.length
    ? filtered.map(registration => {
      const status = registration.attendanceStatus || "registered";
      const statusClass = status === "attended" ? "attended" : status === "absent" ? "absent" : "";
      const nextStatus = status === "attended" ? "absent" : "attended";
      const buttonLabel = status === "attended" ? "Mark Absent" : "Mark Attended";

      return `
          <tr>
            <td>${escapeHTML(registration.name || "—")}</td>
            <td>${escapeHTML(registration.eventTitle || "—")}</td>
            <td><span class="status ${statusClass}">${escapeHTML(status)}</span></td>
            <td>
              <button class="btn ${nextStatus === "attended" ? "btn-success" : "btn-danger"}"
                data-attendance-id="${escapeHTML(registration.id)}"
                data-next-status="${nextStatus}">
                ${buttonLabel}
              </button>
            </td>
          </tr>
        `;
    }).join("")
    : '<tr><td colspan="4">No active event registrations found.</td></tr>';
}

async function loadAttendance() {
  try {
    const [eventsData, registrationsData] = await Promise.all([
      api("/api/events"),
      api("/api/admin/registrations")
    ]);
    allEvents = asArray(eventsData);
    allRegistrations = asArray(registrationsData);

    renderAttendance();
    showMessage("attendance-message", "");
  } catch (error) {
    showMessage("attendance-message", error.message, "error");
    $("#attendance-table").innerHTML = '<tr><td colspan="4">Unable to load attendance.</td></tr>';
  }
}

$("#attendance-search")?.addEventListener("input", renderAttendance);
$("#refresh-attendance-btn")?.addEventListener("click", loadAttendance);

$("#attendance-table")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-attendance-id]");
  if (!button) return;

  try {
    await api(`/api/admin/registrations/${encodeURIComponent(button.dataset.attendanceId)}/attendance`, {
      method: "POST",
      body: JSON.stringify({ status: button.dataset.nextStatus })
    });
    showMessage("attendance-message", "Attendance updated.", "success");
    await loadAttendance();
    await loadDashboard();
  } catch (error) {
    showMessage("attendance-message", error.message, "error");
  }
});

$("#logout-btn")?.addEventListener("click", async () => {
  const confirmed = await confirmDialog({
    title: "Log out?",
    message: "You will need to sign in again to access the admin panel.",
    confirmText: "Yes, Log out"
  });
  if (!confirmed) return;

  try {
    await api("/api/admin/logout", { method: "POST" });
    showToast("You have been logged out successfully.", "success", 1500);
    setTimeout(() => { window.location.href = "/"; }, 1500);
  } catch (error) {
    showToast(error.message || "Unable to log out.", "error");
  }
});

loadCategories();
loadDashboard();
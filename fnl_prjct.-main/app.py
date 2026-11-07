"""
CCS Event Hub - refactored to apply the four pillars of OOP.

WHERE EACH PILLAR IS USED
-------------------------
1. ENCAPSULATION
   - BaseModel keeps its data in a private attribute (self.__data) and only
     exposes it through properties. Password hashes can never leak because
     there is no public way to read them (Participant.verify_password checks
     the hash internally).
   - Database hides the connection pool. Services hide the transactions.
   - EventForm validates input and exposes read-only properties.
   - RegistrationService keeps the waitlist private.

2. ABSTRACTION
   - Abstract base classes (ABC) define WHAT a thing must do, not HOW:
     BaseModel, Account, Event, Registration, Notification, Repository,
     Validator, AccessPolicy, EventForm, ReservationResult.

3. INHERITANCE
   - BaseModel -> Account -> Participant, Admin
   - BaseModel -> Event -> UpcomingEvent, ReopenedEvent, FinishedEvent
   - BaseModel -> Registration -> AttendingRegistration, DeclinedRegistration
   - Notification -> EventNotification -> EventCreated, EventCancelled, ...
   - Repository -> UserRepository, EventRepository, ...
   - ApiError -> ValidationError, NotFoundError, ConflictError, ...
   - EventForm -> CreateEventForm, UpdateEventForm

4. POLYMORPHISM
   - The same method call behaves differently depending on the object:
       event.is_finished()         (3 event types)
       registration.spots_used()   (2 registration types)
       account.to_public()         (Participant / Admin)
       account.start_session()     (Participant / Admin)
       account.verify_password()   (Participant / Admin)
       notification.message()      (7 notification types)
       validator.validate()        (5 validator types)
       policy.check()              (Participant / Admin policy)
       result.to_response()        (Registered / Waitlisted)
"""
import hmac
import os
import re
import uuid
from abc import ABC, abstractmethod
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from functools import wraps
from itertools import groupby

import mysql.connector
from mysql.connector import pooling
from flask import (
    Flask, jsonify, request, render_template, session, redirect
)
from werkzeug.security import generate_password_hash, check_password_hash

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # python-dotenv is optional
    pass

from backup_route import register_backup_routes
from dsa_features import merge_sort, WaitlistQueue


# =========================================================
# CONFIGURATION  (one class holds every setting)
# =========================================================
class AppConfig:
    ADMIN_EMAIL = os.environ.get(
        "ADMIN_EMAIL", "admin@ccs.local"
    ).strip().lower()
    ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "ccs2026")
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")
    COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"
    APP_TZ = timezone(
        timedelta(hours=float(os.environ.get("APP_UTC_OFFSET_HOURS", "8")))
    )
    DB = {
        "host": os.environ.get("DB_HOST", "127.0.0.1"),
        "port": int(os.environ.get("DB_PORT", "3306")),
        "user": os.environ.get("DB_USER", "event_admin"),
        "password": os.environ.get("DB_PASSWORD", "admin123"),
        "database": os.environ.get("DB_NAME", "event_hub"),
        "charset": "utf8mb4",
    }
    YEAR_LEVELS = ["1st Year", "2nd Year", "3rd Year", "4th Year"]
    COURSES = ["BSCS", "BSIT"]
    PROFILE_COLUMNS = {
        "course": "VARCHAR(100) NOT NULL DEFAULT ''",
        "section": "VARCHAR(30) NOT NULL DEFAULT ''",
        "year_level": "VARCHAR(20) NOT NULL DEFAULT ''",
    }


EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
STUDENT_ID_RE = re.compile(r"^\d+(?:-\d+)*$")
NAME_RE = re.compile(r"^[^\W\d_]+(?:[ .'’\-]+[^\W\d_]+)*\.?$")
SECTION_RE = re.compile(r"^[A-Za-z0-9]{1,5}$")

PAST_EVENT_ERROR = (
    "Events must be scheduled for the present or future, not in the past."
)
PROFILE_INCOMPLETE_ERROR = (
    "Please set your course, year level and section "
    "in My Profile before registering."
)


# =========================================================
# UTILITIES
# =========================================================
class TimeUtils:
    """Everything about dates and times in one place."""

    @staticmethod
    def local_now():
        return datetime.now(AppConfig.APP_TZ).replace(tzinfo=None)

    @staticmethod
    def utc_now():
        return datetime.now(timezone.utc).replace(tzinfo=None)

    @staticmethod
    def iso(value):
        """DATETIME (stored as UTC) -> ISO text the browser can parse."""
        if value is None:
            return None
        return value.replace(tzinfo=timezone.utc).isoformat()

    @staticmethod
    def format_time(value):
        """MySQL TIME comes back as timedelta. Return 'HH:MM'."""
        if value is None:
            return ""
        if isinstance(value, timedelta):
            total = int(value.total_seconds())
            return f"{total // 3600:02d}:{(total % 3600) // 60:02d}"
        if hasattr(value, "strftime"):
            return value.strftime("%H:%M")
        return str(value)[:5]

    @staticmethod
    def parse_date(text):
        return datetime.strptime(text, "%Y-%m-%d").date()

    @staticmethod
    def parse_time(text):
        for pattern in ("%H:%M", "%H:%M:%S"):
            try:
                return datetime.strptime(text, pattern).time()
            except ValueError:
                continue
        raise ValueError("Invalid time.")

    @staticmethod
    def is_in_past(event_date, event_time):
        # seconds are ignored so an event set for this minute is allowed
        now = TimeUtils.local_now().replace(second=0, microsecond=0)
        return datetime.combine(event_date, event_time) < now


class TextUtils:
    @staticmethod
    def normalize_name(name):
        """Collapse repeated spaces: 'Juan  Dela Cruz' == 'Juan Dela Cruz'."""
        return " ".join(name.split())


# =========================================================
# EXCEPTIONS  (INHERITANCE: one parent, many specific errors)
#
# Services raise these. One handler near the bottom turns any
# ApiError into the correct JSON response.
# =========================================================
class ApiError(Exception):
    status = 500
    clears_session = False

    def __init__(self, message, status=None):
        super().__init__(message)
        self.__message = message
        if status is not None:
            self.status = status

    @property
    def message(self):
        return self.__message


class ValidationError(ApiError):
    status = 400


class AuthenticationError(ApiError):
    status = 401


class PermissionDenied(ApiError):
    status = 403


class NotFoundError(ApiError):
    status = 404


class ConflictError(ApiError):
    status = 409


class AccountNotFoundError(AuthenticationError):
    """The logged-in account no longer exists, so the session is cleared."""
    clears_session = True

    def __init__(self):
        super().__init__("Account not found. Please log in again.")


# =========================================================
# VALIDATORS  (ABSTRACTION + POLYMORPHISM)
#
# Every validator has validate(value). Each one checks something
# different. CompositeValidator chains several of them.
# =========================================================
class Validator(ABC):
    @abstractmethod
    def validate(self, value):
        """Return the value if valid, otherwise raise ValidationError."""


class LengthValidator(Validator):
    def __init__(self, max_length, message):
        self.__max_length = max_length
        self.__message = message

    def validate(self, value):
        if len(value) > self.__max_length:
            raise ValidationError(self.__message)
        return value


class PatternValidator(Validator):
    def __init__(self, pattern, message):
        self.__pattern = pattern
        self.__message = message

    def validate(self, value):
        if not self.__pattern.fullmatch(value):
            raise ValidationError(self.__message)
        return value


class ChoiceValidator(Validator):
    def __init__(self, choices, message):
        self.__choices = list(choices)
        self.__message = message

    def validate(self, value):
        if value not in self.__choices:
            raise ValidationError(self.__message)
        return value


class PasswordValidator(Validator):
    def validate(self, value):
        if not isinstance(value, str) or len(value) < 8:
            raise ValidationError(
                "Password must contain at least 8 characters."
            )
        if len(value) > 128:
            raise ValidationError("Password is too long.")
        return value


class CompositeValidator(Validator):
    """Runs several validators in order."""

    def __init__(self, *validators):
        self.__validators = validators

    def validate(self, value):
        for validator in self.__validators:
            value = validator.validate(value)
        return value


STUDENT_ID_VALIDATOR = CompositeValidator(
    LengthValidator(50, "Student ID is too long."),
    PatternValidator(
        STUDENT_ID_RE, "Student ID can only contain numbers (and hyphens)."
    ),
)
NAME_VALIDATOR = CompositeValidator(
    LengthValidator(100, "Name is too long."),
    PatternValidator(
        NAME_RE,
        "Name can only contain letters, spaces, periods, "
        "apostrophes and hyphens.",
    ),
)
EMAIL_VALIDATOR = CompositeValidator(
    PatternValidator(EMAIL_RE, "Enter a valid email address."),
    LengthValidator(254, "Enter a valid email address."),
)
PASSWORD_VALIDATOR = PasswordValidator()
COURSE_VALIDATOR = ChoiceValidator(AppConfig.COURSES, "Choose a valid course.")
YEAR_VALIDATOR = ChoiceValidator(
    AppConfig.YEAR_LEVELS, "Choose a valid year level."
)
SECTION_VALIDATOR = PatternValidator(
    SECTION_RE, "Section can only contain letters or numbers."
)


# =========================================================
# MODELS
#
# BaseModel                (abstract)
#   |- Account             (abstract)  -> Participant, Admin
#   |- Event               (abstract)  -> UpcomingEvent, ReopenedEvent,
#   |                                     FinishedEvent
#   |- Registration        (abstract)  -> AttendingRegistration,
#   |                                     DeclinedRegistration
#   |- NotificationRecord
# =========================================================
class BaseModel(ABC):
    """Parent of every model.

    ENCAPSULATION: the raw data is private (self.__data). Child classes
    read it only through the protected _get(), and the outside world only
    sees what each child chooses to publish via properties / to_public().
    """

    def __init__(self, data):
        self.__data = dict(data)

    def _get(self, key, default=None):
        return self.__data.get(key, default)

    @property
    def id(self):
        return self._get("id", "")

    @abstractmethod
    def to_public(self):
        """Return only the fields that are safe to send to the browser."""


# ---------------- Accounts ----------------
class Account(BaseModel, ABC):
    """Abstract parent for every kind of logged-in user."""
    role = "account"

    @property
    def email(self):
        return self._get("email", "")

    @abstractmethod
    def verify_password(self, password):
        """Return True when the password is correct."""

    @abstractmethod
    def start_session(self, flask_session):
        """Write this account into the login session."""

    def login_extras(self):
        """Extra fields for the login response. Default: none."""
        return {}


class Participant(Account):
    role = "participant"

    @property
    def student_id(self):
        return self._get("student_id", "")

    @property
    def name(self):
        return self._get("name", "")

    @property
    def course(self):
        return (self._get("course") or "").strip()

    @property
    def section(self):
        return (self._get("section") or "").strip()

    @property
    def year_level(self):
        return (self._get("year_level") or "").strip()

    def has_complete_profile(self):
        return all([self.course, self.section, self.year_level])

    def verify_password(self, password):
        stored_hash = self._get("password_hash")
        return bool(stored_hash) and check_password_hash(stored_hash, password)

    def start_session(self, flask_session):
        flask_session.clear()
        flask_session["user_id"] = self.id
        flask_session["role"] = self.role

    def to_public(self):
        return {
            "id": self.id,
            "student_id": self.student_id,
            "name": self.name,
            "email": self.email,
            "course": self.course,
            "section": self.section,
            "year": self.year_level,
            "role": self.role,
            "createdAt": TimeUtils.iso(self._get("created_at")),
        }


class Admin(Account):
    role = "admin"
    home_page = "/admin"

    def __init__(self, email=None):
        super().__init__({"email": email or AppConfig.ADMIN_EMAIL})

    def verify_password(self, password):
        return hmac.compare_digest(
            str(password).encode("utf-8"),
            AppConfig.ADMIN_PASSWORD.encode("utf-8"),
        )

    def start_session(self, flask_session):
        flask_session.clear()
        flask_session["role"] = self.role
        flask_session["admin_email"] = self.email

    def login_extras(self):
        return {"redirect": self.home_page}

    def to_public(self):
        return {"email": self.email, "role": self.role}


# ---------------- Events ----------------
class Event(BaseModel, ABC):
    """Abstract parent for events. Each status decides if it is finished."""

    @staticmethod
    def from_row(row):
        """Factory: pick the right Event subclass from the saved status."""
        event_class = EVENT_TYPES.get(row.get("status", "upcoming"),
                                      UpcomingEvent)
        return event_class(row)

    # ---- read-only properties (ENCAPSULATION) ----
    @property
    def title(self):
        return self._get("title", "")

    @property
    def category(self):
        return self._get("category", "")

    @property
    def location(self):
        return self._get("location", "")

    @property
    def description(self):
        return self._get("description") or ""

    @property
    def status(self):
        return self._get("status", "upcoming")

    @property
    def capacity(self):
        return int(self._get("capacity", 0))

    @property
    def registered(self):
        return int(self._get("registered", 0) or 0)

    @property
    def event_date(self):
        return self._get("event_date")

    @property
    def time_text(self):
        return TimeUtils.format_time(self._get("event_time"))

    # ---- behavior ----
    @abstractmethod
    def is_finished(self):
        """Return True when the event is finished."""

    def accepts_registration(self):
        return not self.is_finished()

    def spots_left(self, reserved):
        return self.capacity - reserved

    def starts_at(self):
        try:
            return datetime.combine(
                self.event_date, TimeUtils.parse_time(self.time_text)
            )
        except (ValueError, TypeError):
            return None

    def is_rescheduled_to(self, form):
        return (
            form.event_date != self.event_date
            or form.time_text != self.time_text
        )

    def changed_fields(self, form):
        """Names of the fields the admin changed (self holds the OLD values)."""
        changes = []
        if form.title != self.title:
            changes.append("title")
        if form.event_date != self.event_date:
            changes.append("date")
        if form.time_text != self.time_text:
            changes.append("time")
        if form.location != self.location:
            changes.append("location")
        return changes

    def to_public(self):
        data = {
            "id": self.id,
            "title": self.title,
            "category": self.category,
            "date": self.event_date.isoformat(),
            "time": self.time_text,
            "location": self.location,
            "capacity": self.capacity,
            "registered": self.registered,
            "description": self.description,
            "status": self.status,
            "isFinished": self.is_finished(),
        }
        if self._get("finished_at"):
            data["finishedAt"] = TimeUtils.iso(self._get("finished_at"))
        return data


class FinishedEvent(Event):
    """The admin marked the event as done."""

    def is_finished(self):
        return True


class ReopenedEvent(Event):
    """Reopened by the admin: it will not auto-finish again until the
    admin clicks Mark as Done."""

    def is_finished(self):
        return False


class UpcomingEvent(Event):
    """Finishes automatically once its date and time have passed."""

    def is_finished(self):
        starts_at = self.starts_at()
        return starts_at is not None and starts_at < TimeUtils.local_now()


EVENT_TYPES = {
    "finished": FinishedEvent,
    "reopened": ReopenedEvent,
    "upcoming": UpcomingEvent,
}


# ---------------- Registrations ----------------
class Registration(BaseModel, ABC):
    """Abstract parent for registrations. Each type decides its spots."""
    ATTENDANCE_STATUSES = ("registered", "attended", "absent")

    @staticmethod
    def from_row(row):
        """Factory: pick the right Registration subclass from the answer."""
        if str(row.get("attending", "yes")).lower() == "no":
            return DeclinedRegistration(row)
        return AttendingRegistration(row)

    @property
    def event_id(self):
        return self._get("event_id")

    @property
    def event_title(self):
        return self._get("event_title", "")

    @property
    def attending(self):
        return self._get("attending")

    @property
    def attendance_status(self):
        return self._get("attendance_status")

    @abstractmethod
    def spots_used(self):
        """Return how many event spots this registration uses."""

    def can_be_cancelled(self):
        return self.attendance_status != "attended"

    def to_public(self):
        return {
            "id": self.id,
            "eventId": self.event_id,
            "eventTitle": self.event_title,
            "student_id": self._get("student_id"),
            "name": self._get("name"),
            "email": self._get("email"),
            "course": self._get("course"),
            "section": self._get("section"),
            "year": self._get("year_level"),
            "attending": self.attending,
            "quantity": self._get("quantity"),
            "owner": self._get("user_id"),
            "attendanceStatus": self.attendance_status,
            "registeredAt": TimeUtils.iso(self._get("registered_at")),
        }


class AttendingRegistration(Registration):
    def spots_used(self):
        try:
            return max(0, int(self._get("quantity", 1)))
        except (ValueError, TypeError):
            return 1


class DeclinedRegistration(Registration):
    """A 'no' answer uses no spot."""

    def spots_used(self):
        return 0


class NotificationRecord(BaseModel):
    """A saved notification as read back from the database."""

    def to_public(self):
        return {
            "id": self.id,
            "eventId": self._get("event_id"),
            "type": self._get("type"),
            "message": self._get("message"),
            "isRead": bool(self._get("is_read")),
            "createdAt": TimeUtils.iso(self._get("created_at")),
        }


# =========================================================
# NOTIFICATIONS  (ABSTRACTION + INHERITANCE + POLYMORPHISM)
#
# Each kind of notification knows how to write its own message.
# The repository just calls notification.message() and never
# needs to know which kind it is holding.
# =========================================================
class Notification(ABC):
    type = "notification"

    def __init__(self, event_id=None):
        self.__event_id = event_id

    @property
    def event_id(self):
        return self.__event_id

    @abstractmethod
    def message(self):
        """Return the text shown to the student."""

    def text(self):
        return self.message()[:500]


class EventNotification(Notification, ABC):
    """Parent for notifications that are about one Event object."""

    def __init__(self, event):
        super().__init__(event.id)
        self._event = event


class EventCreatedNotification(EventNotification):
    type = "event_created"

    def message(self):
        e = self._event
        return (f'New event: "{e.title}" on {e.event_date.isoformat()} '
                f'at {e.location}.')


class EventCancelledNotification(EventNotification):
    type = "event_cancelled"

    @property
    def event_id(self):
        # the event row is deleted, so the link is left empty
        return None

    def message(self):
        return f'The event "{self._event.title}" has been cancelled.'


class ReminderNotification(EventNotification):
    type = "reminder"

    def message(self):
        e = self._event
        return (f'Reminder: "{e.title}" starts on '
                f'{e.event_date.isoformat()} at {e.time_text}.')


class RegistrationConfirmedNotification(EventNotification):
    type = "registration"

    def message(self):
        e = self._event
        return (f'You are registered for "{e.title}" '
                f'on {e.event_date.isoformat()}.')


class WaitlistPromotedNotification(EventNotification):
    type = "waitlist_promoted"

    def message(self):
        return (f'A spot opened up! You are now registered for '
                f'"{self._event.title}".')


class EventUpdatedNotification(Notification):
    type = "event_updated"

    def __init__(self, event_id, form, changes):
        super().__init__(event_id)
        self.__form = form
        self.__changes = changes

    def message(self):
        form = self.__form
        changed = ", ".join(self.__changes)
        return (f'"{form.title}" was updated ({changed} changed). '
                f'Now: {form.event_date.isoformat()} at '
                f'{form.time_text}, {form.location}.')


class RegistrationCancelledNotification(Notification):
    type = "registration_cancelled"

    def __init__(self, registration):
        super().__init__(registration.event_id)
        self.__title = registration.event_title

    def message(self):
        return f'You cancelled your registration for "{self.__title}".'


# =========================================================
# REPOSITORIES  (ABSTRACTION + INHERITANCE)
#
# A repository is the only place that writes SQL for one table.
# Repository holds the shared logic; each child adds its own.
# =========================================================
EVENT_SELECT = """
    SELECT e.*,
           COALESCE((
               SELECT SUM(r.quantity)
               FROM registrations r
               WHERE r.event_id = e.id AND r.attending = 'yes'
           ), 0) AS registered
    FROM events e
"""

REGISTRATION_SELECT = """
    SELECT r.*, e.title AS event_title
    FROM registrations r
    JOIN events e ON e.id = r.event_id
"""


class Repository(ABC):
    _alias = ""

    def __init__(self, cursor):
        self._cursor = cursor

    @property
    @abstractmethod
    def table(self):
        """Name of the table this repository manages."""

    @abstractmethod
    def _build(self, row):
        """Turn one database row into a model object."""

    def _select_sql(self):
        return f"SELECT * FROM {self.table}"

    def _fetch_all(self, sql, params=()):
        self._cursor.execute(sql, params)
        return [self._build(row) for row in self._cursor.fetchall()]

    def _fetch_one(self, sql, params=()):
        self._cursor.execute(sql, params)
        row = self._cursor.fetchone()
        return self._build(row) if row else None

    def _exists(self, sql, params=()):
        self._cursor.execute(sql, params)
        return self._cursor.fetchone() is not None

    def find_by_id(self, record_id, lock=False):
        column = f"{self._alias}.id" if self._alias else "id"
        sql = f"{self._select_sql()} WHERE {column} = %s"
        if lock:
            sql += " FOR UPDATE"
        return self._fetch_one(sql, (record_id,))


class UserRepository(Repository):
    table = "users"

    def _build(self, row):
        return Participant(row)

    def find_by_email(self, email):
        return self._fetch_one(
            "SELECT * FROM users WHERE email = %s", (email,)
        )

    def email_exists(self, email):
        return self._exists("SELECT 1 FROM users WHERE email = %s", (email,))

    def student_id_exists(self, student_id):
        return self._exists(
            "SELECT 1 FROM users WHERE student_id = %s", (student_id,)
        )

    def name_exists(self, name):
        return self._exists(
            "SELECT 1 FROM users WHERE LOWER(name) = LOWER(%s)", (name,)
        )

    def add(self, user_id, student_id, name, email, password_hash):
        self._cursor.execute(
            """
            INSERT INTO users
                (id, student_id, name, email, password_hash, created_at)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (user_id, student_id, name, email, password_hash,
             TimeUtils.utc_now()),
        )

    def update_profile(self, user_id, course, section, year_level):
        self._cursor.execute(
            """
            UPDATE users
            SET course = %s, section = %s, year_level = %s
            WHERE id = %s
            """,
            (course, section, year_level, user_id),
        )

    def list_all(self):
        return self._fetch_all("SELECT * FROM users ORDER BY created_at")

    def delete(self, user_id):
        self._cursor.execute("DELETE FROM users WHERE id = %s", (user_id,))
        return self._cursor.rowcount > 0


class EventRepository(Repository):
    table = "events"
    _alias = "e"

    def _build(self, row):
        return Event.from_row(row)

    def _select_sql(self):
        return EVENT_SELECT

    def list_all(self):
        return self._fetch_all(
            EVENT_SELECT + " ORDER BY e.created_at, e.event_date"
        )

    def categories(self):
        self._cursor.execute(
            "SELECT DISTINCT category FROM events ORDER BY category"
        )
        return [row["category"] for row in self._cursor.fetchall()]

    def find_active_registered_for(self, user_id):
        """Unfinished events this student said 'yes' to."""
        return self._fetch_all(
            EVENT_SELECT
            + " WHERE e.status <> 'finished' AND e.id IN ("
              "SELECT event_id FROM registrations "
              "WHERE user_id = %s AND attending = 'yes')",
            (user_id,),
        )

    def add(self, event_id, form):
        self._cursor.execute(
            """
            INSERT INTO events
                (id, title, category, event_date, event_time, location,
                 capacity, description, status, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'upcoming', %s)
            """,
            (event_id, form.title, form.category, form.event_date,
             form.event_time, form.location, form.capacity,
             form.description, TimeUtils.utc_now()),
        )

    def update(self, event_id, form):
        self._cursor.execute(
            """
            UPDATE events
            SET title = %s, category = %s, event_date = %s,
                event_time = %s, location = %s, capacity = %s,
                description = %s
            WHERE id = %s
            """,
            (form.title, form.category, form.event_date, form.event_time,
             form.location, form.capacity, form.description, event_id),
        )

    def delete(self, event_id):
        self._cursor.execute("DELETE FROM events WHERE id = %s", (event_id,))

    def set_status(self, event_id, status, finished_at):
        """Return False when the event does not exist."""
        self._cursor.execute(
            "UPDATE events SET status = %s, finished_at = %s WHERE id = %s",
            (status, finished_at, event_id),
        )
        return self._cursor.rowcount > 0 or self.find_by_id(event_id) is not None


class RegistrationRepository(Repository):
    table = "registrations"
    _alias = "r"

    def _build(self, row):
        return Registration.from_row(row)

    def _select_sql(self):
        return REGISTRATION_SELECT

    def find_owned(self, registration_id, user_id):
        return self._fetch_one(
            REGISTRATION_SELECT + " WHERE r.id = %s AND r.user_id = %s",
            (registration_id, user_id),
        )

    def list_all(self):
        return self._fetch_all(REGISTRATION_SELECT + " ORDER BY r.registered_at")

    def list_for_user(self, user_id):
        return self._fetch_all(
            REGISTRATION_SELECT
            + " WHERE r.user_id = %s ORDER BY r.registered_at",
            (user_id,),
        )

    def exists_for(self, event_id, user_id):
        return self._exists(
            "SELECT 1 FROM registrations WHERE event_id = %s AND user_id = %s",
            (event_id, user_id),
        )

    def count_for_event(self, event_id):
        self._cursor.execute(
            "SELECT COUNT(*) AS total FROM registrations WHERE event_id = %s",
            (event_id,),
        )
        return self._cursor.fetchone()["total"]

    def reserved_spots(self, event_id):
        """POLYMORPHISM: each registration reports its own spots_used()."""
        self._cursor.execute(
            "SELECT attending, quantity FROM registrations WHERE event_id = %s",
            (event_id,),
        )
        return sum(
            Registration.from_row(row).spots_used()
            for row in self._cursor.fetchall()
        )

    def add(self, registration_id, event, participant, attending):
        self._cursor.execute(
            """
            INSERT INTO registrations
                (id, event_id, user_id, student_id, name, email,
                 course, section, year_level, attending, quantity,
                 attendance_status, registered_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 1,
                    'registered', %s)
            """,
            (registration_id, event.id, participant.id,
             participant.student_id, participant.name, participant.email,
             participant.course, participant.section,
             participant.year_level, attending, TimeUtils.utc_now()),
        )

    def delete(self, registration_id):
        self._cursor.execute(
            "DELETE FROM registrations WHERE id = %s", (registration_id,)
        )

    def delete_for_user(self, user_id):
        self._cursor.execute(
            "DELETE FROM registrations WHERE user_id = %s", (user_id,)
        )

    def set_attendance(self, registration_id, status):
        self._cursor.execute(
            "UPDATE registrations SET attendance_status = %s WHERE id = %s",
            (status, registration_id),
        )

    def attendance_rows(self, event_id, only_attended):
        """Plain rows for the printable sheet (not full models)."""
        condition = (
            "attendance_status = 'attended'"
            if only_attended
            else "LOWER(attending) = 'yes'"
        )
        self._cursor.execute(
            f"""
            SELECT name, course, section, year_level, student_id
            FROM registrations
            WHERE event_id = %s AND {condition}
            ORDER BY year_level, course, section, name
            """,
            (event_id,),
        )
        return self._cursor.fetchall()


class NotificationRepository(Repository):
    table = "notifications"

    def _build(self, row):
        return NotificationRecord(row)

    def send_to_user(self, user_id, notification):
        self._cursor.execute(
            """
            INSERT INTO notifications
                (id, user_id, event_id, type, message, is_read, created_at)
            VALUES (%s, %s, %s, %s, %s, 0, %s)
            """,
            ("n" + uuid.uuid4().hex[:16], user_id, notification.event_id,
             notification.type, notification.text(), TimeUtils.utc_now()),
        )

    def send_to_all_students(self, notification):
        self._cursor.execute(
            """
            INSERT INTO notifications
                (id, user_id, event_id, type, message, is_read, created_at)
            SELECT CONCAT('n', LEFT(REPLACE(UUID(), '-', ''), 16)),
                   u.id, %s, %s, %s, 0, %s
            FROM users u
            """,
            (notification.event_id, notification.type,
             notification.text(), TimeUtils.utc_now()),
        )

    def send_to_registered(self, notification):
        self._cursor.execute(
            """
            INSERT INTO notifications
                (id, user_id, event_id, type, message, is_read, created_at)
            SELECT CONCAT('n', LEFT(REPLACE(UUID(), '-', ''), 16)),
                   r.user_id, %s, %s, %s, 0, %s
            FROM (
                SELECT DISTINCT user_id FROM registrations
                WHERE event_id = %s AND attending = 'yes'
            ) r
            """,
            (notification.event_id, notification.type, notification.text(),
             TimeUtils.utc_now(), notification.event_id),
        )

    def has_reminder(self, user_id, event_id):
        return self._exists(
            """
            SELECT 1 FROM notifications
            WHERE user_id = %s AND event_id = %s AND type = 'reminder'
            """,
            (user_id, event_id),
        )

    def list_for_user(self, user_id, limit=50):
        return self._fetch_all(
            """
            SELECT id, event_id, type, message, is_read, created_at
            FROM notifications
            WHERE user_id = %s
            ORDER BY created_at DESC, id DESC
            LIMIT %s
            """,
            (user_id, limit),
        )

    def unread_count(self, user_id):
        self._cursor.execute(
            "SELECT COUNT(*) AS total FROM notifications "
            "WHERE user_id = %s AND is_read = 0",
            (user_id,),
        )
        return int(self._cursor.fetchone()["total"])

    def mark_all_read(self, user_id):
        self._cursor.execute(
            "UPDATE notifications SET is_read = 1 WHERE user_id = %s",
            (user_id,),
        )

    def mark_read(self, notification_id, user_id):
        self._cursor.execute(
            "UPDATE notifications SET is_read = 1 "
            "WHERE id = %s AND user_id = %s",
            (notification_id, user_id),
        )

    def delete_for_user(self, user_id):
        self._cursor.execute(
            "DELETE FROM notifications WHERE user_id = %s", (user_id,)
        )


class UnitOfWork:
    """Gives one transaction access to every repository.

    ENCAPSULATION: the cursor is passed in once and never exposed.
    """

    def __init__(self, cursor):
        self.__users = UserRepository(cursor)
        self.__events = EventRepository(cursor)
        self.__registrations = RegistrationRepository(cursor)
        self.__notifications = NotificationRepository(cursor)

    @property
    def users(self):
        return self.__users

    @property
    def events(self):
        return self.__events

    @property
    def registrations(self):
        return self.__registrations

    @property
    def notifications(self):
        return self.__notifications


# =========================================================
# DATABASE  (ENCAPSULATION: the pool is private)
# =========================================================
class Database:
    def __init__(self, config):
        self.__config = dict(config)
        self.__pool = None

    def __get_pool(self):
        if self.__pool is None:
            self.__pool = pooling.MySQLConnectionPool(
                pool_name="event_hub_pool",
                pool_size=5,
                **self.__config,
            )
        return self.__pool

    def get_connection(self):
        """Raw pooled connection. The caller must close() it."""
        return self.__get_pool().get_connection()

    @contextmanager
    def transaction(self):
        """One cursor; commit on success, rollback on any error."""
        conn = self.__get_pool().get_connection()
        cursor = conn.cursor(dictionary=True, buffered=True)
        try:
            yield cursor
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cursor.close()
            conn.close()

    @contextmanager
    def work(self):
        """A transaction that hands out repositories."""
        with self.transaction() as cursor:
            yield UnitOfWork(cursor)

    def ping(self):
        with self.transaction() as cursor:
            cursor.execute("SELECT 1")

    def ensure_profile_columns(self):
        """Adds the course/section/year columns if they are missing."""
        with self.transaction() as cursor:
            cursor.execute(
                """
                SELECT COLUMN_NAME AS col
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'users'
                """,
                (self.__config["database"],),
            )
            existing = {row["col"] for row in cursor.fetchall()}
            for column, definition in AppConfig.PROFILE_COLUMNS.items():
                if column not in existing:
                    cursor.execute(
                        f"ALTER TABLE users ADD COLUMN {column} {definition}"
                    )


# =========================================================
# EVENT FORMS  (ABSTRACTION + INHERITANCE + ENCAPSULATION)
#
# EventForm reads and validates the admin's input. The two
# children only differ in their rules (class attributes).
# =========================================================
class EventForm(ABC):
    required_fields = ()
    required_message = ""
    default_category = ""
    default_description = ""
    default_capacity = None

    def __init__(self, body):
        title = str(body.get("title", "")).strip()
        category = (
            str(body.get("category", self.default_category)).strip()
            or self.default_category
        )
        date_text = str(body.get("date", "")).strip()
        time_text = str(body.get("time", "")).strip()
        location = str(body.get("location", "")).strip()
        description = str(
            body.get("description", self.default_description)
        ).strip()

        values = {
            "title": title, "category": category, "date": date_text,
            "time": time_text, "location": location,
        }
        if not all(values[name] for name in self.required_fields):
            raise ValidationError(self.required_message)
        if len(title) > 150 or len(location) > 200 or len(category) > 50:
            raise ValidationError("Title, category, or location is too long.")
        try:
            capacity = int(body.get("capacity", self.default_capacity))
        except (ValueError, TypeError):
            raise ValidationError("Capacity must be a whole number.")
        if capacity < 1:
            raise ValidationError("Capacity must be at least 1.")
        try:
            event_date = TimeUtils.parse_date(date_text)
            event_time = TimeUtils.parse_time(time_text)
        except ValueError:
            raise ValidationError("Enter a valid date and time.")

        self.__title = title
        self.__category = category
        self.__location = location
        self.__description = description
        self.__capacity = capacity
        self.__event_date = event_date
        self.__event_time = event_time

    @property
    def title(self):
        return self.__title

    @property
    def category(self):
        return self.__category

    @property
    def location(self):
        return self.__location

    @property
    def description(self):
        return self.__description

    @property
    def capacity(self):
        return self.__capacity

    @property
    def event_date(self):
        return self.__event_date

    @property
    def event_time(self):
        return self.__event_time

    @property
    def time_text(self):
        return self.__event_time.strftime("%H:%M")


class CreateEventForm(EventForm):
    required_fields = ("title", "date", "time", "location")
    required_message = "Title, date, time, and location are required."
    default_category = "Meetup"
    default_description = "Details coming soon."
    default_capacity = 1


class UpdateEventForm(EventForm):
    required_fields = ("title", "category", "date", "time", "location")
    required_message = (
        "Title, category, date, time, and location are required."
    )


# =========================================================
# RESULTS  (POLYMORPHISM: same call, different response)
# =========================================================
class ReservationResult(ABC):
    status_code = 200

    @abstractmethod
    def to_response(self):
        """Return the JSON body for this outcome."""


class RegisteredResult(ReservationResult):
    status_code = 201

    def __init__(self, registration):
        self.__registration = registration

    def to_response(self):
        said_yes = self.__registration.attending == "yes"
        return {
            "message": (
                "You are registered for this event!"
                if said_yes
                else "Your response has been recorded."
            ),
            "registration": self.__registration.to_public(),
        }


class WaitlistedResult(ReservationResult):
    status_code = 202

    def __init__(self, position):
        self.__position = position

    def to_response(self):
        return {
            "message": (
                f"This event is full. You are #{self.__position} "
                "on the waitlist and will be registered "
                "automatically if a spot opens."
            ),
            "waitlisted": True,
            "position": self.__position,
        }


class AttendanceSheet:
    """Everything the printable attendance page needs."""

    def __init__(self, event, is_finished, participants):
        self.__event = event
        self.__is_finished = is_finished
        self.__participants = participants

    def grouped_participants(self):
        grouped = {}
        for key, group in groupby(
            self.__participants,
            key=lambda x: (x["year_level"], x["course"], x["section"]),
        ):
            grouped[key] = list(group)
        return grouped

    def context(self):
        return {
            "event": self.__event.to_public(),
            "is_finished": self.__is_finished,
            "grouped_participants": self.grouped_participants(),
        }


# =========================================================
# SERVICES  (business rules live here, not in the routes)
#
# Service is the parent. Each child owns one area of the app.
# =========================================================
class Service:
    def __init__(self, db):
        self._db = db


class AuthService(Service):
    def register(self, body):
        student_id = str(body.get("student_id", "")).strip()
        name = TextUtils.normalize_name(str(body.get("name", "")))
        email = str(body.get("email", "")).strip().lower()
        password = body.get("password", "")
        if not all([student_id, name, email, password]):
            raise ValidationError(
                "Student ID, name, email, and password are required."
            )
        STUDENT_ID_VALIDATOR.validate(student_id)
        NAME_VALIDATOR.validate(name)
        EMAIL_VALIDATOR.validate(email)
        PASSWORD_VALIDATOR.validate(password)
        if email == AppConfig.ADMIN_EMAIL:
            raise ConflictError("This email is reserved for the administrator.")

        user_id = "usr" + uuid.uuid4().hex[:12]
        try:
            with self._db.work() as uow:
                if uow.users.email_exists(email):
                    raise ConflictError(
                        "An account with this email already exists."
                    )
                if uow.users.student_id_exists(student_id):
                    raise ConflictError("This Student ID is already registered.")
                if uow.users.name_exists(name):
                    raise ConflictError(
                        "An account with this name already exists."
                    )
                uow.users.add(
                    user_id, student_id, name, email,
                    generate_password_hash(password),
                )
                return uow.users.find_by_id(user_id)
        except mysql.connector.IntegrityError:
            raise ConflictError(
                "This email, Student ID, or name is already registered."
            )

    def login(self, email, password):
        """Returns an Admin or a Participant. The caller never needs to
        know which one (POLYMORPHISM)."""
        if not email or not isinstance(password, str) or not password:
            raise ValidationError("Email and password are required.")
        if email == AppConfig.ADMIN_EMAIL:
            account = Admin()
        else:
            with self._db.work() as uow:
                account = uow.users.find_by_email(email)
        if account is None or not account.verify_password(password):
            raise AuthenticationError("Invalid email or password.")
        return account

    def current_account(self):
        role = SessionManager.role()
        if role == "admin":
            return Admin(SessionManager.admin_email())
        if role == "participant":
            with self._db.work() as uow:
                user = uow.users.find_by_id(SessionManager.user_id())
            if user:
                return user
            SessionManager.clear()
        return None


class UserService(Service):
    def update_profile(self, user_id, body):
        course = str(body.get("course", "")).strip().upper()
        year = str(body.get("year", "")).strip()
        section = str(body.get("section", "")).strip().upper()
        if not all([course, year, section]):
            raise ValidationError(
                "Course, year level and section are required."
            )
        COURSE_VALIDATOR.validate(course)
        YEAR_VALIDATOR.validate(year)
        SECTION_VALIDATOR.validate(section)
        with self._db.work() as uow:
            uow.users.update_profile(user_id, course, section, year)
            user = uow.users.find_by_id(user_id)
            if not user:
                raise AccountNotFoundError()
        return user

    def list_all(self):
        with self._db.work() as uow:
            return uow.users.list_all()

    def delete(self, user_id):
        with self._db.work() as uow:
            # remove dependent records first, then the account
            uow.registrations.delete_for_user(user_id)
            uow.notifications.delete_for_user(user_id)
            if not uow.users.delete(user_id):
                raise NotFoundError("User not found.")


class EventService(Service):
    def list_events(self):
        with self._db.work() as uow:
            return uow.events.list_all()

    def categories(self):
        with self._db.work() as uow:
            return uow.events.categories()

    def create(self, form):
        if TimeUtils.is_in_past(form.event_date, form.event_time):
            raise ValidationError(PAST_EVENT_ERROR)
        event_id = "ev" + uuid.uuid4().hex[:10]
        with self._db.work() as uow:
            uow.events.add(event_id, form)
            event = uow.events.find_by_id(event_id)
            uow.notifications.send_to_all_students(
                EventCreatedNotification(event)
            )
        return event

    def update(self, event_id, form):
        with self._db.work() as uow:
            # FOR UPDATE locks this event row while it is being changed
            event = uow.events.find_by_id(event_id, lock=True)
            if not event:
                raise NotFoundError("Event not found.")

            # only block past dates when the date or time really changed
            if event.is_rescheduled_to(form) and TimeUtils.is_in_past(
                form.event_date, form.event_time
            ):
                raise ValidationError(PAST_EVENT_ERROR)

            reserved = uow.registrations.reserved_spots(event_id)
            if form.capacity < reserved:
                raise ValidationError(
                    f"Capacity cannot be lower than the "
                    f"{reserved} already reserved spots."
                )

            changes = event.changed_fields(form)
            if changes:
                uow.notifications.send_to_registered(
                    EventUpdatedNotification(event_id, form, changes)
                )
            uow.events.update(event_id, form)
            return uow.events.find_by_id(event_id)

    def delete(self, event_id):
        with self._db.work() as uow:
            event = uow.events.find_by_id(event_id, lock=True)
            if not event:
                raise NotFoundError("Event not found.")
            # preserve registration and attendance history
            if uow.registrations.count_for_event(event_id) > 0:
                raise ConflictError(
                    "This event has registration records and cannot "
                    "be deleted. Preserve those records or resolve "
                    "the registrations first."
                )
            uow.events.delete(event_id)
            if not event.is_finished():
                uow.notifications.send_to_all_students(
                    EventCancelledNotification(event)
                )

    def finish(self, event_id):
        with self._db.work() as uow:
            if not uow.events.set_status(
                event_id, "finished", TimeUtils.utc_now()
            ):
                raise NotFoundError("Event not found.")

    def reopen(self, event_id):
        with self._db.work() as uow:
            if not uow.events.set_status(event_id, "reopened", None):
                raise NotFoundError("Event not found.")

    def attendance_sheet(self, event_id):
        with self._db.work() as uow:
            event = uow.events.find_by_id(event_id)
            if not event:
                raise NotFoundError("Event not found.")
            finished = event.is_finished()
            rows = uow.registrations.attendance_rows(
                event_id, only_attended=finished
            )
            participants = merge_sort(
                rows,
                key=lambda x: (x["year_level"], x["course"],
                               x["section"], x["name"]),
            )
        return AttendanceSheet(event, finished, participants)


class RegistrationService(Service):
    def __init__(self, db, waitlist):
        super().__init__(db)
        self.__waitlist = waitlist  # ENCAPSULATION: private to this service

    def list_all(self):
        with self._db.work() as uow:
            return uow.registrations.list_all()

    def list_for_user(self, user_id):
        with self._db.work() as uow:
            return uow.registrations.list_for_user(user_id)

    def reserve(self, user_id, event_id, attending):
        if attending not in ("yes", "no"):
            raise ValidationError("Please answer Yes or No.")
        registration_id = "reg" + uuid.uuid4().hex[:10]
        try:
            with self._db.work() as uow:
                user = uow.users.find_by_id(user_id)
                if not user:
                    raise AccountNotFoundError()
                # class info comes from the saved profile, not the form
                if not user.has_complete_profile():
                    raise ValidationError(PROFILE_INCOMPLETE_ERROR)

                # lock the event row so two people cannot take the last spot
                event = uow.events.find_by_id(event_id, lock=True)
                if not event:
                    raise NotFoundError("Event not found.")
                if not event.accepts_registration():
                    raise ValidationError("This event has already finished.")
                if uow.registrations.exists_for(event_id, user_id):
                    raise ConflictError(
                        "You have already registered for this event."
                    )

                # only a "yes" answer takes a spot
                if attending == "yes":
                    reserved = uow.registrations.reserved_spots(event_id)
                    if event.spots_left(reserved) < 1:
                        position = self.__waitlist.join(event_id, user_id)
                        return WaitlistedResult(position)

                uow.registrations.add(registration_id, event, user, attending)
                registration = uow.registrations.find_by_id(registration_id)
                if attending == "yes":
                    uow.notifications.send_to_user(
                        user_id, RegistrationConfirmedNotification(event)
                    )
        except mysql.connector.IntegrityError:
            raise ConflictError("You have already registered for this event.")
        return RegisteredResult(registration)

    def cancel(self, user_id, registration_id):
        with self._db.work() as uow:
            registration = uow.registrations.find_owned(
                registration_id, user_id
            )
            if not registration:
                raise NotFoundError("Registration not found.")
            if not registration.can_be_cancelled():
                raise ValidationError(
                    "An attended registration cannot be cancelled."
                )
            event = uow.events.find_by_id(registration.event_id)
            # finished events keep their records unchanged
            if event and event.is_finished():
                raise ValidationError(
                    "This event has finished, so it cannot be cancelled."
                )
            uow.registrations.delete(registration_id)
            # POLYMORPHISM: a declined registration frees 0 spots,
            # an attending one frees a spot for the waitlist.
            if registration.spots_used() > 0:
                self.__promote_from_waitlist(uow, registration.event_id)
            uow.notifications.send_to_user(
                user_id, RegistrationCancelledNotification(registration)
            )

    def update_attendance(self, registration_id, status):
        if status not in Registration.ATTENDANCE_STATUSES:
            raise ValidationError("Invalid attendance status.")
        with self._db.work() as uow:
            uow.registrations.set_attendance(registration_id, status)
            registration = uow.registrations.find_by_id(registration_id)
            if not registration:
                raise NotFoundError("Registration not found.")
        return registration

    def __promote_from_waitlist(self, uow, event_id):
        """When a spot opens, register the first person in the queue."""
        event = uow.events.find_by_id(event_id, lock=True)
        if not event or event.is_finished():
            return None
        reserved = uow.registrations.reserved_spots(event_id)
        if event.spots_left(reserved) < 1:
            return None
        while True:
            user_id = self.__waitlist.pop_next(event_id)
            if user_id is None:
                return None
            user = uow.users.find_by_id(user_id)
            if not user:
                continue
            if uow.registrations.exists_for(event_id, user_id):
                continue
            if not user.has_complete_profile():
                continue
            uow.registrations.add(
                "reg" + uuid.uuid4().hex[:10], event, user, "yes"
            )
            uow.notifications.send_to_user(
                user_id, WaitlistPromotedNotification(event)
            )
            return user_id


class NotificationService(Service):
    def list_for_user(self, user_id):
        with self._db.work() as uow:
            self.__ensure_reminders(uow, user_id)
            items = uow.notifications.list_for_user(user_id, limit=50)
            unread = uow.notifications.unread_count(user_id)
        return {
            "items": [item.to_public() for item in items],
            "unread": unread,
        }

    def mark_all_read(self, user_id):
        with self._db.work() as uow:
            uow.notifications.mark_all_read(user_id)

    def mark_read(self, notification_id, user_id):
        with self._db.work() as uow:
            uow.notifications.mark_read(notification_id, user_id)

    def __ensure_reminders(self, uow, user_id):
        """Create a 'happening within 24 hours' reminder once per event.
        Runs when the student loads notifications, so no background
        scheduler is needed."""
        now = TimeUtils.local_now()
        for event in uow.events.find_active_registered_for(user_id):
            starts_at = event.starts_at()
            if starts_at is None:
                continue
            if not (now < starts_at <= now + timedelta(hours=24)):
                continue
            if uow.notifications.has_reminder(user_id, event.id):
                continue
            uow.notifications.send_to_user(
                user_id, ReminderNotification(event)
            )


# =========================================================
# SESSION + ACCESS CONTROL  (POLYMORPHISM: policy.check())
# =========================================================
class SessionManager:
    """The only class that touches Flask's session directly."""

    @staticmethod
    def role():
        return session.get("role")

    @staticmethod
    def user_id():
        return session.get("user_id")

    @staticmethod
    def admin_email():
        return session.get("admin_email", AppConfig.ADMIN_EMAIL)

    @staticmethod
    def start(account):
        account.start_session(session)

    @staticmethod
    def clear():
        session.clear()


class AccessPolicy(ABC):
    @abstractmethod
    def check(self):
        """Raise an ApiError when the current visitor is not allowed."""


class ParticipantPolicy(AccessPolicy):
    def check(self):
        if not SessionManager.user_id():
            raise AuthenticationError("Please log in first.")
        if SessionManager.role() != "participant":
            raise PermissionDenied("Participant account required.")


class AdminPolicy(AccessPolicy):
    def check(self):
        if SessionManager.role() != "admin":
            raise PermissionDenied("Admin access required.")


PARTICIPANT_ONLY = ParticipantPolicy()
ADMIN_ONLY = AdminPolicy()


def requires(policy):
    """Decorator: run policy.check() before the route."""

    def decorator(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            policy.check()
            return view(*args, **kwargs)
        return wrapper
    return decorator


# =========================================================
# WIRING: create the objects once
# =========================================================
db = Database(AppConfig.DB)
auth_service = AuthService(db)
user_service = UserService(db)
event_service = EventService(db)
registration_service = RegistrationService(db, WaitlistQueue())
notification_service = NotificationService(db)

app = Flask(__name__)
app.secret_key = AppConfig.SECRET_KEY
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = AppConfig.COOKIE_SECURE

register_backup_routes(
    app,
    get_connection=db.get_connection,
    is_admin=lambda: SessionManager.role() == "admin",
)


def _get_json():
    return request.get_json(silent=True) or {}


@app.after_request
def add_no_cache_headers(response):
    # every Back/Forward makes a fresh request, so redirects always run
    response.headers["Cache-Control"] = (
        "no-store, no-cache, must-revalidate, max-age=0"
    )
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.errorhandler(ApiError)
def handle_api_error(error):
    """One place turns every ApiError (and its children) into JSON."""
    if error.clears_session:
        SessionManager.clear()
    return jsonify({"error": error.message}), error.status


# =========================================================
# PAGES
# =========================================================
@app.route("/")
def index():
    # a logged-in admin never sees the sign-in page
    if SessionManager.role() == "admin":
        return redirect("/admin")
    return render_template("index.html")


@app.route("/admin")
def admin_page():
    if SessionManager.role() != "admin":
        return redirect("/")
    return render_template("admin.html")


@app.route("/api/admin/events/<event_id>/attendance-sheet", methods=["GET"])
@requires(ADMIN_ONLY)
def generate_attendance_sheet(event_id):
    sheet = event_service.attendance_sheet(event_id)
    return render_template("attendance_sheet.html", **sheet.context())


# =========================================================
# AUTH
# =========================================================
@app.route("/api/auth/register", methods=["POST"])
def register_account():
    user = auth_service.register(_get_json())
    # the new account is NOT logged in automatically
    SessionManager.clear()
    return jsonify({
        "message": "Account created successfully. Please sign in.",
        "user": user.to_public(),
        "role": user.role,
    }), 201


@app.route("/api/auth/login", methods=["POST"])
def login():
    body = _get_json()
    email = str(body.get("email", "")).strip().lower()
    password = body.get("password", "")
    account = auth_service.login(email, password)
    SessionManager.start(account)
    return jsonify({
        "message": "Login successful.",
        "role": account.role,
        "user": account.to_public(),
        **account.login_extras(),
    })


@app.route("/api/auth/me", methods=["GET"])
def get_current_user():
    account = auth_service.current_account()
    if account is None:
        return jsonify({"authenticated": False, "role": None, "user": None})
    return jsonify({
        "authenticated": True,
        "role": account.role,
        "user": account.to_public(),
        **account.login_extras(),
    })


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    SessionManager.clear()
    return jsonify({"message": "Logged out successfully."})


@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    SessionManager.clear()
    return jsonify({"ok": True})


# =========================================================
# PARTICIPANT: PROFILE
# =========================================================
@app.route("/api/profile", methods=["PUT"])
@requires(PARTICIPANT_ONLY)
def update_profile():
    user = user_service.update_profile(SessionManager.user_id(), _get_json())
    return jsonify({"message": "Profile saved.", "user": user.to_public()})


# =========================================================
# EVENTS
# =========================================================
@app.route("/api/events", methods=["GET"])
def get_events():
    return jsonify([e.to_public() for e in event_service.list_events()])


@app.route("/api/categories", methods=["GET"])
def get_categories():
    return jsonify(event_service.categories())


@app.route("/api/events", methods=["POST"])
@requires(ADMIN_ONLY)
def create_event():
    event = event_service.create(CreateEventForm(_get_json()))
    return jsonify(event.to_public()), 201


@app.route("/api/events/<event_id>", methods=["PUT"])
@requires(ADMIN_ONLY)
def update_event(event_id):
    event = event_service.update(event_id, UpdateEventForm(_get_json()))
    return jsonify({
        "message": "Event updated successfully.",
        "event": event.to_public(),
    })


@app.route("/api/events/<event_id>", methods=["DELETE"])
@requires(ADMIN_ONLY)
def delete_event(event_id):
    event_service.delete(event_id)
    return jsonify({"message": "Event deleted successfully."})


@app.route("/api/events/<event_id>/finish", methods=["POST"])
@requires(ADMIN_ONLY)
def finish_event(event_id):
    event_service.finish(event_id)
    return jsonify({"message": "Event marked as finished."})


@app.route("/api/events/<event_id>/reopen", methods=["POST"])
@requires(ADMIN_ONLY)
def reopen_event(event_id):
    event_service.reopen(event_id)
    return jsonify({"message": "Event reopened."})


# =========================================================
# ADMIN: USERS AND REGISTRATIONS
# =========================================================
@app.route("/api/admin/users", methods=["GET"])
@requires(ADMIN_ONLY)
def get_participant_accounts():
    return jsonify([u.to_public() for u in user_service.list_all()])


@app.route("/api/admin/users/<user_id>", methods=["DELETE"])
@requires(ADMIN_ONLY)
def delete_user(user_id):
    user_service.delete(user_id)
    return jsonify({"success": True, "message": "User deleted successfully"})


@app.route("/api/admin/registrations", methods=["GET"])
@requires(ADMIN_ONLY)
def get_all_registrations():
    return jsonify([r.to_public() for r in registration_service.list_all()])


@app.route(
    "/api/admin/registrations/<registration_id>/attendance",
    methods=["POST"],
)
@requires(ADMIN_ONLY)
def update_attendance(registration_id):
    registration = registration_service.update_attendance(
        registration_id, _get_json().get("status")
    )
    return jsonify({
        "message": "Attendance updated.",
        "registration": registration.to_public(),
    })


# =========================================================
# PARTICIPANT: REGISTRATIONS
# =========================================================
@app.route("/api/events/<event_id>/register", methods=["POST"])
@requires(PARTICIPANT_ONLY)
def reserve_spot(event_id):
    attending = str(_get_json().get("attending", "")).strip().lower()
    result = registration_service.reserve(
        SessionManager.user_id(), event_id, attending
    )
    # POLYMORPHISM: Registered / Waitlisted each build their own response
    return jsonify(result.to_response()), result.status_code


@app.route("/api/my-registrations", methods=["GET"])
@requires(PARTICIPANT_ONLY)
def get_my_registrations():
    registrations = registration_service.list_for_user(
        SessionManager.user_id()
    )
    return jsonify([r.to_public() for r in registrations])


@app.route(
    "/api/registrations/<registration_id>/cancel",
    methods=["POST"],
)
@requires(PARTICIPANT_ONLY)
def cancel_registration(registration_id):
    registration_service.cancel(SessionManager.user_id(), registration_id)
    return jsonify({"message": "Reservation cancelled."})


# =========================================================
# PARTICIPANT: NOTIFICATIONS
# =========================================================
@app.route("/api/notifications", methods=["GET"])
@requires(PARTICIPANT_ONLY)
def get_notifications():
    return jsonify(
        notification_service.list_for_user(SessionManager.user_id())
    )


@app.route("/api/notifications/read-all", methods=["POST"])
@requires(PARTICIPANT_ONLY)
def read_all_notifications():
    notification_service.mark_all_read(SessionManager.user_id())
    return jsonify({"message": "All notifications marked as read."})


@app.route("/api/notifications/<notification_id>/read", methods=["POST"])
@requires(PARTICIPANT_ONLY)
def read_notification(notification_id):
    notification_service.mark_read(notification_id, SessionManager.user_id())
    return jsonify({"message": "Marked as read."})


# =========================================================
# START APPLICATION
# =========================================================
if __name__ == "__main__":
    # fail early with a clear message if MySQL is not reachable
    try:
        db.ping()
    except mysql.connector.Error as error:
        raise SystemExit(
            f"Cannot connect to MySQL: {error}\n"
            "Check DB_HOST, DB_USER, DB_PASSWORD and DB_NAME in .env."
        )
    db.ensure_profile_columns()
    app.run(
        debug=True,
        use_reloader=False,
        host="0.0.0.0",
        port=5000,
    )
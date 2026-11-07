"""
Database backup (export / import) for the CCS Event Hub admin panel.

Works like MySQL Workbench's "Data Export" / "Data Import", but inside the
website. It is written in plain Python, so it does NOT need mysqldump or the
mysql command-line tools to be installed.

HOW TO USE (in app.py):

    from backup_routes import register_backup_routes

    register_backup_routes(
        app,
        get_connection=get_db_connection,                 # your function that returns a DB connection
        is_admin=lambda: session.get("role") == "admin",  # how YOUR app checks for an admin
    )

Endpoints it adds:
    GET  /api/admin/backup/export   -> downloads a .sql file
    POST /api/admin/backup/import   -> restores from an uploaded .sql file
"""

import json
import os
import re
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from flask import Response, jsonify, request

# Safety copies (made automatically before every import) are saved here.
BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups")

MAX_IMPORT_BYTES = 25 * 1024 * 1024  # 25 MB
INSERT_BATCH = 100                    # rows per INSERT statement


# ---------------------------------------------------------------------------
# helpers: turning Python values into SQL text
# ---------------------------------------------------------------------------
_ESCAPES = str.maketrans({
    "\\": "\\\\",
    "'": "\\'",
    "\n": "\\n",
    "\r": "\\r",
    "\0": "\\0",
    "\x1a": "\\Z",
})


def _quote(text):
    return "'" + text.translate(_ESCAPES) + "'"


def _ident(name):
    return "`" + str(name).replace("`", "``") + "`"


def _sql_value(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        return "0x" + raw.hex() if raw else "''"
    if isinstance(value, datetime):
        return _quote(value.isoformat(sep=" "))
    if isinstance(value, (date, time)):
        return _quote(value.isoformat())
    if isinstance(value, timedelta):  # MySQL TIME columns
        total = int(value.total_seconds())
        sign = "-" if total < 0 else ""
        total = abs(total)
        return _quote(f"{sign}{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}")
    if isinstance(value, (dict, list)):
        return _quote(json.dumps(value, ensure_ascii=False))
    if isinstance(value, (set, frozenset)):
        return _quote(",".join(sorted(str(v) for v in value)))
    return _quote(str(value))


def _values(row):
    """Works with tuple rows and dictionary rows."""
    return list(row.values()) if isinstance(row, dict) else list(row)


# ---------------------------------------------------------------------------
# EXPORT
# ---------------------------------------------------------------------------
def build_dump(conn):
    """Return the whole database as SQL text (structure + data)."""
    cur = conn.cursor()
    out = []

    cur.execute("SELECT DATABASE()")
    db_name = _values(cur.fetchone())[0] or "database"

    out.append("-- CCS Event Hub database backup")
    out.append(f"-- Database: {db_name}")
    out.append(f"-- Created:  {datetime.now():%Y-%m-%d %H:%M:%S}")
    out.append("")
    out.append("SET NAMES utf8mb4;")
    out.append("SET FOREIGN_KEY_CHECKS=0;")
    out.append("SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';")
    out.append("")

    cur.execute("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")
    tables = [_values(r)[0] for r in cur.fetchall()]

    for table in tables:
        t = _ident(table)

        cur.execute(f"SHOW CREATE TABLE {t}")
        create_sql = _values(cur.fetchone())[1]

        out.append("-- ----------------------------")
        out.append(f"-- Table: {table}")
        out.append("-- ----------------------------")
        out.append(f"DROP TABLE IF EXISTS {t};")
        out.append(create_sql + ";")
        out.append("")

        cur.execute(f"SELECT * FROM {t}")
        columns = [_ident(d[0]) for d in cur.description]
        col_list = ", ".join(columns)

        while True:
            rows = cur.fetchmany(INSERT_BATCH)
            if not rows:
                break
            tuples = [
                "(" + ", ".join(_sql_value(v) for v in _values(r)) + ")"
                for r in rows
            ]
            out.append(f"INSERT INTO {t} ({col_list}) VALUES\n" + ",\n".join(tuples) + ";")
        out.append("")

    out.append("SET FOREIGN_KEY_CHECKS=1;")
    out.append("")
    cur.close()
    return "\n".join(out), db_name


# ---------------------------------------------------------------------------
# IMPORT
# ---------------------------------------------------------------------------
_ONLY_PLAIN_COMMENTS = re.compile(r"(?:/\*(?!\!|M\!)[\s\S]*?\*/\s*)*")


def split_statements(sql):
    """
    Split a .sql file into single statements. Understands quoted strings,
    -- and # comments and /* */ comments, so a ';' inside text is safe.
    (It does not support the DELIMITER command used by stored procedures.)
    """
    statements, buf = [], []
    i, n, quote = 0, len(sql), None

    def flush():
        stmt = "".join(buf).strip()
        buf.clear()
        if stmt and not _ONLY_PLAIN_COMMENTS.fullmatch(stmt):
            statements.append(stmt)

    while i < n:
        c = sql[i]

        if quote:
            buf.append(c)
            if c == "\\" and quote != "`" and i + 1 < n:
                buf.append(sql[i + 1])
                i += 2
                continue
            if c == quote:
                if i + 1 < n and sql[i + 1] == quote:   # doubled quote ('' or "")
                    buf.append(sql[i + 1])
                    i += 2
                    continue
                quote = None
            i += 1
            continue

        if c in ("'", '"', "`"):
            quote = c
            buf.append(c)
            i += 1
        elif c == "#" or (c == "-" and sql.startswith("--", i)
                          and (i + 2 >= n or sql[i + 2] in " \t\r\n")):
            end = sql.find("\n", i)
            i = n if end == -1 else end          # skip the comment text
        elif c == "/" and sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            end = n if end == -1 else end + 2
            buf.append(sql[i:end])               # keep (MySQL runs /*! ... */ lines)
            i = end
        elif c == ";":
            flush()
            i += 1
        else:
            buf.append(c)
            i += 1

    flush()
    return statements


def _save_safety_copy(conn):
    """Save the current database to backups/ before it gets replaced."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    text, db_name = build_dump(conn)
    name = f"before_import_{db_name}_{datetime.now():%Y%m%d_%H%M%S}.sql"
    path = os.path.join(BACKUP_DIR, name)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return name


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------
def register_backup_routes(app, get_connection, is_admin):

    @app.route("/api/admin/backup/export", methods=["GET"])
    def backup_export():
        if not is_admin():
            return jsonify(error="Admin access required."), 403

        conn = None
        try:
            conn = get_connection()
            text, db_name = build_dump(conn)
        except Exception as exc:
            return jsonify(error=f"Export failed: {exc}"), 500
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

        filename = f"{db_name}_backup_{datetime.now():%Y%m%d_%H%M%S}.sql"
        return Response(
            text,
            mimetype="application/sql; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )

    @app.route("/api/admin/backup/import", methods=["POST"])
    def backup_import():
        if not is_admin():
            return jsonify(error="Admin access required."), 403

        upload = request.files.get("file")
        if not upload or not upload.filename:
            return jsonify(error="Please choose a .sql file to import."), 400
        if not upload.filename.lower().endswith(".sql"):
            return jsonify(error="Only .sql files can be imported."), 400

        raw = upload.read(MAX_IMPORT_BYTES + 1)
        if len(raw) > MAX_IMPORT_BYTES:
            return jsonify(error="The file is too large (limit is 25 MB)."), 400

        try:
            sql_text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return jsonify(error="The file must be saved as UTF-8."), 400

        if re.search(r"^\s*DELIMITER\s", sql_text, re.IGNORECASE | re.MULTILINE):
            return jsonify(error="Files that use DELIMITER (procedures/triggers) are not supported."), 400

        statements = split_statements(sql_text)
        if not statements:
            return jsonify(error="The file does not contain any SQL statements."), 400

        conn = None
        safety_name = None
        current = 0
        try:
            conn = get_connection()

            # 1) safety copy of what is in the database right now
            safety_name = _save_safety_copy(conn)

            # 2) run the backup file
            cur = conn.cursor()
            cur.execute("SET FOREIGN_KEY_CHECKS=0")
            for current, stmt in enumerate(statements, start=1):
                cur.execute(stmt)
            cur.execute("SET FOREIGN_KEY_CHECKS=1")
            conn.commit()
            cur.close()

            return jsonify(
                message="Database imported successfully.",
                statements=len(statements),
                safety_backup=safety_name,
            )
        except Exception as exc:
            try:
                if conn is not None:
                    conn.rollback()
            except Exception:
                pass
            snippet = statements[current - 1][:80].replace("\n", " ") if current else ""
            detail = f" (statement {current}: {snippet}...)" if current else ""
            hint = (f" Your data from before the import was saved as backups/{safety_name}."
                    if safety_name else "")
            return jsonify(error=f"Import failed: {exc}{detail}.{hint}"), 500
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
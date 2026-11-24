"""Сборка автономного HTML-предпросмотра DB2UI Studio.

Файл содержит разметку, стили и данные проекта. Его можно открыть
двойным кликом на любом компьютере — сервер и PostgreSQL не нужны.
Данные таблиц и пользователи встраиваются в файл как снимок.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent


def _embed_json(value: Any) -> str:
    """JSON, безопасный для вставки внутрь тега <script>."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return text.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def _read_css() -> str:
    try:
        return (BASE_DIR / "static" / "style.css").read_text(encoding="utf-8")
    except OSError:
        return ""


def build_preview_html(
    project: dict[str, Any],
    tables: list[dict[str, Any]],
    rows: dict[str, list[dict[str, Any]]],
    auth_users: list[dict[str, Any]],
    dbname: str,
    sql_results: dict[str, dict[str, Any]] | None = None,
) -> str:
    payload = {
        "project": project,
        "tables": tables,
        "rows": rows,
        "auth_users": auth_users,
        "sql_results": sql_results or {},
        "database": dbname,
    }
    data_json = _embed_json(payload)
    css = _read_css()
    title = str(project.get("name") or dbname or "DB2UI")
    safe_title = (
        title.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{safe_title} — автономный предпросмотр</title>
<style>
{css}
</style>
<style>
  html, body {{ height: 100%; overflow: auto; }}
  body {{ margin: 0; background: #eef1f7; }}
  .sa-top {{ position: sticky; top: 0; z-index: 30; display: flex; align-items: center; gap: 12px;
    height: 56px; padding: 0 18px; background: #fff; border-bottom: 1px solid #e2e8f0;
    box-shadow: 0 1px 2px rgba(16,24,40,.06); }}
  .sa-top .brand {{ font-size: 16px; }}
  .sa-title {{ font-weight: 700; }}
  .sa-muted {{ color: #667085; font-size: 12px; }}
  .sa-top-spacer {{ flex: 1; }}
  .sa-chip {{ background: #eef2ff; color: #4338ca; border: 1px solid #c7d2fe;
    border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600; }}
  .sa-stage {{ min-height: calc(100vh - 56px); display: flex; align-items: flex-start;
    justify-content: center; padding: 34px 18px 60px; }}
  .sa-window {{ background: #fff; border-radius: 12px; box-shadow: 0 24px 80px rgba(16,24,40,.2);
    padding: 12px; max-width: calc(100vw - 36px); overflow: auto; }}
  .sa-form {{ position: relative; transform-origin: top left; overflow: hidden; border-radius: 6px;
    border: 1px solid #dbe3f0; }}
  .sa-form .preview-element {{ position: absolute; }}
  .sa-form .container-body {{ position: absolute; overflow: visible; }}
  .sa-table-wrap {{ height: 100%; overflow: auto; border: 1px solid #e2e8f0; border-radius: 10px; }}
  .sa-table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
  .sa-table th {{ position: sticky; top: 0; background: #f7f9fc; text-align: left;
    padding: 7px 9px; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }}
  .sa-table td {{ padding: 6px 9px; border-bottom: 1px solid #f1f5f9; white-space: nowrap; }}
  .sa-table tr:hover td {{ background: #f8faff; }}
  .sa-empty {{ padding: 18px; color: #98a2b3; }}
  .sa-image {{ width: 100%; height: 100%; display: block; }}
  .sa-login {{ min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; }}
  .sa-login .login-card {{ width: 380px; max-width: 100%; }}
  .sa-link {{ background: none; border: 0; color: #4f46e5; cursor: pointer;
    font-size: 13px; padding: 6px; }}
  .sa-toast {{ position: fixed; right: 18px; bottom: 18px; z-index: 100; max-width: 360px;
    background: #172033; color: #fff; padding: 11px 15px; border-radius: 10px;
    box-shadow: 0 12px 32px rgba(16,24,40,.24); font-size: 13px; }}
  .sa-note {{ font-size: 12px; color: #667085; margin-top: 10px; }}
</style>
</head>
<body>
<div id="sa-app"></div>
<div id="sa-toast" class="sa-toast" hidden></div>
<script id="sa-data" type="application/json">{data_json}</script>
<script>
(function () {{
  'use strict';
  var DATA = JSON.parse(document.getElementById('sa-data').textContent);
  var project = DATA.project || {{}};
  var tables = DATA.tables || [];
  var rowsData = DATA.rows || {{}};
  var sqlResults = DATA.sql_results || {{}};
  var users = DATA.auth_users || [];
  var auth = project.auth || {{}};
  var forms = project.forms || [];
  var state = {{ formId: project.start_form || (forms[0] && forms[0].id), user: null, toastTimer: 0 }};

  function esc(value) {{
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }}
  function attr(value) {{ return esc(value); }}
  function num(value, fallback) {{
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }}
  function findForm(id) {{
    for (var i = 0; i < forms.length; i += 1) if (forms[i].id === id) return forms[i];
    return null;
  }}
  function refOf(table) {{ return (table.schema || 'public') + '|' + table.name; }}
  function tableByRef(ref) {{
    var parts = String(ref || '').split('|');
    if (parts.length !== 2) return null;
    for (var i = 0; i < tables.length; i += 1) {{
      if (tables[i].schema === parts[0] && tables[i].name === parts[1]) return tables[i];
    }}
    return null;
  }}
  function rowsOf(ref) {{ return rowsData[ref] || []; }}
  function showToast(message) {{
    var node = document.getElementById('sa-toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {{ node.hidden = true; }}, 3200);
  }}
  var PANEL_HEADER = 30;
  function panelConfig(element) {{
    var config = element.panel || {{}};
    return {{
      padding: Math.max(0, Math.min(80, Math.round(num(config.padding, 12)))),
      title: String(config.title || ''),
      background: String(config.background || '#f8fafc'),
      border: config.border !== false
    }};
  }}
  function rootFormElement(form) {{
    var list = form.elements || [];
    for (var i = 0; i < list.length; i += 1) {{
      if (list[i].type === 'form' && !list[i].parentId) return list[i];
    }}
    return null;
  }}
  function findElementIn(form, id) {{
    var list = form.elements || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
    return null;
  }}
  function elementChildren(form, parentId) {{
    return (form.elements || []).filter(function (element) {{
      return element.parentId === parentId;
    }});
  }}
  function isContainer(element) {{
    return !!element && (element.type === 'form' || element.type === 'panel');
  }}
  function containerContentSize(container) {{
    var w = Math.max(20, Math.round(num(container && container.w, 300)));
    var h = Math.max(20, Math.round(num(container && container.h, 200)));
    if (!container || container.type !== 'panel') return {{ w: w, h: h }};
    var config = panelConfig(container);
    var head = config.title ? PANEL_HEADER : 0;
    return {{
      w: Math.max(20, w - config.padding * 2),
      h: Math.max(20, h - config.padding * 2 - head)
    }};
  }}
  function containerBodyRect(container) {{
    if (!container || container.type !== 'panel') {{
      return {{ left: 0, top: 0, width: Math.max(20, Math.round(num(container && container.w, 300))),
        height: Math.max(20, Math.round(num(container && container.h, 200))) }};
    }}
    var config = panelConfig(container);
    var head = config.title ? PANEL_HEADER : 0;
    return {{
      left: config.padding,
      top: config.padding + head,
      width: Math.max(20, Math.round(num(container.w, 300)) - config.padding * 2),
      height: Math.max(20, Math.round(num(container.h, 200)) - config.padding * 2 - head)
    }};
  }}
  function containerBodyStyle(container) {{
    var rect = containerBodyRect(container);
    return 'left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width +
      'px;height:' + rect.height + 'px;';
  }}
  function elementStyle(element) {{
    return 'left:' + num(element.x, 0) + 'px;top:' + num(element.y, 0) + 'px;' +
      'width:' + num(element.w, 200) + 'px;height:' + num(element.h, 60) + 'px;';
  }}
  function legacyRect(cell, width, height, layout) {{
    var rows = Math.max(1, Math.min(60, Math.round(num(layout && layout.rows, 6))));
    var cols = Math.max(1, Math.min(24, Math.round(num(layout && layout.cols, 4))));
    var gap = Math.max(0, Math.min(80, Math.round(num(layout && layout.gap, 12))));
    var source = cell || {{}};
    var row = Math.max(1, Math.min(rows, Math.round(num(source.row, 1))));
    var col = Math.max(1, Math.min(cols, Math.round(num(source.col, 1))));
    var rowSpan = Math.max(1, Math.min(rows - row + 1, Math.round(num(source.rowSpan, 1))));
    var colSpan = Math.max(1, Math.min(cols - col + 1, Math.round(num(source.colSpan, 1))));
    var cellW = Math.max(20, (width - gap * (cols - 1)) / cols);
    var cellH = Math.max(20, (height - gap * (rows - 1)) / rows);
    return {{
      x: Math.round((col - 1) * (cellW + gap)),
      y: Math.round((row - 1) * (cellH + gap)),
      w: Math.round(cellW * colSpan + gap * (colSpan - 1)),
      h: Math.round(cellH * rowSpan + gap * (rowSpan - 1))
    }};
  }}
  function ensureHierarchy(form) {{
    var elements = form.elements = form.elements || [];
    var layout = form.layout || {{}};
    var root = rootFormElement(form);
    if (!root) {{
      root = {{
        id: 'sa_root_' + String(form.id || 'form'),
        type: 'form',
        name: form.name || 'Форма',
        x: 0,
        y: 0,
        w: Math.max(320, Math.round(num(form.width, 1180))),
        h: Math.max(240, Math.round(num(form.height, 900))),
        parentId: ''
      }};
      elements.unshift(root);
    }}
    if (layout.mode === 'grid') {{
      elements.forEach(function (element) {{
        if (element === root || element.parentId || !element.cell) return;
        var rect = legacyRect(element.cell, num(form.width, 1180), num(form.height, 900), layout);
        element.x = rect.x;
        element.y = rect.y;
        element.w = rect.w;
        element.h = rect.h;
        delete element.cell;
      }});
    }}
    elements.forEach(function (element) {{
      if (element === root) return;
      if (element.type === 'form' && !element.parentId) {{
        element.type = 'panel';
        element.panel = element.panel || {{}};
      }}
      if (element.parentId && element.cell) {{
        var parent = findElementIn(form, element.parentId);
        if (parent && parent.type === 'panel' && parent.panel) {{
          var content = containerContentSize(parent);
          var inner = legacyRect(element.cell, content.w, content.h, parent.panel);
          element.x = inner.x;
          element.y = inner.y;
          element.w = inner.w;
          element.h = inner.h;
        }}
        delete element.cell;
      }}
      if (!element.parentId) element.parentId = root.id;
    }});
    form.width = Math.round(num(root.w, form.width));
    form.height = Math.round(num(root.h, form.height));
    return root;
  }}
  function selectOptions(element) {{
    var table = tableByRef(element.table);
    if (!table || !element.column) return [];
    var rows = rowsOf(refOf(table));
    var column = null;
    for (var i = 0; i < table.columns.length; i += 1) {{
      if (table.columns[i].name === element.column) column = table.columns[i];
    }}
    var seen = {{}}, result = [];
    if (column && column.references) {{
      var refTable = null;
      for (var t = 0; t < tables.length; t += 1) {{
        if (tables[t].schema === column.references.ref_schema &&
            tables[t].name === column.references.ref_table) refTable = tables[t];
      }}
      if (refTable) {{
        var refRows = rowsOf(refOf(refTable));
        var labelColumn = element.labelColumn;
        if (!labelColumn) {{
          var textTypes = {{ text: 1, varchar: 1, bpchar: 1, char: 1, citext: 1 }};
          var pick = null, fallback = null;
          for (var c = 0; c < refTable.columns.length; c += 1) {{
            var col = refTable.columns[c];
            if (col.is_pk) continue;
            if (!fallback) fallback = col.name;
            if (textTypes[col.udt_name]) {{ pick = col.name; break; }}
          }}
          labelColumn = pick || fallback || '';
        }}
        refRows.forEach(function (row) {{
          var value = row[column.references.ref_column];
          if (value == null) return;
          var key = String(value);
          if (seen[key]) return;
          seen[key] = true;
          result.push({{ value: value, label: labelColumn ? row[labelColumn] : value }});
        }});
      }}
    }} else {{
      rows.forEach(function (row) {{
        var value = row[element.column];
        if (value == null) return;
        var key = String(value);
        if (seen[key]) return;
        seen[key] = true;
        result.push({{ value: value, label: value }});
      }});
    }}
    return result;
  }}
  function elementInner(element, depth, visited) {{
    var type = element.type;
    if (type === 'text') {{
      return '<div class="el-text" style="font-size:' + num(element.fontSize, 20) + 'px;' +
        'font-weight:' + attr(element.fontWeight || '700') + ';color:' + attr(element.color || '#172033') +
        ';text-align:' + attr(element.align || 'left') + ';">' + esc(element.text || '') + '</div>';
    }}
    if (type === 'button') {{
      return '<button type="button" class="el-button" data-sa-button="' + attr(element.id) + '" style="' +
        'background:' + attr(element.color || '#4f46e5') + ';color:' + attr(element.textColor || '#ffffff') +
        ';font-size:' + num(element.fontSize, 14) + 'px;">' + esc(element.text || 'Кнопка') + '</button>';
    }}
    if (type === 'input') {{
      var label = element.label
        ? '<label>' + esc(element.label) + (element.required ? ' <em style="color:#dc2626;font-style:normal">*</em>' : '') + '</label>'
        : '';
      return '<div class="el-input">' + label + '<input class="el-input-control" type="' +
        attr(element.inputType || 'text') + '" placeholder="' + attr(element.placeholder || '') + '"' +
        (element.required ? ' data-required="1"' : '') + ' data-sa-input="' + attr(element.id) + '"></div>';
    }}
    if (type === 'select') {{
      var label2 = element.label
        ? '<label>' + esc(element.label) + (element.required ? ' <em style="color:#dc2626;font-style:normal">*</em>' : '') + '</label>'
        : '';
      var options = selectOptions(element);
      var html = '<option value="">' + esc(element.placeholder || '— выберите —') + '</option>';
      options.forEach(function (option) {{
        html += '<option value="' + attr(option.value) + '">' + esc(option.label) + '</option>';
      }});
      return '<div class="el-input el-select">' + label2 +
        '<select class="el-input-control el-select-control" data-sa-select="' + attr(element.id) + '">' +
        html + '</select></div>';
    }}
    if (type === 'image') {{
      if (element.src) {{
        return '<img class="sa-image" src="' + attr(element.src) + '" alt="' + attr(element.alt || '') +
          '" style="object-fit:' + attr(element.fit || 'contain') + ';border-radius:' +
          num(element.radius, 0) + 'px;">';
      }}
      return '<div class="el-image-empty">🖼<span>Изображение не выбрано</span></div>';
    }}
    if (type === 'table') {{
      return tableHtml(element);
    }}
    if (type === 'sql') {{
      return sqlHtml(element);
    }}
    if (type === 'form' || type === 'panel') {{
      return panelHtml(element, depth, visited);
    }}
    return '<div class="el-text">Неизвестный элемент</div>';
  }}
  function tableHtml(element) {{
    var table = tableByRef(element.table);
    if (!table) {{
      return '<div class="el-table"><div class="el-table-head"><div class="el-table-title">' +
        '<b>' + esc(element.name || 'Таблица') + '</b><small>таблица не выбрана</small></div></div>' +
        '<div class="el-table-body"><div class="sa-empty">Таблица не привязана к базе.</div></div></div>';
    }}
    var rows = rowsOf(refOf(table)).slice(0, num(element.limit, 50));
    var head = '<tr>' + table.columns.map(function (column) {{
      return '<th>' + esc(column.name) + '</th>';
    }}).join('') + '</tr>';
    var body = rows.length
      ? rows.map(function (row) {{
          return '<tr>' + table.columns.map(function (column) {{
            var value = row[column.name];
            return '<td>' + esc(value == null ? '' : value) + '</td>';
          }}).join('') + '</tr>';
        }}).join('')
      : '<tr><td colspan="' + Math.max(1, table.columns.length) + '" class="sa-empty">' +
        'Нет данных в снимке</td></tr>';
    return '<div class="el-table"><div class="el-table-head"><div class="el-table-title">' +
      '<b>' + esc(element.name || table.label || table.name) + '</b><small>' +
      esc(table.name) + ' · ' + rows.length + ' строк</small></div></div>' +
      '<div class="sa-table-wrap"><table class="sa-table"><thead>' + head + '</thead><tbody>' +
      body + '</tbody></table></div></div>';
  }}
  function sqlHtml(element) {{
    var result = sqlResults[element.id] || null;
    var title = '<div class="el-table-head"><div class="el-table-title"><b>' +
      esc(element.name || 'SQL-запрос') + '</b><small>SQL · до ' + num(element.limit, 100) +
      ' строк</small></div></div>';
    if (!result) {{
      return '<div class="el-table el-sql">' + title +
        '<div class="el-table-body"><div class="sa-empty">Результат не сохранён в снимке.</div></div></div>';
    }}
    if (result.error) {{
      return '<div class="el-table el-sql">' + title +
        '<div class="el-table-body"><div class="sa-empty">' + esc(result.error) + '</div></div></div>';
    }}
    var columns2 = result.columns || [];
    var rows2 = result.rows || [];
    if (!rows2.length) {{
      return '<div class="el-table el-sql">' + title +
        '<div class="el-table-body"><div class="sa-empty">Запрос не вернул строк.</div></div></div>';
    }}
    var head2 = '<tr>' + columns2.map(function (column) {{
      return '<th>' + esc(column) + '</th>';
    }}).join('') + '</tr>';
    var body2 = rows2.map(function (row) {{
      return '<tr>' + columns2.map(function (column) {{
        var value = row[column];
        return '<td>' + esc(value == null ? '' : value) + '</td>';
      }}).join('') + '</tr>';
    }}).join('');
    return '<div class="el-table el-sql">' + title +
      '<div class="sa-table-wrap"><table class="sa-table"><thead>' + head2 + '</thead><tbody>' +
      body2 + '</tbody></table></div></div>';
  }}
  function elementWrapper(element, depth, visited) {{
    var classes = 'preview-element' + (isContainer(element) ? ' container-el' : '');
    return '<div class="' + classes + '" data-id="' + attr(element.id) + '" style="' +
      elementStyle(element) + '">' + elementInner(element, depth, visited) + '</div>';
  }}
  function containerBodyHtml(form, element, depth, visited) {{
    var next = {{}};
    Object.keys(visited || {{}}).forEach(function (key) {{ next[key] = true; }});
    next[element.id] = true;
    var content = elementChildren(form, element.id).filter(function (child) {{
      return !next[child.id];
    }}).map(function (child) {{
      return elementWrapper(child, depth + 1, next);
    }}).join('');
    return '<div class="container-body" style="' + containerBodyStyle(element) + '">' + content + '</div>';
  }}
  function panelHtml(element, depth, visited) {{
    var form = findForm(state.formId);
    if (!form) return '<div class="el-panel"></div>';
    var config = panelConfig(element);
    var count = elementChildren(form, element.id).length;
    var title = config.title
      ? '<div class="panel-head"><span>' + esc(config.title) + '</span><small>' +
        count + ' эл.</small></div>'
      : '';
    return '<div class="el-panel' + (config.border ? ' bordered' : '') +
      '" style="background:' + attr(config.background) + '">' + title +
      containerBodyHtml(form, element, depth, visited) + '</div>';
  }}
  function surface(form) {{
    var root = ensureHierarchy(form);
    var visited = {{}};
    visited[form.id] = true;
    visited[root.id] = true;
    var content = elementChildren(form, root.id).filter(function (element) {{
      return !visited[element.id];
    }}).map(function (element) {{
      return elementWrapper(element, 0, visited);
    }}).join('');
    return '<div class="sa-form preview-form-surface" data-form-id="' + attr(form.id) +
      '" style="width:' + Math.round(num(root.w, 1180)) + 'px;height:' +
      Math.round(num(root.h, 900)) + 'px;background:' + attr(form.background || '#ffffff') +
      ';">' + content + '</div>';
  }}
  function renderForm(formId) {{
    var form = findForm(formId) || findForm(project.start_form) || forms[0];
    if (!form) return;
    state.formId = form.id;
    var app = document.getElementById('sa-app');
    var userChip = state.user
      ? '<span class="sa-chip">' + esc(state.user.login) + (state.user.role ? ' · ' + esc(state.user.role) : '') + '</span>'
      : '';
    app.innerHTML =
      '<header class="sa-top"><div class="brand">DB2UI <span>Studio</span></div>' +
      '<div><div class="sa-title">' + esc(form.name) + '</div>' +
      '<div class="sa-muted">автономный предпросмотр · ' + esc(DATA.database || '') + '</div></div>' +
      '<div class="sa-top-spacer"></div>' + userChip +
      '<button type="button" class="btn btn-ghost btn-sm" data-sa-home>⌂ На главную</button>' +
      (state.user ? '<button type="button" class="btn btn-ghost btn-sm" data-sa-logout>Выйти</button>' : '') +
      '</header><main class="sa-stage"><div class="sa-window">' + surface(form) +
      '</div></main>';
    var canvas = app.querySelector('.sa-window');
    if (canvas) canvas.dataset.formId = form.id;
  }}
  function showLogin() {{
    var app = document.getElementById('sa-app');
    var allow = auth.allow_registration !== false;
    app.innerHTML =
      '<div class="sa-login"><form class="login-card" id="sa-login-form" autocomplete="on">' +
      '<div class="brand brand-lg">DB2UI <span>Studio</span></div>' +
      '<h2>' + esc(auth.title || 'Вход в приложение') + '</h2>' +
      '<p class="muted">' + esc(auth.welcome || 'Войдите, чтобы открыть интерфейс приложения.') + '</p>' +
      '<label class="field"><span>Логин</span><input name="login" required autocomplete="username"></label>' +
      '<label class="field"><span>Пароль</span><input name="password" type="password" required autocomplete="current-password"></label>' +
      '<div class="error-box" id="sa-auth-error" hidden></div>' +
      '<button type="submit" class="btn btn-primary btn-block">Войти</button>' +
      (allow ? '<button type="button" class="sa-link" id="sa-show-register">Создать аккаунт</button>' : '') +
      '<div class="sa-note">Автономный файл: регистрация действует только до закрытия страницы.</div>' +
      '</form></div>';
    var form = document.getElementById('sa-login-form');
    form.addEventListener('submit', function (event) {{
      event.preventDefault();
      verifyLogin(form);
    }});
    var register = document.getElementById('sa-show-register');
    if (register) register.addEventListener('click', showRegister);
  }}
  function showRegister() {{
    var app = document.getElementById('sa-app');
    app.innerHTML =
      '<div class="sa-login"><form class="login-card" id="sa-register-form" autocomplete="off">' +
      '<div class="brand brand-lg">DB2UI <span>Studio</span></div>' +
      '<h2>Регистрация</h2>' +
      '<p class="muted">Создайте локальную учётную запись для просмотра файла.</p>' +
      '<label class="field"><span>Логин</span><input name="login" required minlength="3" maxlength="64"></label>' +
      '<label class="field"><span>Пароль</span><input name="password" type="password" required minlength="4"></label>' +
      '<label class="field"><span>Повторите пароль</span><input name="password2" type="password" required minlength="4"></label>' +
      '<div class="error-box" id="sa-auth-error" hidden></div>' +
      '<button type="submit" class="btn btn-primary btn-block">Зарегистрироваться</button>' +
      '<button type="button" class="sa-link" id="sa-show-login">← Уже есть аккаунт</button>' +
      '</form></div>';
    var form = document.getElementById('sa-register-form');
    form.addEventListener('submit', function (event) {{
      event.preventDefault();
      var login = String(form.login.value || '').trim();
      var password = String(form.password.value || '');
      var password2 = String(form.password2.value || '');
      var error = document.getElementById('sa-auth-error');
      error.hidden = true;
      if (login.length < 3) {{ error.textContent = 'Логин должен быть не короче 3 символов.'; error.hidden = false; return; }}
      if (password.length < 4) {{ error.textContent = 'Пароль должен быть не короче 4 символов.'; error.hidden = false; return; }}
      if (password !== password2) {{ error.textContent = 'Пароли не совпадают.'; error.hidden = false; return; }}
      for (var i = 0; i < users.length; i += 1) {{
        if (users[i].login === login) {{ error.textContent = 'Такой логин уже существует.'; error.hidden = false; return; }}
      }}
      users.push({{ login: login, role: 'user', secret: password, mode: 'plain' }});
      state.user = {{ login: login, role: 'user' }};
      showToast('Аккаунт создан (только для этого файла)');
      renderForm(state.formId);
    }});
    var loginLink = document.getElementById('sa-show-login');
    if (loginLink) loginLink.addEventListener('click', showLogin);
  }}
  function verifyLogin(form) {{
    var login = String(form.login.value || '').trim();
    var password = String(form.password.value || '');
    var error = document.getElementById('sa-auth-error');
    error.hidden = true;
    if (!login || !password) {{
      error.textContent = 'Введите логин и пароль.';
      error.hidden = false;
      return;
    }}
    var found = null;
    for (var i = 0; i < users.length; i += 1) if (users[i].login === login) found = users[i];
    if (!found) {{
      error.textContent = 'Неверный логин или пароль.';
      error.hidden = false;
      return;
    }}
    var finish = function (ok) {{
      if (!ok) {{
        error.textContent = 'Неверный логин или пароль.';
        error.hidden = false;
        return;
      }}
      state.user = {{ login: found.login, role: found.role || '' }};
      renderForm(state.formId);
      showToast('Добро пожаловать, ' + found.login);
    }};
    if (found.mode === 'sha256') {{
      sha256(password).then(function (digest) {{ finish(digest === String(found.secret || '').toLowerCase()); }});
    }} else {{
      finish(String(found.secret) === password);
    }}
  }}
  function sha256(text) {{
    if (window.crypto && window.crypto.subtle) {{
      return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buffer) {{
        return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {{
          return byte.toString(16).padStart(2, '0');
        }}).join('');
      }}).catch(function () {{ return ''; }});
    }}
    return Promise.resolve('');
  }}
  function isAuthorized() {{
    if (!auth.enabled) return true;
    var configured = auth.table && auth.login_column && auth.password_column;
    if (!configured) return true;
    return !!state.user;
  }}
  function boot() {{
    if (!forms.length) {{
      document.getElementById('sa-app').innerHTML = '<div class="sa-empty">В проекте нет форм.</div>';
      return;
    }}
    if (!isAuthorized()) showLogin();
    else renderForm(state.formId);
  }}
  function saAuthFields() {{
    var form = findForm(state.formId);
    var inputs = [];
    if (form) {{
      (form.elements || []).forEach(function (element) {{
        if (element.type !== 'input') return;
        var node = document.querySelector('[data-sa-input="' + element.id + '"]');
        if (node) inputs.push({{ element: element, node: node }});
      }});
    }}
    var find = function (pattern) {{
      for (var i = 0; i < inputs.length; i += 1) {{
        var data = inputs[i].element;
        if (pattern.test([data.name, data.label, data.column, data.placeholder].join(' '))) {{
          return inputs[i];
        }}
      }}
      return null;
    }};
    return {{
      login: find(/login|логин|user|пользов/i) || inputs[0] || null,
      password: find(/pass|парол|pwd/i) || inputs[1] || null
    }};
  }}
  function saPostLoginForm(element, role) {{
    var needle = String(role || '').trim().toLowerCase();
    var routes = Array.isArray(element.roleRoutes) ? element.roleRoutes : [];
    if (needle) {{
      for (var i = 0; i < routes.length; i += 1) {{
        var route = routes[i] || {{}};
        if (String(route.role || '').trim().toLowerCase() === needle &&
            findForm(route.formId)) {{
          return route.formId;
        }}
      }}
    }}
    if (element.postLoginForm && findForm(element.postLoginForm)) {{
      return element.postLoginForm;
    }}
    return project.start_form;
  }}
  function saFormAuth(element) {{
    var fields = saAuthFields();
    var login = fields.login ? String(fields.login.node.value || '').trim() : '';
    var password = fields.password ? String(fields.password.node.value || '') : '';
    if (!login || !password) {{
      showToast('Заполните логин и пароль.');
      return;
    }}
    var action = element.action;
    var go = function (user) {{
      state.user = {{ login: user.login, role: user.role || '' }};
      if (fields.login) fields.login.node.value = '';
      if (fields.password) fields.password.node.value = '';
      renderForm(saPostLoginForm(element, state.user.role));
      showToast((action === 'register' ? 'Аккаунт создан: ' : 'Вы вошли как ') + user.login);
    }};
    if (action === 'register') {{
      if (password.length < 4) {{
        showToast('Пароль должен содержать не менее 4 символов.');
        return;
      }}
      for (var i = 0; i < users.length; i += 1) {{
        if (users[i].login === login) {{
          showToast('Такой логин уже существует.');
          return;
        }}
      }}
      var created = {{ login: login, role: 'user', secret: password, mode: 'plain' }};
      users.push(created);
      go(created);
      return;
    }}
    var found = null;
    for (var j = 0; j < users.length; j += 1) {{
      if (users[j].login === login) found = users[j];
    }}
    if (!found) {{
      showToast('Неверный логин или пароль.');
      return;
    }}
    var finish = function (ok) {{
      if (!ok) {{
        showToast('Неверный логин или пароль.');
        return;
      }}
      go(found);
    }};
    if (found.mode === 'sha256') {{
      sha256(password).then(function (digest) {{
        finish(digest === String(found.secret || '').toLowerCase());
      }});
    }} else {{
      finish(String(found.secret) === password);
    }}
  }}
  document.addEventListener('click', function (event) {{
    if (event.target.closest('[data-sa-home]')) {{
      renderForm(project.start_form);
      return;
    }}
    if (event.target.closest('[data-sa-logout]')) {{
      state.user = null;
      if (auth.enabled) showLogin(); else renderForm(state.formId);
      return;
    }}
    var button = event.target.closest('[data-sa-button]');
    if (!button) return;
    var id = button.getAttribute('data-sa-button');
    var element = null;
    forms.forEach(function (form) {{
      (form.elements || []).forEach(function (item) {{ if (item.id === id) element = item; }});
    }});
    if (!element) return;
    var action = element.action || 'navigate';
    if (action === 'navigate' && findForm(element.targetForm)) renderForm(element.targetForm);
    else if (action === 'home') renderForm(project.start_form);
    else if (action === 'logout') {{
      state.user = null;
      if (auth.enabled) showLogin(); else renderForm(state.formId);
    }} else if (action === 'login' || action === 'register') saFormAuth(element);
    else if (action === 'insert') showToast('Автономный файл только для чтения: запись не сохраняется.');
    else if (action === 'refresh') showToast('Данные взяты из снимка при экспорте.');
  }});
  boot();
}})();
</script>
</body>
</html>"""

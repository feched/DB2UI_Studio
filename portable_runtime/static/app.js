(function () {
  'use strict';

  /* =======================================================================
     Состояние
     ======================================================================= */

  var state = {
    project: null,
    tables: [],
    connected: false,
    database: '',
    config: {},
    auth: { enabled: false, configured: false, authenticated: false, user: null },
    formId: null,
    view: 'boot',
    authMode: 'login',
    dialog: null,
    lastError: '',
    toastTimer: 0,
    resizeObserver: null,
  };

  var ROW_CACHE = new Map();
  var CACHE_TTL = 8000;
  var PANEL_HEADER = 30;
  var TEXTAREA_TYPES = new Set(['text', 'json', 'jsonb', 'xml']);
  var NUMERIC_TYPES = new Set([
    'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'money', 'oid',
  ]);
  var SSL_MODES = [
    ['prefer', 'prefer (по умолчанию)'],
    ['disable', 'disable'],
    ['allow', 'allow'],
    ['require', 'require'],
    ['verify-ca', 'verify-ca'],
    ['verify-full', 'verify-full'],
  ];

  /* =======================================================================
     Мелкие помощники
     ======================================================================= */

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function attr(value) {
    return esc(value);
  }

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function nodeByData(root, name, value) {
    var nodes = (root || document).querySelectorAll('[' + name + ']');
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].getAttribute(name) === String(value)) return nodes[i];
    }
    return null;
  }

  function api(path, options) {
    var opts = options || {};
    var headers = {};
    Object.keys(opts.headers || {}).forEach(function (key) {
      headers[key] = opts.headers[key];
    });
    if (opts.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      credentials: 'same-origin',
      cache: 'no-store',
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (error) {
            data = null;
          }
        }
        if (!response.ok) {
          var message = (data && (data.error || data.message)) ||
            ('Ошибка ' + response.status);
          var failure = new Error(message);
          failure.status = response.status;
          throw failure;
        }
        return data;
      });
    });
  }

  function toast(message, kind) {
    var node = $('#rt-toast');
    if (!node) return;
    node.textContent = String(message || '');
    node.className = 'rt-toast' + (kind ? ' ' + kind : '');
    node.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      node.hidden = true;
    }, 3400);
  }

  function showError(selector, message) {
    var node = $(selector);
    if (!node) return;
    node.textContent = String(message || '');
    node.hidden = !message;
  }

  function hideError(selector) {
    showError(selector, '');
  }

  /* =======================================================================
     Проект: формы, элементы, геометрия
     ======================================================================= */

  function findForm(id) {
    var forms = (state.project && state.project.forms) || [];
    for (var i = 0; i < forms.length; i += 1) {
      if (forms[i].id === id) return forms[i];
    }
    return null;
  }

  function findElementIn(form, id) {
    var list = (form && form.elements) || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function findElementAnywhere(id) {
    var forms = (state.project && state.project.forms) || [];
    for (var i = 0; i < forms.length; i += 1) {
      var found = findElementIn(forms[i], id);
      if (found) return found;
    }
    return null;
  }

  function currentForm() {
    return findForm(state.formId) ||
      findForm(state.project && state.project.start_form) ||
      ((state.project && state.project.forms && state.project.forms[0]) || null);
  }

  function refOf(table) {
    return (table.schema || 'public') + '|' + table.name;
  }

  function tableRefOf(value) {
    return String(value || '');
  }

  function tableByRef(ref) {
    var parts = String(ref || '').split('|');
    if (parts.length !== 2) return null;
    for (var i = 0; i < state.tables.length; i += 1) {
      if (state.tables[i].schema === parts[0] && state.tables[i].name === parts[1]) {
        return state.tables[i];
      }
    }
    return null;
  }

  function rootFormElement(form) {
    var list = (form && form.elements) || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].type === 'form' && !list[i].parentId) return list[i];
    }
    return null;
  }

  function elementChildren(form, parentId) {
    return ((form && form.elements) || []).filter(function (element) {
      return element.parentId === parentId;
    });
  }

  function isContainer(element) {
    return !!element && (element.type === 'form' || element.type === 'panel');
  }

  function panelConfig(element) {
    var config = element.panel || {};
    return {
      padding: Math.max(0, Math.min(80, Math.round(num(config.padding, 12)))),
      title: String(config.title || ''),
      background: String(config.background || '#f8fafc'),
      border: config.border !== false,
    };
  }

  function containerContentSize(container) {
    var w = Math.max(20, Math.round(num(container && container.w, 300)));
    var h = Math.max(20, Math.round(num(container && container.h, 200)));
    if (!container || container.type !== 'panel') return { w: w, h: h };
    var config = panelConfig(container);
    var head = config.title ? PANEL_HEADER : 0;
    return {
      w: Math.max(20, w - config.padding * 2),
      h: Math.max(20, h - config.padding * 2 - head),
    };
  }

  function containerBodyRect(container) {
    if (!container || container.type !== 'panel') {
      return {
        left: 0,
        top: 0,
        width: Math.max(20, Math.round(num(container && container.w, 300))),
        height: Math.max(20, Math.round(num(container && container.h, 200))),
      };
    }
    var config = panelConfig(container);
    var head = config.title ? PANEL_HEADER : 0;
    return {
      left: config.padding,
      top: config.padding + head,
      width: Math.max(20, Math.round(num(container.w, 300)) - config.padding * 2),
      height: Math.max(
        20,
        Math.round(num(container.h, 200)) - config.padding * 2 - head
      ),
    };
  }

  function containerBodyStyle(container) {
    var rect = containerBodyRect(container);
    return 'left:' + rect.left + 'px;top:' + rect.top + 'px;width:' +
      rect.width + 'px;height:' + rect.height + 'px;';
  }

  function elementStyle(element) {
    return 'left:' + num(element.x, 0) + 'px;top:' + num(element.y, 0) +
      'px;width:' + num(element.w, 200) + 'px;height:' + num(element.h, 60) + 'px;';
  }

  function legacyRect(cell, width, height, layout) {
    var rows = Math.max(1, Math.min(60, Math.round(num(layout && layout.rows, 6))));
    var cols = Math.max(1, Math.min(24, Math.round(num(layout && layout.cols, 4))));
    var gap = Math.max(0, Math.min(80, Math.round(num(layout && layout.gap, 12))));
    var source = cell || {};
    var row = Math.max(1, Math.min(rows, Math.round(num(source.row, 1))));
    var col = Math.max(1, Math.min(cols, Math.round(num(source.col, 1))));
    var rowSpan = Math.max(1, Math.min(rows - row + 1, Math.round(num(source.rowSpan, 1))));
    var colSpan = Math.max(1, Math.min(cols - col + 1, Math.round(num(source.colSpan, 1))));
    var cellW = Math.max(20, (width - gap * (cols - 1)) / cols);
    var cellH = Math.max(20, (height - gap * (rows - 1)) / rows);
    return {
      x: Math.round((col - 1) * (cellW + gap)),
      y: Math.round((row - 1) * (cellH + gap)),
      w: Math.round(cellW * colSpan + gap * (colSpan - 1)),
      h: Math.round(cellH * rowSpan + gap * (rowSpan - 1)),
    };
  }

  function ensureHierarchy(form) {
    var elements = form.elements = form.elements || [];
    var layout = form.layout || {};
    var root = rootFormElement(form);
    if (!root) {
      root = {
        id: 'rt_root_' + String(form.id || 'form'),
        type: 'form',
        name: form.name || 'Форма',
        x: 0,
        y: 0,
        w: Math.max(320, Math.round(num(form.width, 1180))),
        h: Math.max(240, Math.round(num(form.height, 900))),
        parentId: '',
      };
      elements.unshift(root);
    }
    if (layout.mode === 'grid') {
      elements.forEach(function (element) {
        if (element === root || element.parentId || !element.cell) return;
        var rect = legacyRect(
          element.cell,
          num(form.width, 1180),
          num(form.height, 900),
          layout
        );
        element.x = rect.x;
        element.y = rect.y;
        element.w = rect.w;
        element.h = rect.h;
        delete element.cell;
      });
    }
    elements.forEach(function (element) {
      if (element === root) return;
      if (element.type === 'form' && !element.parentId) {
        element.type = 'panel';
        element.panel = element.panel || {};
      }
      if (element.parentId && element.cell) {
        var parent = findElementIn(form, element.parentId);
        if (parent && parent.type === 'panel' && parent.panel) {
          var content = containerContentSize(parent);
          var inner = legacyRect(element.cell, content.w, content.h, parent.panel);
          element.x = inner.x;
          element.y = inner.y;
          element.w = inner.w;
          element.h = inner.h;
        }
        delete element.cell;
      }
      if (!element.parentId) element.parentId = root.id;
    });
    form.width = Math.round(num(root.w, form.width));
    form.height = Math.round(num(root.h, form.height));
    return root;
  }

  function prepareProject() {
    var forms = (state.project && state.project.forms) || [];
    forms.forEach(function (form) {
      ensureHierarchy(form);
    });
  }

  /* =======================================================================
     Разметка формы
     ======================================================================= */

  function elementWrapper(element, depth, visited, form) {
    var classes = 'preview-element' + (isContainer(element) ? ' container-el' : '');
    var next = new Set(visited);
    next.add(element.id);
    return '<div class="' + classes + '" data-id="' + attr(element.id) +
      '" data-form-id="' + attr(form.id) + '" style="' + elementStyle(element) + '">' +
      elementInner(element, depth, next, form) + '</div>';
  }

  function containerBodyHtml(form, element, depth, visited) {
    var next = new Set(visited);
    next.add(element.id);
    var content = elementChildren(form, element.id)
      .filter(function (child) { return !next.has(child.id); })
      .map(function (child) {
        return elementWrapper(child, depth + 1, next, form);
      })
      .join('');
    return '<div class="container-body" style="' + containerBodyStyle(element) + '">' +
      content + '</div>';
  }

  function panelHtml(element, depth, visited, form) {
    var config = panelConfig(element);
    var count = elementChildren(form, element.id).length;
    var title = config.title
      ? '<div class="panel-head"><span>' + esc(config.title) + '</span><small>' +
        count + ' эл.</small></div>'
      : '';
    return '<div class="el-panel' + (config.border ? ' bordered' : '') +
      '" style="background:' + attr(config.background) + '">' + title +
      containerBodyHtml(form, element, depth, visited) + '</div>';
  }

  function tableInner(element) {
    var table = tableByRef(element.table);
    var subtitle = table ? table.label : '⚠ таблица не выбрана';
    var canAdd = table && element.editable !== false && element.allowAdd !== false;
    var actions = '';
    if (table) {
      actions += canAdd
        ? '<button type="button" class="mini-btn primary" data-rt-act="add">＋ Добавить</button>'
        : '';
      actions += '<button type="button" class="mini-btn" data-rt-act="reload" ' +
        'title="Обновить данные">↻</button>';
    }
    return '<div class="el-table">' +
      '<div class="el-table-head">' +
      '<div class="el-table-title"><b>' + esc(element.name || 'Таблица') + '</b>' +
      '<small>' + esc(subtitle) + '</small></div>' +
      '<div class="el-table-actions">' + actions + '</div>' +
      '</div>' +
      '<div class="el-table-body" data-rt-table-body="' + attr(element.id) + '">' +
      '<div class="table-loading">Загрузка данных…</div></div>' +
      '</div>';
  }

  function sqlInner(element) {
    var subtitle = 'SQL-запрос · до ' +
      clamp(Math.round(num(element.limit, 100)), 1, 500) + ' строк';
    return '<div class="el-table el-sql" title="' + attr(element.query || '') + '">' +
      '<div class="el-table-head">' +
      '<div class="el-table-title"><b>' + esc(element.name || 'SQL-запрос') + '</b>' +
      '<small>' + esc(subtitle) + '</small></div>' +
      '<div class="el-table-actions">' +
      '<button type="button" class="mini-btn" data-rt-act="sql-run" ' +
      'title="Выполнить запрос заново">↻</button>' +
      '</div></div>' +
      '<div class="el-table-body el-sql-body" data-rt-sql-body="' + attr(element.id) + '">' +
      '<div class="table-loading">Выполнение запроса…</div></div>' +
      '</div>';
  }

  function elementInner(element, depth, visited, form) {
    if (element.type === 'text') {
      return '<div class="el-text" style="font-size:' + num(element.fontSize, 20) +
        'px;font-weight:' + attr(element.fontWeight || '700') +
        ';color:' + attr(element.color || '#172033') +
        ';text-align:' + attr(element.align || 'left') + ';">' +
        esc(element.text || '') + '</div>';
    }

    if (element.type === 'button') {
      return '<button type="button" class="el-button" data-rt-button="' +
        attr(element.id) + '" style="background:' + attr(element.color || '#4f46e5') +
        ';color:' + attr(element.textColor || '#ffffff') +
        ';font-size:' + num(element.fontSize, 14) + 'px;">' +
        esc(element.text || 'Кнопка') + '</button>';
    }

    if (element.type === 'input') {
      var label = element.label
        ? '<label>' + esc(element.label) +
          (element.required
            ? ' <em style="color:#dc2626;font-style:normal">*</em>'
            : '') + '</label>'
        : '';
      return '<div class="el-input">' + label +
        '<input class="el-input-control" type="' + attr(element.inputType || 'text') +
        '" placeholder="' + attr(element.placeholder || '') + '"' +
        (element.required ? ' data-required="1"' : '') +
        ' data-rt-input="' + attr(element.id) + '" autocomplete="off"></div>';
    }

    if (element.type === 'select') {
      var selectLabel = element.label
        ? '<label>' + esc(element.label) +
          (element.required
            ? ' <em style="color:#dc2626;font-style:normal">*</em>'
            : '') + '</label>'
        : '';
      return '<div class="el-input el-select">' + selectLabel +
        '<select class="el-input-control el-select-control" data-rt-select="' +
        attr(element.id) + '"' + (element.required ? ' data-required="1"' : '') + '>' +
        '<option value="">' + esc(element.placeholder || '— выберите —') +
        '</option></select></div>';
    }

    if (element.type === 'image') {
      if (element.src) {
        return '<img class="el-image" src="' + attr(element.src) + '" alt="' +
          attr(element.alt || '') + '" draggable="false" style="object-fit:' +
          attr(element.fit || 'contain') + ';border-radius:' +
          num(element.radius, 0) + 'px">';
      }
      return '<div class="el-image-empty">🖼<span>Изображение не выбрано</span></div>';
    }

    if (element.type === 'table') return tableInner(element);
    if (element.type === 'sql') return sqlInner(element);
    if (element.type === 'form' || element.type === 'panel') {
      return panelHtml(element, depth, visited, form);
    }
    return '<div class="el-text">Неизвестный элемент</div>';
  }

  function surfaceHtml(form) {
    var root = ensureHierarchy(form);
    var visited = new Set([form.id, root.id]);
    return elementChildren(form, root.id)
      .filter(function (element) { return !visited.has(element.id); })
      .map(function (element) {
        return elementWrapper(element, 0, visited, form);
      })
      .join('');
  }

  /* =======================================================================
     Оболочка приложения
     ======================================================================= */

  function fitSurface() {
    var stage = $('.rt-stage');
    var viewport = $('#rt-viewport');
    var surface = $('#rt-surface');
    var windowNode = $('#rt-window');
    if (!stage || !viewport || !surface || !windowNode) return;

    var width = num(surface.dataset.w, 1180);
    var height = num(surface.dataset.h, 900);
    var available = stage.clientWidth - 50;
    var scale = available > 0 ? Math.min(1, available / width) : 1;
    if (!isFinite(scale) || scale <= 0) scale = 1;
    scale = Math.max(0.35, scale);

    surface.style.transform = 'scale(' + scale + ')';
    var scaledWidth = Math.round(width * scale);
    var scaledHeight = Math.round(height * scale);
    viewport.style.width = scaledWidth + 'px';
    viewport.style.height = scaledHeight + 'px';
    windowNode.style.width = scaledWidth + 2 + 'px';
    var size = $('#rt-window-size');
    if (size) {
      size.textContent = width + ' × ' + height + ' px' +
        (scale < 0.999 ? ' · ' + Math.round(scale * 100) + '%' : '');
    }
  }

  function headerHtml(form) {
    var user = state.user;
    var dbName = state.database || (state.config && state.config.dbname) || 'База данных';
    return '<header class="rt-header">' +
      '<div class="rt-logo">DB2UI <span>App</span></div>' +
      '<div class="rt-head-text">' +
      '<div class="rt-app-name">' +
      esc((state.project && state.project.name) || 'Приложение') + '</div>' +
      '<div class="rt-form-name">' + esc(form.name) + '</div>' +
      '</div>' +
      '<div class="rt-head-spacer"></div>' +
      '<button type="button" class="rt-db" data-rt-action="settings" ' +
      'title="Подключение к базе данных">' +
      '<span class="rt-dot' + (state.connected ? '' : ' off') + '"></span>' +
      '<span>' + esc(dbName) + '</span></button>' +
      (user
        ? '<span class="rt-user" title="Вы вошли в приложение">' +
          esc(user.login) + (user.role ? ' · ' + esc(user.role) : '') + '</span>'
        : '') +
      '<button type="button" class="btn btn-ghost btn-sm" data-rt-action="refresh" ' +
      'title="Обновить данные на форме"><span>↻</span> <span>Обновить</span></button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-rt-action="home" ' +
      'title="Открыть стартовую форму"><span>⌂</span> <span>На главную</span></button>' +
      (user
        ? '<button type="button" class="btn btn-ghost btn-sm" data-rt-action="logout">' +
          'Выйти</button>'
        : '') +
      '<button type="button" class="btn btn-ghost btn-sm rt-settings" ' +
      'data-rt-action="settings" title="Настройки подключения">⚙</button>' +
      '</header>';
  }

  function renderApp(formId) {
    var form = findForm(formId) ||
      findForm(state.project && state.project.start_form) ||
      ((state.project && state.project.forms && state.project.forms[0]) || null);
    if (!form) {
      renderFatal('В проекте нет форм.');
      return;
    }
    state.view = 'app';
    state.formId = form.id;
    var root = ensureHierarchy(form);
    var width = Math.round(num(root.w, form.width || 1180));
    var height = Math.round(num(root.h, form.height || 900));
    var title = (state.project && state.project.name) || 'Приложение';
    document.title = title + ' — ' + form.name;

    var app = $('#rt-app');
    app.innerHTML = headerHtml(form) +
      '<main class="rt-stage">' +
      '<div class="rt-window" id="rt-window">' +
      '<div class="rt-window-bar">' +
      '<span class="window-dot"></span>' +
      '<span class="rt-window-title" id="rt-window-title">' + esc(form.name) + '</span>' +
      '<span class="rt-window-size" id="rt-window-size">' + width + ' × ' + height + ' px</span>' +
      '</div>' +
      '<div class="rt-viewport" id="rt-viewport">' +
      '<div class="rt-form" id="rt-surface" data-w="' + width + '" data-h="' + height + '" ' +
      'style="width:' + width + 'px;height:' + height + 'px;background:' +
      attr(form.background || '#ffffff') + ';">' + surfaceHtml(form) + '</div>' +
      '</div></div></main>';

    // Сразу загружаем данные, не дожидаясь кадра: в фоновой вкладке
    // requestAnimationFrame может быть приостановлен браузером.
    fitSurface();
    hydrateCurrent(form, false);

    requestAnimationFrame(function () {
      fitSurface();
    });

    if (window.ResizeObserver) {
      if (state.resizeObserver) state.resizeObserver.disconnect();
      state.resizeObserver = new ResizeObserver(function () {
        if (state.view === 'app') fitSurface();
      });
      var stageNode = $('.rt-stage');
      if (stageNode) state.resizeObserver.observe(stageNode);
    }
  }

  /* =======================================================================
     Подключение к базе
     ======================================================================= */

  function connectionField(label, name, value, options) {
    var opts = options || {};
    var control;
    if (opts.type === 'select') {
      control = '<select name="' + attr(name) + '">' +
        (opts.options || []).map(function (pair) {
          return '<option value="' + attr(pair[0]) + '"' +
            (String(value) === String(pair[0]) ? ' selected' : '') + '>' +
            esc(pair[1]) + '</option>';
        }).join('') + '</select>';
    } else {
      control = '<input name="' + attr(name) + '" type="' + attr(opts.type || 'text') +
        '" value="' + attr(value == null ? '' : value) + '"' +
        (opts.placeholder ? ' placeholder="' + attr(opts.placeholder) + '"' : '') +
        (opts.required ? ' required' : '') +
        (opts.min != null ? ' min="' + attr(opts.min) + '"' : '') +
        (opts.max != null ? ' max="' + attr(opts.max) + '"' : '') +
        (opts.autocomplete ? ' autocomplete="' + attr(opts.autocomplete) + '"' : '') +
        '>';
    }
    return '<label class="field' + (opts.full ? ' full' : '') + '">' +
      '<span>' + esc(label) + '</span>' + control + '</label>';
  }

  function connectionFieldsHtml(config, withRemember) {
    var cfg = config || {};
    var hasPassword = !!cfg.has_password;
    return '<div class="rt-conn-grid">' +
      connectionField('Сервер', 'host', cfg.host || 'localhost', {
        required: true, autocomplete: 'off',
      }) +
      connectionField('Порт', 'port', cfg.port || 5432, {
        type: 'number', min: 1, max: 65535, required: true,
      }) +
      connectionField('База данных', 'dbname', cfg.dbname || '', {
        required: true, autocomplete: 'off', full: true,
      }) +
      connectionField('Пользователь', 'user', cfg.user || '', {
        required: true, autocomplete: 'username',
      }) +
      connectionField('Пароль', 'password', '', {
        type: 'password',
        placeholder: hasPassword ? 'сохранён — оставьте пустым' : '',
        autocomplete: 'current-password',
      }) +
      connectionField('SSL', 'sslmode', cfg.sslmode || 'prefer', {
        type: 'select', options: SSL_MODES,
      }) +
      (withRemember
        ? '<label class="rt-check full"><input type="checkbox" name="remember" checked>' +
          '<span>Запомнить подключение на этом компьютере</span></label>'
        : '') +
      '</div>' +
      '<p class="rt-note">Параметры подключения хранятся только в файле ' +
      '<b>data/config.json</b> рядом с приложением. Пароль никуда не отправляется, ' +
      'кроме вашего PostgreSQL.</p>';
  }

  function readConnectionForm(form) {
    var elements = form.elements;
    return {
      host: String((elements.host && elements.host.value) || '').trim(),
      port: Number((elements.port && elements.port.value) || 5432),
      dbname: String((elements.dbname && elements.dbname.value) || '').trim(),
      user: String((elements.user && elements.user.value) || '').trim(),
      password: String((elements.password && elements.password.value) || ''),
      sslmode: String((elements.sslmode && elements.sslmode.value) || 'prefer'),
      remember: elements.remember ? !!elements.remember.checked : true,
    };
  }

  function renderConnection(message) {
    state.view = 'connect';
    var projectName = (state.project && state.project.name) || 'Приложение';
    var app = $('#rt-app');
    app.innerHTML = '<div class="rt-page"><div class="rt-connect-card">' +
      '<div class="brand brand-lg">DB2UI <span>App</span></div>' +
      '<h1>Подключение к базе данных</h1>' +
      '<p class="muted">Приложение «' + esc(projectName) + '» хранит данные в PostgreSQL. ' +
      'Укажите параметры базы — они сохранятся на этом компьютере, и при следующем ' +
      'запуске приложение подключится само.</p>' +
      '<div id="rt-connect-error" class="error-box"' +
      (message ? '' : ' hidden') + '>' + esc(message || '') + '</div>' +
      '<form id="rt-connect-form" autocomplete="off">' +
      connectionFieldsHtml(state.config, true) +
      '<button type="submit" id="rt-connect-button" class="btn btn-primary btn-block">' +
      'Подключиться</button>' +
      '</form></div></div>';
  }

  async function submitConnection(form, options) {
    var opts = options || {};
    var errorSelector = opts.errorSelector || '#rt-connect-error';
    var button = opts.button || form.querySelector('button[type="submit"]');
    hideError(errorSelector);
    var payload = readConnectionForm(form);
    if (!payload.host || !payload.dbname || !payload.user) {
      showError(errorSelector, 'Заполните сервер, базу данных и пользователя.');
      return;
    }
    if (!(payload.port >= 1 && payload.port <= 65535)) {
      showError(errorSelector, 'Порт должен быть в диапазоне 1–65535.');
      return;
    }
    if (button) {
      button.disabled = true;
      button.textContent = 'Подключение…';
    }
    try {
      await api('/api/connect', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await loadBootstrap();
      var dialog = $('#rt-connect-dialog');
      if (dialog && dialog.open) dialog.close();
      route();
      toast('Подключено: ' + (state.database || payload.dbname), 'success');
    } catch (error) {
      showError(errorSelector, error.message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Подключиться';
      }
    }
  }

  function openConnectDialog() {
    var dialog = $('#rt-connect-dialog');
    if (!dialog) return;
    var body = $('#rt-connect-dialog-body');
    if (body) body.innerHTML = connectionFieldsHtml(state.config, true);
    hideError('#rt-connect-dialog-error');
    var save = $('#rt-connect-dialog-save');
    if (save) {
      save.disabled = false;
      save.textContent = 'Подключиться';
    }
    if (dialog.open) dialog.close();
    dialog.showModal();
  }

  /* =======================================================================
     Вход в приложение
     ======================================================================= */

  function renderLogin(mode) {
    state.view = 'login';
    var auth = (state.project && state.project.auth) || {};
    var registration = mode === 'register' && auth.allow_registration !== false;
    state.authMode = registration ? 'register' : 'login';
    var app = $('#rt-app');
    var title = auth.title || 'Вход в приложение';
    var welcome = auth.welcome || 'Войдите, чтобы открыть интерфейс приложения.';

    if (!registration) {
      app.innerHTML = '<div class="rt-page"><div class="login-card rt-auth-card">' +
        '<div class="brand brand-lg">DB2UI <span>Studio</span></div>' +
        '<h2>' + esc(title) + '</h2>' +
        '<p class="muted">' + esc(welcome) + '</p>' +
        '<form id="rt-login-form" autocomplete="on">' +
        '<label class="field"><span>Логин</span>' +
        '<input name="login" required autocomplete="username" autofocus></label>' +
        '<label class="field"><span>Пароль</span>' +
        '<input name="password" type="password" required autocomplete="current-password"></label>' +
        '<div id="rt-login-error" class="error-box" hidden></div>' +
        '<button type="submit" id="rt-login-button" class="btn btn-primary btn-block">Войти</button>' +
        '</form>' +
        (auth.allow_registration !== false && state.auth.configured
          ? '<div class="rt-auth-switch"><button type="button" class="rt-link" ' +
            'data-rt-auth-switch="register">Создать аккаунт</button></div>'
          : '') +
        '<div class="rt-login-note">Пользователи хранятся в таблице ' +
        esc((auth.schema || 'public') + '.' + (auth.table || '—')) + '.</div>' +
        '</div></div>';
      var login = $('#rt-login-form [name="login"]');
      if (login) login.focus();
      return;
    }

    app.innerHTML = '<div class="rt-page"><div class="login-card rt-auth-card">' +
      '<div class="brand brand-lg">DB2UI <span>Studio</span></div>' +
      '<h2>Регистрация</h2>' +
      '<p class="muted">Создайте учётную запись приложения.</p>' +
      '<form id="rt-register-form" autocomplete="off">' +
      '<label class="field"><span>Логин</span>' +
      '<input name="login" required minlength="3" maxlength="64" autofocus></label>' +
      '<label class="field"><span>Пароль</span>' +
      '<input name="password" type="password" required minlength="4" maxlength="128"></label>' +
      '<label class="field"><span>Повторите пароль</span>' +
      '<input name="password2" type="password" required minlength="4" maxlength="128"></label>' +
      '<div id="rt-register-error" class="error-box" hidden></div>' +
      '<button type="submit" id="rt-register-button" class="btn btn-primary btn-block">' +
      'Зарегистрироваться</button>' +
      '</form>' +
      '<div class="rt-auth-switch"><button type="button" class="rt-link" ' +
      'data-rt-auth-switch="login">← Уже есть аккаунт</button></div>' +
      '</div></div>';
    var reg = $('#rt-register-form [name="login"]');
    if (reg) reg.focus();
  }

  async function submitLogin(form) {
    hideError('#rt-login-error');
    var login = String(form.elements.login.value || '').trim();
    var password = String(form.elements.password.value || '');
    if (!login || !password) {
      showError('#rt-login-error', 'Введите логин и пароль.');
      return;
    }
    var button = $('#rt-login-button');
    if (button) {
      button.disabled = true;
      button.textContent = 'Проверка…';
    }
    try {
      var data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login: login, password: password }),
      });
      state.user = data.user;
      state.auth.authenticated = true;
      state.auth.user = data.user;
      state.formId = state.project.start_form;
      route();
      toast('Добро пожаловать, ' + (data.user && data.user.login ? data.user.login : login),
        'success');
    } catch (error) {
      showError('#rt-login-error', error.message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Войти';
      }
    }
  }

  async function submitRegister(form) {
    hideError('#rt-register-error');
    var login = String(form.elements.login.value || '').trim();
    var password = String(form.elements.password.value || '');
    var password2 = String(form.elements.password2.value || '');
    if (login.length < 3) {
      showError('#rt-register-error', 'Логин должен содержать не менее 3 символов.');
      return;
    }
    if (password.length < 4) {
      showError('#rt-register-error', 'Пароль должен содержать не менее 4 символов.');
      return;
    }
    if (password !== password2) {
      showError('#rt-register-error', 'Пароли не совпадают.');
      return;
    }
    var button = $('#rt-register-button');
    if (button) {
      button.disabled = true;
      button.textContent = 'Создание…';
    }
    try {
      var data = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ login: login, password: password, password2: password2 }),
      });
      state.user = data.user;
      state.auth.authenticated = true;
      state.auth.user = data.user;
      state.formId = state.project.start_form;
      route();
      toast('Аккаунт создан. Добро пожаловать, ' + data.user.login, 'success');
    } catch (error) {
      showError('#rt-register-error', error.message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Зарегистрироваться';
      }
    }
  }

  async function doLogout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      // локально выходим в любом случае
    }
    state.user = null;
    state.auth.authenticated = false;
    state.auth.user = null;
    if (state.auth.enabled) renderLogin('login');
    else if (state.connected) renderApp(state.formId);
    toast('Вы вышли из приложения');
  }

  /* =======================================================================
     Загрузка данных таблиц
     ======================================================================= */

  function invalidateTable(table) {
    var prefix = refOf(table) + '|';
    Array.from(ROW_CACHE.keys()).forEach(function (key) {
      if (key.indexOf(prefix) === 0) ROW_CACHE.delete(key);
    });
  }

  function fetchRows(table, limit, force) {
    var key = refOf(table) + '|' + limit;
    var cached = ROW_CACHE.get(key);
    var now = Date.now();
    if (!force && cached && now - cached.time < CACHE_TTL) return cached.promise;
    var promise = api('/api/table?schema=' + encodeURIComponent(table.schema) +
      '&table=' + encodeURIComponent(table.name) +
      '&limit=' + encodeURIComponent(limit)).catch(function (error) {
      ROW_CACHE.delete(key);
      throw error;
    });
    ROW_CACHE.set(key, { time: now, promise: promise });
    return promise;
  }

  function formatCell(value) {
    if (value === null || value === undefined) {
      return '<span class="raw-json">NULL</span>';
    }
    if (typeof value === 'boolean') return value ? 'да' : 'нет';
    if (typeof value === 'object') return esc(JSON.stringify(value));
    return esc(String(value));
  }

  function renderTableInto(body, element, table, data) {
    var rows = data.rows || [];
    var columns = (data.table && data.table.columns) || table.columns || [];
    var canEdit = element.editable !== false;
    var showActions = canEdit && table.primary_key && table.primary_key.length > 0 &&
      (element.allowEdit !== false || element.allowDelete !== false);

    var head = body.closest('.el-table');
    var subtitle = head && head.querySelector('.el-table-title small');
    if (subtitle) {
      subtitle.textContent = table.label + ' · ' + rows.length + ' строк' +
        (data.truncated ? ' · есть ещё' : '');
    }

    if (!rows.length) {
      body.innerHTML = '<div class="table-empty">В таблице пока нет записей.</div>';
      body._rows = [];
      body._table = data.table || table;
      return;
    }

    var html = '<table class="data-table"><thead><tr>';
    columns.forEach(function (column) {
      html += '<th>' + esc(column.name) + (column.is_pk ? ' 🔑' : '') + '</th>';
    });
    if (showActions) html += '<th></th>';
    html += '</tr></thead><tbody>';

    rows.forEach(function (row, index) {
      html += '<tr>';
      columns.forEach(function (column) {
        html += '<td>' + formatCell(row[column.name]) + '</td>';
      });
      if (showActions) {
        html += '<td><div class="row-actions">';
        if (element.allowEdit !== false) {
          html += '<button type="button" class="row-btn" data-rt-act="edit" ' +
            'data-row-index="' + index + '" title="Изменить">✎</button>';
        }
        if (element.allowDelete !== false) {
          html += '<button type="button" class="row-btn danger" data-rt-act="delete" ' +
            'data-row-index="' + index + '" title="Удалить">🗑</button>';
        }
        html += '</div></td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    body.innerHTML = html;
    body._rows = rows;
    body._table = data.table || table;
  }

  function loadTable(element, body, force) {
    if (!body) return;
    var table = tableByRef(element.table);
    if (!table) {
      body.innerHTML = '<div class="table-empty">Таблица не выбрана в свойствах элемента.</div>';
      return;
    }
    var token = String(Math.random());
    body.dataset.token = token;
    body.innerHTML = '<div class="table-loading">Загрузка данных…</div>';
    fetchRows(table, Math.max(1, num(element.limit, 50)), force)
      .then(function (data) {
        if (!body.isConnected || body.dataset.token !== token) return;
        renderTableInto(body, element, table, data);
      })
      .catch(function (error) {
        if (!body.isConnected || body.dataset.token !== token) return;
        body.innerHTML = '<div class="table-error">' + esc(error.message) + '</div>';
      });
  }

  function hydrateTables(root, force) {
    $$('[data-rt-table-body]', root || document).forEach(function (body) {
      var id = body.getAttribute('data-rt-table-body');
      var element = findElementAnywhere(id);
      if (element && element.type === 'table') loadTable(element, body, force);
    });
  }

  /* =======================================================================
     Выпадающие списки
     ======================================================================= */

  function preferredLabelColumn(table) {
    if (!table) return '';
    var textTypes = new Set(['text', 'varchar', 'bpchar', 'char', 'citext']);
    var preferred = (table.columns || []).find(function (column) {
      return !column.is_pk && textTypes.has(column.udt_name);
    });
    var fallback = (table.columns || []).find(function (column) {
      return !column.is_pk;
    });
    return (preferred || fallback || (table.columns || [])[0] || {}).name || '';
  }

  function loadSelect(element, node, force) {
    var table = tableByRef(element.table);
    var placeholder = element.placeholder || '— выберите —';
    if (!table || !element.column) {
      node.innerHTML = '<option value="">' + esc(placeholder) + '</option>';
      return;
    }
    var previous = node.value;
    var token = String(Math.random());
    node.dataset.token = token;
    node.innerHTML = '<option value="">Загрузка…</option>';

    var current = table.columns.find(function (column) {
      return column.name === element.column;
    });
    var options = [];
    var seen = new Set();

    var finish = function () {
      if (!node.isConnected || node.dataset.token !== token) return;
      var html = '<option value="">' + esc(placeholder) + '</option>';
      options.forEach(function (option) {
        html += '<option value="' + attr(option.value) + '">' +
          esc(option.label) + '</option>';
      });
      node.innerHTML = html;
      if (previous && options.some(function (option) {
        return String(option.value) === String(previous);
      })) {
        node.value = previous;
      }
    };

    if (current && current.references) {
      var ref = current.references;
      var refTable = tableByRef((ref.ref_schema || 'public') + '|' + ref.ref_table);
      if (refTable) {
        var labelColumn = element.labelColumn;
        var names = (refTable.columns || []).map(function (column) { return column.name; });
        if (!labelColumn || names.indexOf(labelColumn) < 0) {
          labelColumn = preferredLabelColumn(refTable);
        }
        fetchRows(refTable, 500, force).then(function (data) {
          (data.rows || []).forEach(function (row) {
            var value = row[ref.ref_column];
            if (value == null) return;
            var key = String(value);
            if (seen.has(key)) return;
            seen.add(key);
            options.push({
              value: value,
              label: labelColumn ? row[labelColumn] : value,
            });
          });
          finish();
        }).catch(function (error) {
          if (!node.isConnected || node.dataset.token !== token) return;
          node.innerHTML = '<option value="">' + esc(error.message) + '</option>';
        });
        return;
      }
    }

    fetchRows(table, 500, force).then(function (data) {
      (data.rows || []).forEach(function (row) {
        var value = row[element.column];
        if (value == null) return;
        var key = String(value);
        if (seen.has(key)) return;
        seen.add(key);
        options.push({ value: value, label: value });
      });
      finish();
    }).catch(function (error) {
      if (!node.isConnected || node.dataset.token !== token) return;
      node.innerHTML = '<option value="">' + esc(error.message) + '</option>';
    });
  }

  function hydrateSelects(root, force) {
    $$('[data-rt-select]', root || document).forEach(function (node) {
      var element = findElementAnywhere(node.getAttribute('data-rt-select'));
      if (element && element.type === 'select') loadSelect(element, node, force);
    });
  }

  /* =======================================================================
     SQL-элементы
     ======================================================================= */

  function sqlTableHtml(result) {
    if (!result) return '<div class="table-empty">Нет результата.</div>';
    var columns = result.columns || [];
    var rows = result.rows || [];
    if (!columns.length || !rows.length) {
      return '<div class="table-empty">Запрос не вернул строк.</div>';
    }
    var head = '<tr>' + columns.map(function (column) {
      return '<th>' + esc(column) + '</th>';
    }).join('') + '</tr>';
    var body = rows.map(function (row) {
      return '<tr>' + columns.map(function (column) {
        return '<td>' + formatCell(row[column]) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<table class="data-table"><thead>' + head + '</thead><tbody>' +
      body + '</tbody></table>';
  }

  function loadSql(element, body) {
    if (!body) return;
    var token = String(Math.random());
    body.dataset.token = token;
    body.innerHTML = '<div class="table-loading">Выполнение запроса…</div>';
    api('/api/sql/query', {
      method: 'POST',
      body: JSON.stringify({
        sql: element.query || '',
        limit: clamp(Math.round(num(element.limit, 100)), 1, 500),
      }),
    }).then(function (result) {
      if (!body.isConnected || body.dataset.token !== token) return;
      body.innerHTML = sqlTableHtml(result);
    }).catch(function (error) {
      if (!body.isConnected || body.dataset.token !== token) return;
      body.innerHTML = '<div class="table-error">' + esc(error.message) + '</div>';
    });
  }

  function hydrateSql(root, force) {
    $$('[data-rt-sql-body]', root || document).forEach(function (body) {
      var element = findElementAnywhere(body.getAttribute('data-rt-sql-body'));
      if (element && element.type === 'sql') loadSql(element, body);
    });
  }

  function hydrateCurrent(form, force) {
    var surface = $('#rt-surface');
    if (!surface || !form) return;
    hydrateTables(surface, force);
    hydrateSelects(surface, force);
    hydrateSql(surface, force);
  }

  /* =======================================================================
     Действия кнопок формы
     ======================================================================= */

  function fieldNode(element) {
    return nodeByData(document, 'data-rt-input', element.id) ||
      nodeByData(document, 'data-rt-select', element.id);
  }

  function authFieldsFor(form) {
    var inputs = ((form && form.elements) || []).filter(function (element) {
      return element.type === 'input' || element.type === 'select';
    });
    var find = function (pattern) {
      return inputs.find(function (element) {
        return pattern.test(
          [element.name, element.label, element.column, element.placeholder].join(' ')
        );
      });
    };
    return {
      login: find(/login|логин|user|пользов/i) || inputs[0] || null,
      password: find(/pass|парол|pwd/i) || inputs[1] || null,
    };
  }

  function roleRouteFormId(element, role) {
    var needle = String(role || '').trim().toLowerCase();
    var routes = Array.isArray(element.roleRoutes) ? element.roleRoutes : [];
    if (needle) {
      for (var i = 0; i < routes.length; i += 1) {
        var route = routes[i] || {};
        if (String(route.role || '').trim().toLowerCase() === needle &&
            findForm(route.formId)) {
          return route.formId;
        }
      }
    }
    return '';
  }

  async function authFromForm(action, element) {
    var form = currentForm();
    if (!form) return;
    var fields = authFieldsFor(form);
    var loginNode = fields.login ? fieldNode(fields.login) : null;
    var passwordNode = fields.password ? fieldNode(fields.password) : null;
    var login = loginNode ? String(loginNode.value || '').trim() : '';
    var password = passwordNode ? String(passwordNode.value || '') : '';
    if (!login || !password) {
      toast('Заполните поля логина и пароля.', 'error');
      return;
    }
    if (action === 'register' && password.length < 4) {
      toast('Пароль должен содержать не менее 4 символов.', 'error');
      return;
    }
    try {
      var data = await api(
        action === 'register' ? '/api/auth/register' : '/api/auth/login',
        { method: 'POST', body: JSON.stringify({ login: login, password: password }) }
      );
      state.user = data.user;
      state.auth.authenticated = true;
      state.auth.user = data.user;
      if (loginNode) loginNode.value = '';
      if (passwordNode) passwordNode.value = '';
      var target = roleRouteFormId(element, data.user && data.user.role) ||
        (element.postLoginForm && findForm(element.postLoginForm)
          ? element.postLoginForm
          : '') ||
        (state.project && state.project.start_form) ||
        state.formId;
      renderApp(target);
      toast((action === 'register' ? 'Аккаунт создан: ' : 'Вы вошли как ') +
        (data.user && data.user.login ? data.user.login : login), 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function insertFromInputs(element) {
    var form = currentForm();
    if (!form) return;
    var tableValue = element.table || '';
    if (!tableValue) {
      var firstBound = (form.elements || []).find(function (item) {
        return item.type === 'input' && item.table;
      });
      tableValue = firstBound ? firstBound.table : '';
    }
    var table = tableByRef(tableValue);
    if (!table) {
      toast('Сначала выберите таблицу для кнопки и привяжите поля к её колонкам.', 'error');
      return;
    }

    var values = {};
    var missing = '';
    var filled = 0;
    (form.elements || [])
      .filter(function (item) {
        return (item.type === 'input' || item.type === 'select') &&
          item.column && tableRefOf(item.table) === tableValue;
      })
      .forEach(function (item) {
        var node = fieldNode(item);
        var raw = node ? String(node.value || '').trim() : '';
        if (!raw) {
          if (item.required && !missing) missing = item.label || item.column;
          return;
        }
        filled += 1;
        values[item.column] = raw;
      });

    if (missing) {
      toast('Заполните обязательное поле «' + missing + '»', 'error');
      return;
    }
    if (!filled) {
      toast('Заполните хотя бы одно поле формы.', 'error');
      return;
    }
    try {
      await api('/api/table/rows', {
        method: 'POST',
        body: JSON.stringify({ schema: table.schema, table: table.name, values: values }),
      });
      toast('Запись добавлена в «' + table.label + '»', 'success');
      invalidateTable(table);
      (form.elements || [])
        .filter(function (item) {
          return (item.type === 'input' || item.type === 'select') &&
            tableRefOf(item.table) === tableValue;
        })
        .forEach(function (item) {
          var node = fieldNode(item);
          if (node) node.value = '';
        });
      hydrateCurrent(form, true);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function runButtonAction(element) {
    var action = element.action || 'navigate';
    if (action === 'navigate') {
      if (element.targetForm && findForm(element.targetForm)) {
        renderApp(element.targetForm);
      } else {
        toast('Для кнопки не выбрана форма перехода.', 'error');
      }
      return;
    }
    if (action === 'home') {
      renderApp(state.project.start_form);
      return;
    }
    if (action === 'refresh') {
      hydrateCurrent(currentForm(), true);
      toast('Данные обновлены');
      return;
    }
    if (action === 'logout') {
      doLogout();
      return;
    }
    if (action === 'login' || action === 'register') {
      authFromForm(action, element);
      return;
    }
    if (action === 'insert') {
      insertFromInputs(element);
    }
  }

  /* =======================================================================
     CRUD-диалог
     ======================================================================= */

  function columnHasDefault(column) {
    return column.default != null && String(column.default).trim() !== '';
  }

  function dialogControl(column, value, disabled, required) {
    var attrs = 'data-column="' + attr(column.name) + '"' +
      (disabled ? ' disabled' : '') +
      (required ? ' required' : '');
    var raw = value == null ? '' : String(value);

    if (column.udt_name === 'bool') {
      var isTrue = value === true || value === 'true' || value === 't';
      var isFalse = value === false || value === 'false' || value === 'f';
      var options = '';
      if (column.nullable) {
        options += '<option value=""' + (!isTrue && !isFalse ? ' selected' : '') +
          '>— не задано —</option>';
      }
      options += '<option value="true"' + (isTrue ? ' selected' : '') + '>да</option>';
      options += '<option value="false"' + (isFalse ? ' selected' : '') + '>нет</option>';
      return '<select ' + attrs + '>' + options + '</select>';
    }

    if (TEXTAREA_TYPES.has(column.udt_name)) {
      return '<textarea ' + attrs + '>' + esc(raw) + '</textarea>';
    }

    if (NUMERIC_TYPES.has(column.udt_name)) {
      var step = ['int2', 'int4', 'int8', 'oid'].indexOf(column.udt_name) >= 0 ? '1' : 'any';
      return '<input ' + attrs + ' type="number" step="' + step + '" value="' +
        attr(raw) + '">';
    }
    if (column.udt_name === 'date') {
      return '<input ' + attrs + ' type="date" value="' + attr(raw.slice(0, 10)) + '">';
    }
    if (column.udt_name === 'time' || column.udt_name === 'timetz') {
      return '<input ' + attrs + ' type="time" value="' + attr(raw.slice(0, 8)) + '">';
    }
    if (column.udt_name === 'timestamp' || column.udt_name === 'timestamptz') {
      return '<input ' + attrs + ' type="datetime-local" value="' +
        attr(raw.slice(0, 16)) + '">';
    }
    return '<input ' + attrs + ' type="text" value="' + attr(raw) + '">';
  }

  function openRecord(mode, element, row) {
    var table = tableByRef(element.table);
    if (!table) {
      toast('Сначала выберите таблицу для этого элемента.', 'error');
      return;
    }
    var dialog = $('#rt-record-dialog');
    var title = $('#rt-record-title');
    var fields = $('#rt-record-fields');
    var save = $('#rt-record-save');
    if (!dialog || !title || !fields || !save) return;

    hideError('#rt-record-error');
    save.disabled = false;
    save.textContent = 'Сохранить';
    title.textContent = (mode === 'edit' ? 'Изменить запись' : 'Новая запись') +
      ' — ' + table.label;

    var parts = [];
    (table.columns || []).forEach(function (column) {
      var include = false;
      var disabled = false;
      if (mode === 'edit') {
        if (column.is_pk) {
          include = true;
          disabled = true;
        } else if (column.form_editable) {
          include = true;
        }
      } else if (column.form_editable) {
        include = true;
      }
      if (!include) return;

      var value = row ? row[column.name] : null;
      var isLong = TEXTAREA_TYPES.has(column.udt_name);
      var full = isLong || column.name.length > 16;
      var required = mode === 'create'
        ? (!column.nullable && !columnHasDefault(column))
        : !column.nullable;
      var note = [
        column.is_pk ? ' 🔑' : '',
        required && !disabled ? ' <em>*</em>' : '',
        mode === 'create' && columnHasDefault(column) ? ' · по умолчанию' : '',
        disabled ? ' · ключ' : '',
      ].join('');
      parts.push('<label class="field' + (full ? ' full' : '') + '">' +
        '<span>' + esc(column.name) + note + '</span>' +
        dialogControl(column, value, disabled, required) + '</label>');
    });

    if (!parts.length) {
      toast('В этой таблице нет полей, доступных для заполнения.', 'error');
      return;
    }

    fields.innerHTML = parts.join('');
    state.dialog = { mode: mode, elementId: element.id, table: table, row: row || null };
    if (dialog.open) dialog.close();
    dialog.showModal();
  }

  async function submitRecord(event) {
    event.preventDefault();
    var dialogState = state.dialog;
    if (!dialogState) return;

    var values = {};
    var firstError = '';
    $$('#rt-record-fields [data-column]').forEach(function (control) {
      if (control.disabled) return;
      var column = dialogState.table.columns.find(function (item) {
        return item.name === control.getAttribute('data-column');
      });
      if (!column) return;

      if (column.udt_name === 'bool') {
        if (control.value === '') {
          if (!column.nullable) {
            if (!firstError) firstError = 'Заполните поле «' + column.name + '».';
          } else if (dialogState.mode === 'edit') {
            values[column.name] = null;
          }
          return;
        }
        values[column.name] = control.value === 'true';
        return;
      }

      var raw = String(control.value || '').trim();
      if (!raw) {
        if (dialogState.mode === 'create' &&
            (column.nullable || columnHasDefault(column))) {
          return;
        }
        if (!column.nullable) {
          if (!firstError) firstError = 'Заполните поле «' + column.name + '».';
        } else if (dialogState.mode === 'edit') {
          values[column.name] = null;
        }
        return;
      }
      values[column.name] = raw;
    });

    if (firstError) {
      showError('#rt-record-error', firstError);
      return;
    }
    if (!Object.keys(values).length) {
      showError('#rt-record-error', 'Заполните хотя бы одно поле записи.');
      return;
    }

    var payload = {
      schema: dialogState.table.schema,
      table: dialogState.table.name,
      values: values,
    };
    if (dialogState.mode === 'edit' && dialogState.row) {
      payload.pk = {};
      dialogState.table.primary_key.forEach(function (column) {
        payload.pk[column] = dialogState.row[column];
      });
    }

    var save = $('#rt-record-save');
    hideError('#rt-record-error');
    if (save) {
      save.disabled = true;
      save.textContent = 'Сохранение…';
    }
    try {
      await api('/api/table/rows', {
        method: dialogState.mode === 'edit' ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      var dialog = $('#rt-record-dialog');
      if (dialog) dialog.close();
      toast(dialogState.mode === 'edit' ? 'Запись изменена' : 'Запись добавлена',
        'success');
      invalidateTable(dialogState.table);
      refreshTableViews(dialogState.table);
      hydrateSelects($('#rt-surface'), true);
    } catch (error) {
      showError('#rt-record-error', error.message);
    } finally {
      if (save) {
        save.disabled = false;
        save.textContent = 'Сохранить';
      }
    }
  }

  async function deleteRecord(element, row) {
    var table = tableByRef(element.table);
    if (!table || !table.primary_key || !table.primary_key.length) {
      toast('Удаление недоступно: у таблицы нет первичного ключа.', 'error');
      return;
    }
    if (!confirm('Удалить запись из таблицы «' + table.label + '»?')) return;
    var pk = {};
    table.primary_key.forEach(function (column) {
      pk[column] = row[column];
    });
    try {
      await api('/api/table/rows', {
        method: 'DELETE',
        body: JSON.stringify({ schema: table.schema, table: table.name, pk: pk }),
      });
      toast('Запись удалена', 'success');
      invalidateTable(table);
      refreshTableViews(table);
      hydrateSelects($('#rt-surface'), true);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function refreshTableViews(table) {
    $$('[data-rt-table-body]').forEach(function (body) {
      var element = findElementAnywhere(body.getAttribute('data-rt-table-body'));
      if (!element || element.type !== 'table') return;
      if (table && tableRefOf(element.table) !== refOf(table)) return;
      loadTable(element, body, true);
    });
  }

  /* =======================================================================
     Обработчики
     ======================================================================= */

  async function loadBootstrap() {
    var data = await api('/api/bootstrap');
    state.connected = !!data.connected;
    state.database = data.database || '';
    state.config = data.config || {};
    state.auth = data.auth || {
      enabled: false, configured: false, authenticated: false, user: null,
    };
    state.user = state.auth.user || null;
    state.lastError = data.last_error || '';
    if (data.project) {
      state.project = data.project;
      prepareProject();
    }
    state.tables = Array.isArray(data.tables) ? data.tables : [];
    if (state.formId && !findForm(state.formId)) state.formId = null;
  }

  function route() {
    if (!state.project || !state.project.forms || !state.project.forms.length) {
      renderFatal('В проекте нет форм.');
      return;
    }
    if (!state.connected) {
      renderConnection(state.lastError);
      return;
    }
    if (state.auth.enabled && !state.auth.authenticated) {
      renderLogin('login');
      return;
    }
    renderApp(state.formId || state.project.start_form);
  }

  function renderFatal(message) {
    state.view = 'fatal';
    $('#rt-app').innerHTML = '<div class="rt-page"><div class="rt-connect-card">' +
      '<div class="brand brand-lg">DB2UI <span>App</span></div>' +
      '<h1>Не удалось открыть приложение</h1>' +
      '<div class="error-box">' + esc(message || 'Неизвестная ошибка') + '</div>' +
      '<p class="muted">Проверьте, что ZIP-пакет распакован целиком и файл ' +
      '<b>data/project.json</b> находится на месте.</p>' +
      '<button type="button" class="btn btn-primary btn-block" ' +
      'data-rt-action="reload">Перезагрузить</button>' +
      '</div></div>';
  }

  function handleUiAction(action) {
    if (action === 'reload') {
      window.location.reload();
      return;
    }
    if (action === 'home') {
      renderApp(state.project && state.project.start_form);
      return;
    }
    if (action === 'refresh') {
      hydrateCurrent(currentForm(), true);
      hydrateSelects($('#rt-surface'), true);
      toast('Данные обновлены');
      return;
    }
    if (action === 'logout') {
      doLogout();
      return;
    }
    if (action === 'settings') {
      openConnectDialog();
    }
  }

  function handleTableAction(node) {
    var action = node.getAttribute('data-rt-act');
    var tableBody = node.closest('.el-table') &&
      node.closest('.el-table').querySelector('[data-rt-table-body]');
    var sqlBody = node.closest('.el-table') &&
      node.closest('.el-table').querySelector('[data-rt-sql-body]');
    var element = null;
    if (tableBody) {
      element = findElementAnywhere(tableBody.getAttribute('data-rt-table-body'));
    } else if (sqlBody) {
      element = findElementAnywhere(sqlBody.getAttribute('data-rt-sql-body'));
    }
    if (!element) return;

    if (action === 'sql-run') {
      loadSql(element, sqlBody);
      return;
    }
    if (action === 'reload') {
      loadTable(element, tableBody, true);
      return;
    }
    if (action === 'add') {
      openRecord('create', element, null);
      return;
    }
    if (action === 'edit' || action === 'delete') {
      var index = Number(node.getAttribute('data-row-index'));
      var row = tableBody && tableBody._rows ? tableBody._rows[index] : null;
      if (!row) return;
      if (action === 'edit') openRecord('edit', element, row);
      else deleteRecord(element, row);
    }
  }

  function bindGlobalEvents() {
    document.addEventListener('submit', function (event) {
      var form = event.target;
      if (!form || !form.id) return;
      if (form.id === 'rt-connect-form') {
        event.preventDefault();
        submitConnection(form, {
          errorSelector: '#rt-connect-error',
          button: $('#rt-connect-button'),
        });
      } else if (form.id === 'rt-connect-dialog-form') {
        event.preventDefault();
        submitConnection(form, {
          errorSelector: '#rt-connect-dialog-error',
          button: $('#rt-connect-dialog-save'),
        });
      } else if (form.id === 'rt-login-form') {
        event.preventDefault();
        submitLogin(form);
      } else if (form.id === 'rt-register-form') {
        event.preventDefault();
        submitRegister(form);
      } else if (form.id === 'rt-record-form') {
        submitRecord(event);
      }
    });

    document.addEventListener('click', function (event) {
      var close = event.target.closest('[data-rt-close-dialog]');
      if (close) {
        var dialog = close.closest('dialog');
        if (dialog) dialog.close();
        return;
      }

      var ui = event.target.closest('[data-rt-action]');
      if (ui) {
        handleUiAction(ui.getAttribute('data-rt-action'));
        return;
      }

      var authSwitch = event.target.closest('[data-rt-auth-switch]');
      if (authSwitch) {
        var mode = authSwitch.getAttribute('data-rt-auth-switch');
        renderLogin(mode);
        return;
      }

      var button = event.target.closest('[data-rt-button]');
      if (button) {
        var id = button.getAttribute('data-rt-button');
        var element = findElementAnywhere(id);
        if (element) runButtonAction(element);
        return;
      }

      var tableAction = event.target.closest('[data-rt-act]');
      if (tableAction) handleTableAction(tableAction);
    });

    window.addEventListener('resize', function () {
      if (state.view === 'app') fitSurface();
    });

    var recordDialog = $('#rt-record-dialog');
    if (recordDialog) {
      recordDialog.addEventListener('close', function () {
        state.dialog = null;
        hideError('#rt-record-error');
        var fields = $('#rt-record-fields');
        if (fields) fields.innerHTML = '';
      });
    }

    var connectDialog = $('#rt-connect-dialog');
    if (connectDialog) {
      connectDialog.addEventListener('click', function (event) {
        if (event.target === connectDialog) connectDialog.close();
      });
    }
  }

  async function boot() {
    bindGlobalEvents();
    try {
      await loadBootstrap();
    } catch (error) {
      renderFatal(error.message);
      return;
    }
    route();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

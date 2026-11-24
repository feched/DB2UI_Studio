'use strict';

/* =========================================================================
   DB2UI Studio — логика конструктора интерфейсов.
   Работает поверх REST API из app.py.
   ========================================================================= */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const SAVE_DELAY = 550;
const CACHE_TTL = 4000;
const SNAP_THRESHOLD = 6;

const TYPE_LABELS = {
  form: 'Форма',
  text: 'Текст',
  button: 'Кнопка',
  input: 'Поле ввода',
  select: 'Выпадающий список',
  image: 'Изображение',
  table: 'Таблица',
  panel: 'Панель',
  sql: 'SQL-запрос',
};

const TYPE_ICONS = {
  form: '▣',
  text: 'T',
  button: '▭',
  input: '⌨',
  select: '▾',
  image: '🖼',
  table: '▦',
  panel: '▥',
  sql: '⌘',
};

const ELEMENT_TYPES = Object.keys(TYPE_LABELS);

const ACTIONS = {
  navigate: 'Перейти на форму',
  home: 'На главную форму',
  login: 'Войти (логин и пароль)',
  register: 'Зарегистрировать пользователя',
  insert: 'Добавить запись из полей',
  refresh: 'Обновить данные таблиц',
  logout: 'Выйти из учётной записи',
};

const INPUT_TYPES = {
  text: 'Текст',
  number: 'Число',
  date: 'Дата',
  time: 'Время',
  email: 'E-mail',
  password: 'Пароль',
};

const COLUMN_TYPES = [
  ['serial', 'serial — автоинкремент'],
  ['bigserial', 'bigserial — большой автоинкремент'],
  ['integer', 'integer — целое'],
  ['bigint', 'bigint — большое целое'],
  ['smallint', 'smallint — маленькое целое'],
  ['numeric', 'numeric — число'],
  ['numeric(10,2)', 'numeric(10,2) — деньги'],
  ['float8', 'float8 — дробное'],
  ['boolean', 'boolean — да / нет'],
  ['text', 'text — текст'],
  ['varchar(120)', 'varchar(120) — строка'],
  ['varchar(255)', 'varchar(255) — строка'],
  ['char(20)', 'char(20) — фиксированная строка'],
  ['date', 'date — дата'],
  ['time', 'time — время'],
  ['timestamp', 'timestamp — дата и время'],
  ['timestamptz', 'timestamptz — дата и время с зоной'],
  ['uuid', 'uuid'],
  ['json', 'json'],
  ['jsonb', 'jsonb'],
];

const DEFAULT_OPTIONS = [
  ['', '— нет —'],
  ['now()', 'now()'],
  ['current_date', 'current_date'],
  ['current_time', 'current_time'],
  ['current_timestamp', 'current_timestamp'],
  ['true', 'true'],
  ['false', 'false'],
  ['0', '0'],
  ['1', '1'],
  ['__empty__', "Пустая строка ('')"],
];

const GRID_DEFAULT = 8;
const SETTINGS_DEFAULT = { grid: GRID_DEFAULT, snap: true, show_grid: true };
const AUTH_DEFAULT = {
  enabled: false,
  allow_registration: true,
  title: 'Вход в приложение',
  schema: 'public',
  table: '',
  login_column: '',
  password_column: '',
  password_mode: 'plain',
  role_column: '',
  welcome: '',
};

const LAYOUT_DEFAULT = { mode: 'free', cols: 4, rows: 6, gap: 12 };
const PANEL_HEADER = 30;
const FORM_MIN_WIDTH = 320;
const FORM_MIN_HEIGHT = 240;
const FORM_MAX_SIZE = 4000;
const PANEL_DEFAULT = {
  padding: 12,
  title: 'Панель',
  background: '#f8fafc',
  border: true,
};
const SQL_DEFAULT = {
  query: 'SELECT 1 AS example',
  limit: 100,
};
const ROUTINE_TEMPLATES = {
  function: `CREATE OR REPLACE FUNCTION public.my_function(value integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN value * 2;
END;
$$;`,
  procedure: `CREATE OR REPLACE PROCEDURE public.my_procedure(value integer)
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE NOTICE 'Значение: %', value;
END;
$$;`,
  trigger: `CREATE TRIGGER my_trigger
AFTER INSERT ON public.my_table
FOR EACH ROW
EXECUTE FUNCTION public.my_trigger_function();`,
  trigger_function: `CREATE OR REPLACE FUNCTION public.my_trigger_function()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN NEW;
END;
$$;`,
};

const state = {
  connected: false,
  db: null,
  tables: [],
  project: null,
  currentFormId: null,
  selected: null,
  multi: [],
  expanded: new Set(),
  openForms: [],
  preview: { formId: null },
  auth: { enabled: false, configured: false, authenticated: false, user: null },
  authUsers: [],
  authRolesRequested: false,
  routines: {
    functions: [],
    procedures: [],
    triggers: [],
    loaded: false,
    loading: false,
    selected: null,
  },
  dialog: null,
  saveTimer: null,
  saveSeq: 0,
  dirty: false,
  toastTimer: null,
  mainTab: 'builder',
  newProjectOnConnect: false,
  dbColumnContext: null,
  dbRelationContext: null,
  dbLink: null,
  dbLayoutReady: false,
  clipboard: null,
  pasteCount: 0,
  marquee: null,
  gapAxis: 'h',
  history: {
    undo: [],
    redo: [],
    base: null,
    lastPush: 0,
    lock: false,
  },
};

const rowCache = new Map();
const sqlCache = new Map();

/* =========================================================================
   Утилиты
   ========================================================================= */

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function emptyAuth() {
  return { ...AUTH_DEFAULT };
}

function tableRefOf(table) {
  return JSON.stringify([table.schema, table.name]);
}

function tableRefOfParts(schema, name) {
  return JSON.stringify([String(schema || 'public'), String(name || '')]);
}

function tableFromValue(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return state.tables.find((t) => t.schema === parsed[0] && t.name === parsed[1]) || null;
  } catch (error) {
    return null;
  }
}

function sameTableRef(first, second) {
  if (!first || !second) return false;
  try {
    const a = JSON.parse(first);
    const b = JSON.parse(second);
    return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
  } catch (error) {
    return first === second;
  }
}

function findForm(formId) {
  return (state.project?.forms || []).find((form) => form.id === formId) || null;
}

function currentForm() {
  return findForm(state.currentFormId) || state.project?.forms?.[0] || null;
}

function findElementById(form, elementId) {
  return (form?.elements || []).find((el) => el.id === elementId) || null;
}

function findElementAnywhere(elementId) {
  for (const form of state.project?.forms || []) {
    const element = findElementById(form, elementId);
    if (element) return element;
  }
  return null;
}

function rootFormElement(form) {
  return (form?.elements || []).find((element) => element.type === 'form' && !element.parentId) || null;
}

function elementChildren(form, parentId) {
  return (form?.elements || []).filter((element) => element.parentId === parentId);
}

function parentElementOf(form, element) {
  if (!form || !element || !element.parentId) return null;
  return findElementById(form, element.parentId);
}

function isContainerElement(element) {
  return !!element && (element.type === 'form' || element.type === 'panel');
}

function topLevelElements(form) {
  const root = rootFormElement(form);
  return root ? elementChildren(form, root.id) : [];
}

function isPanelChild(element) {
  return !!element?.parentId;
}

function containerContentSize(container, width, height) {
  const w = width == null ? num(container?.w, 300) : width;
  const h = height == null ? num(container?.h, 200) : height;
  if (!container) return { w: Math.max(20, Math.round(w)), h: Math.max(20, Math.round(h)) };
  if (container.type !== 'panel') {
    return { w: Math.max(20, Math.round(w)), h: Math.max(20, Math.round(h)) };
  }
  const config = normalizePanel(container.panel);
  const head = config.title ? PANEL_HEADER : 0;
  return {
    w: Math.max(20, Math.round(w - config.padding * 2)),
    h: Math.max(20, Math.round(h - config.padding * 2 - head)),
  };
}

function containerBodyRect(container) {
  if (!container) return { left: 0, top: 0, width: 20, height: 20 };
  if (container.type !== 'panel') {
    return {
      left: 0,
      top: 0,
      width: Math.max(20, Math.round(container.w)),
      height: Math.max(20, Math.round(container.h)),
    };
  }
  const config = normalizePanel(container.panel);
  const head = config.title ? PANEL_HEADER : 0;
  return {
    left: config.padding,
    top: config.padding + head,
    width: Math.max(20, Math.round(container.w - config.padding * 2)),
    height: Math.max(20, Math.round(container.h - config.padding * 2 - head)),
  };
}

function containerBodyStyle(container) {
  const rect = containerBodyRect(container);
  return (
    'left:' + rect.left + 'px;top:' + rect.top + 'px;' +
    'width:' + rect.width + 'px;height:' + rect.height + 'px;'
  );
}

function descendantsOf(form, containerId) {
  const result = [];
  const queue = [containerId];
  const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift();
    elementChildren(form, current).forEach((child) => {
      if (seen.has(child.id)) return;
      seen.add(child.id);
      result.push(child);
      queue.push(child.id);
    });
  }
  return result;
}

function elementPathDepth(form, element) {
  let depth = 0;
  let current = parentElementOf(form, element);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    depth += 1;
    current = parentElementOf(form, current);
  }
  return depth;
}

function fitElementIntoParent(form, element) {
  const parent = parentElementOf(form, element);
  if (!parent || !isContainerElement(parent)) return;
  const content = containerContentSize(parent);
  element.w = clamp(Math.round(num(element.w, 100)), 20, Math.max(20, content.w));
  element.h = clamp(Math.round(num(element.h, 40)), 20, Math.max(20, content.h));
  element.x = clamp(Math.round(num(element.x, 0)), 0, Math.max(0, content.w - element.w));
  element.y = clamp(Math.round(num(element.y, 0)), 0, Math.max(0, content.h - element.h));
}

function scaleSubtreeGeometry(form, container, snapshot, sx, sy) {
  if (!container || !snapshot) return;
  descendantsOf(form, container.id).forEach((element) => {
    const origin = snapshot.get(element.id);
    if (!origin) return;
    element.x = Math.max(0, Math.round(origin.x * sx));
    element.y = Math.max(0, Math.round(origin.y * sy));
    element.w = Math.max(20, Math.round(origin.w * sx));
    element.h = Math.max(20, Math.round(origin.h * sy));
  });
}

function snapshotSubtree(form, container) {
  const map = new Map();
  descendantsOf(form, container.id).forEach((element) => {
    map.set(element.id, { x: element.x, y: element.y, w: element.w, h: element.h });
  });
  return map;
}

function selectedIds() {
  return Array.isArray(state.multi) ? state.multi.slice() : [];
}

function selectedElements() {
  const form = currentForm();
  if (!form) return [];
  const ids = new Set(selectedIds());
  return form.elements.filter((element) => ids.has(element.id));
}

function selectedElement() {
  if (state.selected?.kind === 'element') {
    return findElementById(findForm(state.selected.formId), state.selected.elementId);
  }
  return null;
}

function selectedForm() {
  if (state.selected?.kind === 'form') return findForm(state.selected.formId);
  return null;
}

function previewForm() {
  return findForm(state.preview.formId);
}

function settings() {
  return state.project?.settings || SETTINGS_DEFAULT;
}

function gridSize() {
  return clamp(num(settings().grid, GRID_DEFAULT), 2, 64);
}

function snapEnabled() {
  return settings().snap !== false;
}

function showGridEnabled() {
  return settings().show_grid !== false;
}

function authConfig() {
  if (!state.project) return emptyAuth();
  state.project.auth = normalizeAuth(state.project.auth);
  return state.project.auth;
}

function isTypingTarget(target) {
  if (!target) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

function toast(message, kind = 'info') {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.className = 'toast ' + kind;
  node.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3800);
}

function setSaveStatus(text, kind = '') {
  const node = $('#save-status');
  if (!node) return;
  node.textContent = text;
  node.className = 'save-status' + (kind ? ' ' + kind : '');
}

function showError(id, message) {
  const box = $(id);
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

function hideError(id) {
  const box = $(id);
  if (!box) return;
  box.textContent = '';
  box.hidden = true;
}

function openDialog(id) {
  const dialog = $(id);
  if (!dialog) return;
  if (dialog.open) dialog.close();
  dialog.showModal();
}

function closeDialog(id) {
  const dialog = $(id);
  if (dialog?.open) dialog.close();
}

/* =========================================================================
   HTTP
   ========================================================================= */

async function api(path, options = {}) {
  const opts = { method: 'GET', ...options };
  opts.headers = { ...(options.headers || {}) };
  if (opts.body != null && !opts.headers['Content-Type']) {
    opts.headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetch(path, opts);
  } catch (error) {
    throw new Error('Нет связи с сервером. Проверьте, что приложение запущено.');
  }

  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (error) {
      data = { error: raw.trim() };
    }
  }

  if (response.status === 401) {
    if (state.connected) {
      toast('Сессия истекла. Подключитесь к базе заново.', 'error');
      showConnectScreen();
    }
    throw new Error((data && data.error) || 'Требуется подключение к базе данных.');
  }

  if (!response.ok) {
    throw new Error((data && data.error) || 'Ошибка сервера (' + response.status + ').');
  }

  return data;
}

/* =========================================================================
   Нормализация проекта
   ========================================================================= */

function normalizeAuth(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const mode = source.password_mode === 'sha256' ? 'sha256' : 'plain';
  return {
    enabled: !!source.enabled,
    allow_registration: source.allow_registration !== false,
    title: String(source.title || AUTH_DEFAULT.title).slice(0, 120) || AUTH_DEFAULT.title,
    schema: 'public',
    table: String(source.table || '').slice(0, 120),
    login_column: String(source.login_column || '').slice(0, 120),
    password_column: String(source.password_column || '').slice(0, 120),
    password_mode: mode,
    role_column: String(source.role_column || '').slice(0, 120),
    welcome: String(source.welcome || '').slice(0, 240),
  };
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    grid: clamp(num(source.grid, GRID_DEFAULT), 2, 64),
    snap: source.snap !== false,
    show_grid: source.show_grid !== false,
  };
}

function normalizeLayout(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: source.mode === 'grid' ? 'grid' : 'free',
    cols: clamp(Math.round(num(source.cols, LAYOUT_DEFAULT.cols)), 1, 24),
    rows: clamp(Math.round(num(source.rows, LAYOUT_DEFAULT.rows)), 1, 60),
    gap: clamp(Math.round(num(source.gap, LAYOUT_DEFAULT.gap)), 0, 80),
  };
}

function normalizePanel(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const background = String(source.background || PANEL_DEFAULT.background);
  return {
    padding: clamp(Math.round(num(source.padding, PANEL_DEFAULT.padding)), 0, 80),
    title: String(source.title || PANEL_DEFAULT.title).slice(0, 120) || PANEL_DEFAULT.title,
    background: /^#[0-9a-f]{3,8}$/i.test(background) ? background : PANEL_DEFAULT.background,
    border: source.border !== false,
  };
}

function legacyPanelConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    rows: clamp(Math.round(num(source.rows, 3)), 1, 40),
    cols: clamp(Math.round(num(source.cols, 2)), 1, 12),
    gap: clamp(Math.round(num(source.gap, 10)), 0, 60),
  };
}

function legacyGridRect(cell, width, height, layout) {
  const rows = clamp(Math.round(num(layout?.rows, 6)), 1, 60);
  const cols = clamp(Math.round(num(layout?.cols, 4)), 1, 24);
  const gap = clamp(Math.round(num(layout?.gap, 12)), 0, 80);
  const source = cell && typeof cell === 'object' ? cell : {};
  const row = clamp(Math.round(num(source.row, 1)), 1, rows);
  const col = clamp(Math.round(num(source.col, 1)), 1, cols);
  const rowSpan = clamp(Math.round(num(source.rowSpan, 1)), 1, rows - row + 1);
  const colSpan = clamp(Math.round(num(source.colSpan, 1)), 1, cols - col + 1);
  const cellW = Math.max(20, (width - gap * (cols - 1)) / cols);
  const cellH = Math.max(20, (height - gap * (rows - 1)) / rows);
  return {
    x: Math.round((col - 1) * (cellW + gap)),
    y: Math.round((row - 1) * (cellH + gap)),
    w: Math.round(cellW * colSpan + gap * (colSpan - 1)),
    h: Math.round(cellH * rowSpan + gap * (rowSpan - 1)),
  };
}

function normalizeDbLayout(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const result = {};
  Object.entries(source).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    if (String(key).length > 200) return;
    const x = Math.round(num(value.x, 0));
    const y = Math.round(num(value.y, 0));
    result[String(key)] = { x: clamp(x, 0, 20000), y: clamp(y, 0, 20000) };
  });
  return result;
}

function normalizeProject(project, dbname) {
  const source = project && typeof project === 'object' ? project : {};
  const rawForms = Array.isArray(source.forms) ? source.forms : [];
  const usedForms = new Set();
  const usedElements = new Set();

  let forms = rawForms
    .filter((form) => form && typeof form === 'object')
    .map((form) => normalizeForm(form, usedForms, usedElements));

  if (!forms.length) {
    const form = newFormObject('Главная');
    forms = [form];
  }

  let startForm = source.start_form;
  if (!forms.some((form) => form.id === startForm)) startForm = forms[0].id;

  return {
    version: 2,
    name: String(source.name || dbname || 'Проект').slice(0, 120) || 'Проект',
    start_form: startForm,
    forms,
    auth: normalizeAuth(source.auth),
    settings: normalizeSettings(source.settings),
    db_layout: normalizeDbLayout(source.db_layout),
    meta: source.meta && typeof source.meta === 'object' ? { ...source.meta } : {},
  };
}

function newFormObject(name) {
  const formName = String(name || 'Форма').slice(0, 120) || 'Форма';
  const form = {
    id: uid('form'),
    name: formName,
    width: 1180,
    height: 900,
    background: '#ffffff',
    layout: { ...LAYOUT_DEFAULT },
    elements: [],
  };
  form.elements.push({
    id: uid('el'),
    type: 'form',
    name: formName,
    x: 40,
    y: 40,
    w: form.width,
    h: form.height,
    parentId: '',
  });
  return form;
}

function normalizeForm(form, usedForms, usedElements) {
  let id = String(form.id || uid('form')).slice(0, 80);
  while (usedForms.has(id)) id = uid('form');
  usedForms.add(id);

  const result = {
    id,
    name: String(form.name || 'Форма').slice(0, 120) || 'Форма',
    width: clamp(num(form.width, 1180), FORM_MIN_WIDTH, FORM_MAX_SIZE),
    height: clamp(num(form.height, 900), FORM_MIN_HEIGHT, FORM_MAX_SIZE),
    background: /^#[0-9a-f]{3,8}$/i.test(String(form.background || ''))
      ? String(form.background)
      : '#ffffff',
    layout: normalizeLayout(form.layout),
    elements: Array.isArray(form.elements)
      ? form.elements
          .filter(
            (element) =>
              element &&
              typeof element === 'object' &&
              element.type !== 'subform'
          )
          .map((element) => normalizeElement(element, usedElements))
      : [],
  };
  migrateFormHierarchy(result, normalizeLayout(form.layout));
  result.layout = { ...LAYOUT_DEFAULT };
  return result;
}

function migrateFormHierarchy(form, legacyLayout) {
  const elements = form.elements;

  let root = elements.find((element) => element.type === 'form' && !element.parentId) || null;
  if (!root) {
    root = {
      id: uid('el'),
      type: 'form',
      name: form.name,
      x: 36,
      y: 36,
      w: form.width,
      h: form.height,
      parentId: '',
    };
    elements.unshift(root);
  }

  elements.forEach((element) => {
    if (element === root) return;
    if (element.type !== 'form') return;
    element.type = 'panel';
    element.panel = normalizePanel(element.panel);
    if (!element.parentId) element.parentId = root.id;
  });

  root.parentId = '';
  root.x = Math.max(0, Math.round(num(root.x, 36)));
  root.y = Math.max(0, Math.round(num(root.y, 36)));
  root.w = clamp(Math.round(num(root.w, form.width)), FORM_MIN_WIDTH, FORM_MAX_SIZE);
  root.h = clamp(Math.round(num(root.h, form.height)), FORM_MIN_HEIGHT, FORM_MAX_SIZE);
  root.name = String(root.name || form.name || 'Форма').slice(0, 120);

  // Старая сетка формы: превращаем ячейки в пиксельные координаты.
  elements.forEach((element) => {
    if (element === root || element.parentId) return;
    if (legacyLayout.mode !== 'grid' || !element.cell) return;
    const rect = legacyGridRect(element.cell, form.width, form.height, legacyLayout);
    element.x = rect.x;
    element.y = rect.y;
    element.w = rect.w;
    element.h = rect.h;
  });

  // Старые панели-сетки: превращаем ячейки в координаты внутри панели.
  const panelById = new Map(
    elements.filter((element) => element.type === 'panel').map((element) => [element.id, element])
  );
  elements.forEach((element) => {
    if (!element.parentId || !element.cell) return;
    const panel = panelById.get(element.parentId);
    if (!panel || !panel._legacyPanel) return;
    const content = containerContentSize(panel);
    const rect = legacyGridRect(element.cell, content.w, content.h, panel._legacyPanel);
    element.x = rect.x;
    element.y = rect.y;
    element.w = rect.w;
    element.h = rect.h;
  });

  // Родителем может быть только форма-экран или панель.
  elements.forEach((element) => {
    if (element === root) return;
    const parent = element.parentId
      ? elements.find((item) => item.id === element.parentId)
      : null;
    if (!parent || !isContainerElement(parent) || (parent.type === 'form' && parent !== root)) {
      element.parentId = root.id;
    }
  });

  // Защита от циклов в старой структуре.
  elements.forEach((element) => {
    if (element === root) return;
    const seen = new Set([element.id]);
    let parent = element.parentId
      ? elements.find((item) => item.id === element.parentId)
      : null;
    while (parent && parent !== root) {
      if (seen.has(parent.id)) {
        element.parentId = root.id;
        break;
      }
      seen.add(parent.id);
      parent = parent.parentId
        ? elements.find((item) => item.id === parent.parentId)
        : null;
    }
  });

  elements.forEach((element) => {
    delete element.cell;
    delete element._legacyPanel;
    if (element.type === 'panel') element.panel = normalizePanel(element.panel);
    if (element !== root) fitElementIntoParent(form, element);
  });

  form.width = root.w;
  form.height = root.h;
  form.elements = elements;
}

function normalizeRoleRoutes(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const routes = [];
  raw.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const role = String(item.role || '').trim().slice(0, 120);
    const formId = String(item.formId || '').trim().slice(0, 80);
    const key = role.toLowerCase();
    if (key) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    routes.push({ role, formId });
  });
  return routes.slice(0, 50);
}

function roleRouteFormId(element, role) {
  const needle = String(role || '').trim().toLowerCase();
  if (!needle) return '';
  const match = normalizeRoleRoutes(element?.roleRoutes).find(
    (route) => route.role.toLowerCase() === needle && findForm(route.formId)
  );
  return match ? match.formId : '';
}

function normalizeElement(element, usedElements) {
  const type = ELEMENT_TYPES.includes(element.type) ? element.type : 'text';
  let id = String(element.id || uid('el')).slice(0, 80);
  while (usedElements.has(id)) id = uid('el');
  usedElements.add(id);

  let tableRef = element.table;
  if (typeof tableRef === 'string' && tableRef) {
    try {
      const parsed = JSON.parse(tableRef);
      if (Array.isArray(parsed) && parsed.length === 2) {
        tableRef = JSON.stringify([String(parsed[0]), String(parsed[1])]);
      }
    } catch (error) {
      // оставляем значение как есть
    }
  }

  const result = {
    ...element,
    id,
    type,
    name: String(element.name || TYPE_LABELS[type] || 'Элемент').slice(0, 120),
    x: Math.max(0, num(element.x, 40)),
    y: Math.max(0, num(element.y, 40)),
    w: Math.max(20, num(element.w, type === 'form' ? 1180 : 200)),
    h: Math.max(20, num(element.h, type === 'form' ? 900 : 60)),
    parentId: String(element.parentId || '').slice(0, 80),
    ...(tableRef != null ? { table: tableRef } : {}),
  };

  if (type === 'button') {
    result.postLoginForm = String(element.postLoginForm || '').slice(0, 80);
    result.roleRoutes = normalizeRoleRoutes(element.roleRoutes);
  }
  if (type === 'panel') {
    result.panel = normalizePanel(element.panel);
    result._legacyPanel = legacyPanelConfig(element.panel);
  }
  if (type === 'sql') {
    result.query = String(element.query || SQL_DEFAULT.query).slice(0, 20000);
    result.limit = clamp(Math.round(num(element.limit, SQL_DEFAULT.limit)), 1, 500);
  }
  if (type === 'select') {
    result.label = String(element.label || 'Выбор').slice(0, 160) || 'Выбор';
    result.table = String(element.table || '');
    result.column = String(element.column || '');
    result.labelColumn = String(element.labelColumn || '');
    result.placeholder = String(element.placeholder || '— выберите —').slice(0, 160);
    result.required = !!element.required;
  }
  if (type === 'image') {
    result.src = String(element.src || '');
    result.alt = String(element.alt || 'Изображение').slice(0, 160);
    result.fit = ['contain', 'cover', 'fill'].includes(element.fit) ? element.fit : 'contain';
    result.radius = clamp(Math.round(num(element.radius, 0)), 0, 80);
  }
  if (element.cell && typeof element.cell === 'object') {
    result.cell = {
      row: clamp(Math.round(num(element.cell.row, 1)), 1, 60),
      col: clamp(Math.round(num(element.cell.col, 1)), 1, 24),
      rowSpan: clamp(Math.round(num(element.cell.rowSpan, 1)), 1, 60),
      colSpan: clamp(Math.round(num(element.cell.colSpan, 1)), 1, 24),
    };
  }
  return result;
}

/* =========================================================================
   Сохранение проекта
   ========================================================================= */

function updateHistoryButtons() {
  const undo = $('#undo-btn');
  const redo = $('#redo-btn');
  if (undo) undo.disabled = !state.history.undo.length;
  if (redo) redo.disabled = !state.history.redo.length;
}

function resetHistory() {
  state.history.undo = [];
  state.history.redo = [];
  state.history.base = state.project ? JSON.stringify(state.project) : null;
  state.history.lastPush = 0;
  state.history.lock = false;
  updateHistoryButtons();
}

function commitHistory() {
  if (!state.project || state.history.lock) return;
  const snapshot = JSON.stringify(state.project);
  if (!state.history.base) {
    state.history.base = snapshot;
    return;
  }
  if (snapshot === state.history.base) return;

  const now = Date.now();
  if (now - state.history.lastPush > 650) {
    state.history.undo.push(state.history.base);
    if (state.history.undo.length > 100) state.history.undo.shift();
    state.history.redo = [];
  }
  state.history.base = snapshot;
  state.history.lastPush = now;
  updateHistoryButtons();
}

function restoreHistorySnapshot(json) {
  if (!json) return;
  let project;
  try {
    project = normalizeProject(JSON.parse(json), state.db?.database || '');
  } catch (error) {
    return;
  }
  state.history.lock = true;
  state.project = project;
  if (!findForm(state.currentFormId)) state.currentFormId = project.start_form;
  state.openForms = state.openForms.filter((id) => findForm(id));
  if (!state.openForms.length) state.openForms = [state.currentFormId];
  state.multi = [];
  state.selected = { kind: 'form', formId: state.currentFormId };
  state.preview.formId = state.currentFormId;
  state.history.base = JSON.stringify(project);
  state.history.lastPush = 0;
  syncSettingsUi();
  renderAll();
  if (state.mainTab === 'database') renderDbScreen();
  if (state.mainTab === 'auth') renderAuthScreen();
  if (state.mainTab === 'routines') renderRoutinesScreen();
  state.history.lock = false;

  state.dirty = true;
  setSaveStatus('Сохранение…', 'saving');
  saveProject();
}

function undoProject() {
  if (!state.project || !state.history.undo.length) return;
  const current = JSON.stringify(state.project);
  const previous = state.history.undo.pop();
  state.history.redo.push(current);
  restoreHistorySnapshot(previous);
  updateHistoryButtons();
  toast('Изменение отменено', 'info');
}

function redoProject() {
  if (!state.project || !state.history.redo.length) return;
  const current = JSON.stringify(state.project);
  const next = state.history.redo.pop();
  state.history.undo.push(current);
  restoreHistorySnapshot(next);
  updateHistoryButtons();
  toast('Изменение повторено', 'info');
}

function scheduleSave() {
  if (!state.connected || !state.project) return;
  commitHistory();
  state.dirty = true;
  setSaveStatus('Сохранение…', 'saving');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveProject, SAVE_DELAY);
}

async function saveProject() {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (!state.connected || !state.project) return;

  const seq = ++state.saveSeq;
  const snapshot = JSON.parse(JSON.stringify(state.project));
  try {
    await api('/api/project', { method: 'PUT', body: JSON.stringify(snapshot) });
    if (seq === state.saveSeq) {
      state.dirty = false;
      setSaveStatus('Сохранено');
    }
  } catch (error) {
    if (seq === state.saveSeq) setSaveStatus('Не сохранено', 'error');
    toast('Не удалось сохранить проект: ' + error.message, 'error');
  }
}

async function flushSave() {
  if (!state.dirty) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  await saveProject();
}

/* =========================================================================
   Экраны
   ========================================================================= */

function showConnectScreen() {
  state.connected = false;
  state.db = null;
  state.tables = [];
  state.project = null;
  state.currentFormId = null;
  state.selected = null;
  state.multi = [];
  state.expanded = new Set();
  state.openForms = [];
  state.preview = { formId: null };
  state.auth = { enabled: false, configured: false, authenticated: false, user: null };
  state.authUsers = [];
  state.authRolesRequested = false;
  state.routines = {
    functions: [],
    procedures: [],
    triggers: [],
    loaded: false,
    loading: false,
    selected: null,
  };
  state.dialog = null;
  state.dbLink = null;
  state.clipboard = null;
  state.history.undo = [];
  state.history.redo = [];
  state.history.base = null;
  state.history.lastPush = 0;
  state.dirty = false;
  clearTimeout(state.saveTimer);
  rowCache.clear();
  sqlCache.clear();
  updateHistoryButtons();

  $('#connect-screen').hidden = false;
  $('#builder').hidden = true;
  $('#preview').hidden = true;
  resetConnectScreen();
  setSaveStatus('Сохранено');
}

function resetConnectScreen() {
  const form = $('#connect-form');
  const intro = $('#connect-intro');
  const hint = $('#connect-hint');
  if (form) form.hidden = true;
  if (intro) intro.hidden = false;
  if (hint) hint.hidden = true;
  hideError('#connect-error');
}

function showConnectForm() {
  const form = $('#connect-form');
  if (!form) return;
  $('#connect-intro').hidden = true;
  form.hidden = false;
  $('#connect-hint').hidden = false;
  const host = form.querySelector('[name="host"]');
  if (host) host.focus();
}

function showBuilderScreen() {
  $('#connect-screen').hidden = true;
  $('#builder').hidden = false;
  $('#preview').hidden = true;
  applyLayoutSizes();
}

function showPreviewScreen() {
  $('#connect-screen').hidden = true;
  $('#builder').hidden = true;
  $('#preview').hidden = false;
}

function normalizeAuthStatus(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const user = source.user && typeof source.user === 'object'
    ? { login: String(source.user.login || ''), role: String(source.user.role || '') }
    : null;
  return {
    enabled: !!source.enabled,
    configured: !!source.configured,
    authenticated: !!source.authenticated,
    user,
  };
}

function enterBuilder(data) {
  state.connected = true;
  state.tables = Array.isArray(data.tables) ? data.tables : [];
  state.db = {
    database: data.database,
    user: data.user,
    host: data.host,
    port: data.port,
    version: data.version,
  };
  state.project = normalizeProject(data.project, data.database);
  state.auth = normalizeAuthStatus(data.auth);
  state.routines = {
    functions: [],
    procedures: [],
    triggers: [],
    loaded: false,
    loading: false,
    selected: null,
  };
  state.currentFormId = state.project.start_form;
  state.openForms = [state.currentFormId];
  state.selected = { kind: 'form', formId: state.currentFormId };
  state.multi = [];
  state.expanded = new Set(state.project.forms.map((form) => form.id));
  state.dirty = false;
  state.dbLink = null;
  state.clipboard = null;

  const dbLabel = $('#db-label');
  if (dbLabel) {
    dbLabel.textContent =
      state.db.database + ' · ' + state.db.user + '@' + state.db.host + ':' + state.db.port;
  }
  const currentName = $('#db-current-name');
  if (currentName) currentName.textContent = state.db.database || '—';

  setSaveStatus('Сохранено');
  showBuilderScreen();
  switchMainTab('builder');
  renderAll();
  syncSettingsUi();
  resetHistory();
  resetRoutinesUi();
}

function renderAll() {
  renderTablePalette();
  renderTree();
  renderFormTabs();
  renderCanvas();
  renderProperties();
  updateCrumb();
  updateFormSizeLabel(currentForm());
  updateAlignToolbar();
}

/* =========================================================================
   Подключение
   ========================================================================= */

function bindConnectScreen() {
  const form = $('#connect-form');
  if (!form) return;

  const startButton = $('#connect-start-btn');
  if (startButton) {
    startButton.addEventListener('click', () => {
      state.newProjectOnConnect = false;
      showConnectForm();
    });
  }
  const newButton = $('#connect-new-btn');
  if (newButton) {
    newButton.addEventListener('click', () => {
      state.newProjectOnConnect = true;
      showConnectForm();
      toast('После подключения будет создан пустой проект', 'info');
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#connect-btn');
    hideError('#connect-error');

    const data = Object.fromEntries(new FormData(form).entries());
    const payload = {
      host: String(data.host || '').trim(),
      dbname: String(data.dbname || '').trim(),
      user: String(data.user || '').trim(),
      password: String(data.password || ''),
      port: Number(data.port || 5432),
    };

    button.disabled = true;
    button.textContent = 'Подключение…';
    try {
      const result = await api('/api/connect', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      enterBuilder(result);
      if (state.newProjectOnConnect) {
        state.newProjectOnConnect = false;
        try {
          const created = await api('/api/projects/new', { method: 'POST' });
          applyProject(created.project);
          toast('Создан новый пустой проект', 'success');
        } catch (error) {
          toast('Не удалось создать новый проект: ' + error.message, 'error');
        }
      } else {
        toast('Подключено: ' + result.database, 'success');
      }
    } catch (error) {
      showError('#connect-error', error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Подключиться';
    }
  });
}

async function restoreSession() {
  try {
    const data = await api('/api/state');
    if (data && data.connected) enterBuilder(data);
    else showConnectScreen();
  } catch (error) {
    showConnectScreen();
  }
}

async function disconnect() {
  if (!confirm('Отключиться от базы данных? Несохранённые изменения будут потеряны.')) return;
  try {
    await flushSave();
  } catch (error) {
    // ошибка уже показана
  }
  try {
    await api('/api/disconnect', { method: 'POST' });
  } catch (error) {
    // даже если запрос не удался, возвращаемся к экрану подключения
  }
  showConnectScreen();
  toast('Отключено от базы данных', 'info');
}

function applyTables(tables) {
  state.tables = Array.isArray(tables) ? tables : [];
  rowCache.clear();
  sqlCache.clear();
  renderTablePalette();
  if (state.project) {
    renderCanvas();
    renderProperties();
  }
  if (state.mainTab === 'database') renderDbScreen();
  if (state.mainTab === 'auth') renderAuthScreen();
  if (state.mainTab === 'routines') renderRoutinesScreen();
}

async function refreshSchema(options = {}) {
  const button = options.button || $('#refresh-schema-btn');
  const oldText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = '↻ Чтение…';
  }
  try {
    const data = await api('/api/schema/refresh', { method: 'POST' });
    applyTables(data.tables);
    if (!options.silent) toast('Список таблиц обновлён', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = oldText;
    }
  }
}

/* =========================================================================
   Общая обвязка редактора
   ========================================================================= */

function bindBuilderChrome() {
  $('#refresh-schema-btn').addEventListener('click', () => refreshSchema());
  $('#refresh-tables-btn').addEventListener('click', () => refreshSchema());
  $('#disconnect-btn').addEventListener('click', disconnect);
  $('#preview-btn').addEventListener('click', startPreview);
  $('#add-form-btn').addEventListener('click', addForm);
  $('#project-btn').addEventListener('click', openProjectDialog);
  $('#preview-home-btn').addEventListener('click', goPreviewHome);
  $('#exit-preview-btn').addEventListener('click', exitPreview);
  $('#preview-logout-btn').addEventListener('click', logoutPreview);
  const exportHtml = $('#preview-export-btn');
  if (exportHtml) exportHtml.addEventListener('click', downloadStandalonePreview);
  const previewApp = $('#preview-app-btn');
  if (previewApp) previewApp.addEventListener('click', downloadPortableApp);
  const topbarApp = $('#app-download-btn');
  if (topbarApp) topbarApp.addEventListener('click', downloadPortableApp);

  $('#undo-btn').addEventListener('click', undoProject);
  $('#redo-btn').addEventListener('click', redoProject);

  const gapH = $('#gap-h-btn');
  if (gapH) gapH.addEventListener('click', () => applyEqualGap('h'));
  const gapV = $('#gap-v-btn');
  if (gapV) gapV.addEventListener('click', () => applyEqualGap('v'));

  $('#snap-toggle').addEventListener('change', (event) => {
    if (!state.project) return;
    state.project.settings.snap = event.target.checked;
    syncProjectDialog();
    scheduleSave();
  });

  $$('#align-toolbar .align-btn').forEach((button) => {
    button.addEventListener('click', () => alignSelection(button.dataset.align));
  });

  bindMainTabs();
  bindFormTabs();
  bindPalette();
  bindCanvas();
  bindTree();
  bindProperties();
  bindPreview();
  bindDialog();
  bindDbScreen();
  bindAuthScreen();
  bindRoutinesScreen();
  bindProjectDialog();
  bindHintDismissal();
  bindResizers();
}

/* =========================================================================
   Размеры панелей: ползунки и запоминание
   ========================================================================= */

const LAYOUT_KEY = 'db2ui.layout.v1';
let layoutSizes = null;

function readSavedLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (error) {
    return {};
  }
}

function persistLayout() {
  if (!layoutSizes) return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutSizes));
  } catch (error) {
    // localStorage может быть недоступен
  }
}

function applyLayoutSizes() {
  const workspace = $('.workspace');
  if (!workspace) return;
  const rect = workspace.getBoundingClientRect();
  if (rect.width < 200 || rect.height < 100) return;
  const palette = workspace.querySelector('.palette');
  const inspector = workspace.querySelector('.inspector');
  const paletteItems = palette?.querySelector('.palette-items');
  const tree = inspector?.querySelector('.tree-section');
  if (!palette || !inspector || !paletteItems || !tree) return;

  const saved = readSavedLayout();
  const current = layoutSizes || {};
  const gutter = 14;
  const centerMin = 320;

  const sourceLeft = Number(current.left) || Number(saved.left) ||
    palette.getBoundingClientRect().width || 270;
  const sourceRight = Number(current.right) || Number(saved.right) ||
    inspector.getBoundingClientRect().width || 354;
  const maxLeft = Math.max(150, rect.width - 240 - centerMin - gutter);
  const left = clamp(Math.round(sourceLeft), 150, Math.min(560, maxLeft));
  const maxRight = Math.max(220, rect.width - left - centerMin - gutter);
  const right = clamp(Math.round(sourceRight), 220, Math.min(680, maxRight));

  workspace.style.setProperty('--sidebar-left', left + 'px');
  workspace.style.setProperty('--sidebar-right', right + 'px');

  const paletteRect = palette.getBoundingClientRect();
  const sourcePalette = Number(current.palette) || Number(saved.palette) ||
    paletteItems.getBoundingClientRect().height;
  const maxPalette = Math.max(110, paletteRect.height - 220);
  const paletteHeight = clamp(Math.round(sourcePalette), 90, maxPalette);
  palette.style.setProperty('--palette-items-height', paletteHeight + 'px');

  const inspectorRect = inspector.getBoundingClientRect();
  const sourceTree = Number(current.tree) || Number(saved.tree) ||
    inspectorRect.height * 0.44;
  const maxTree = Math.max(130, inspectorRect.height - 220);
  const treeHeight = clamp(Math.round(sourceTree), 110, maxTree);
  inspector.style.setProperty('--tree-height', treeHeight + 'px');

  layoutSizes = { left, right, palette: paletteHeight, tree: treeHeight };
}

function resizeLayout(key, size) {
  if (!layoutSizes) applyLayoutSizes();
  if (!layoutSizes) return;
  if (key === 'left' || key === 'right') {
    const workspace = $('.workspace');
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    const other = key === 'left' ? layoutSizes.right : layoutSizes.left;
    const min = key === 'left' ? 150 : 220;
    const limit = key === 'left' ? 560 : 680;
    const max = Math.max(min, rect.width - other - 320 - 14);
    const value = clamp(Math.round(size), min, Math.min(limit, max));
    layoutSizes[key] = value;
    workspace.style.setProperty(
      key === 'left' ? '--sidebar-left' : '--sidebar-right',
      value + 'px'
    );
    return;
  }
  if (key === 'tree') {
    const inspector = $('.inspector');
    if (!inspector) return;
    const max = Math.max(130, inspector.getBoundingClientRect().height - 220);
    const value = clamp(Math.round(size), 110, max);
    layoutSizes.tree = value;
    inspector.style.setProperty('--tree-height', value + 'px');
    return;
  }
  if (key === 'palette') {
    const palette = $('.palette');
    if (!palette) return;
    const max = Math.max(110, palette.getBoundingClientRect().height - 220);
    const value = clamp(Math.round(size), 90, max);
    layoutSizes.palette = value;
    palette.style.setProperty('--palette-items-height', value + 'px');
  }
}

function resetLayoutSizes() {
  layoutSizes = null;
  try {
    localStorage.removeItem(LAYOUT_KEY);
  } catch (error) {
    // ignore
  }
  const workspace = $('.workspace');
  const palette = $('.palette');
  const inspector = $('.inspector');
  if (workspace) {
    workspace.style.removeProperty('--sidebar-left');
    workspace.style.removeProperty('--sidebar-right');
  }
  if (palette) palette.style.removeProperty('--palette-items-height');
  if (inspector) inspector.style.removeProperty('--tree-height');
  applyLayoutSizes();
}

function bindResizeHandle(handle, axis) {
  const key = handle.dataset.resizer;
  const invert = key === 'right' ? -1 : 1;
  let start = 0;
  let base = 0;
  let dragging = false;

  const pointerMove = (event) => {
    if (!dragging) return;
    const position = axis === 'x' ? event.clientX : event.clientY;
    resizeLayout(key, base + (position - start) * invert);
  };

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.classList.remove('layout-resizing');
    delete document.body.dataset.resizeAxis;
    window.removeEventListener('pointermove', pointerMove);
    persistLayout();
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    if (!layoutSizes) applyLayoutSizes();
    if (!layoutSizes) return;
    dragging = true;
    base = Number(layoutSizes[key]) || 0;
    start = axis === 'x' ? event.clientX : event.clientY;
    handle.classList.add('active');
    document.body.classList.add('layout-resizing');
    document.body.dataset.resizeAxis = axis;
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  });

  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 16;
    let delta = 0;
    if (axis === 'x') {
      if (event.key === 'ArrowLeft') delta = -step;
      else if (event.key === 'ArrowRight') delta = step;
    } else if (event.key === 'ArrowUp') {
      delta = -step;
    } else if (event.key === 'ArrowDown') {
      delta = step;
    }
    if (!delta) return;
    event.preventDefault();
    if (!layoutSizes) applyLayoutSizes();
    if (!layoutSizes) return;
    resizeLayout(key, (Number(layoutSizes[key]) || 0) + delta * invert);
    persistLayout();
  });

  handle.addEventListener('dblclick', () => resetLayoutSizes());
}

function bindResizers() {
  const workspace = $('.workspace');
  if (!workspace) return;
  $$('[data-resizer]', workspace).forEach((handle) => {
    bindResizeHandle(handle, handle.classList.contains('resizer-v') ? 'x' : 'y');
  });
  window.addEventListener('resize', () => applyLayoutSizes());
}

/* =========================================================================
   Вкладки
   ========================================================================= */

function bindMainTabs() {
  const tabs = $('#main-tabs');
  if (!tabs) return;
  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('.main-tab');
    if (!button) return;
    switchMainTab(button.dataset.tab);
  });
}

function switchMainTab(tab) {
  if (tab !== 'builder' && tab !== 'database' && tab !== 'auth' && tab !== 'routines') tab = 'builder';
  state.mainTab = tab;
  const activeMain = tab === 'database' ? 'builder' : tab;
  $$('#main-tabs .main-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === activeMain);
  });
  const workspace = $('#builder-screen .workspace');
  $('#builder-screen').hidden = tab === 'auth' || tab === 'routines';
  $('#auth-screen').hidden = tab !== 'auth';
  const routinesScreen = $('#routines-screen');
  if (routinesScreen) routinesScreen.hidden = tab !== 'routines';
  if (workspace) workspace.hidden = tab !== 'builder';
  const dbScreen = $('#db-screen');
  if (dbScreen) dbScreen.hidden = tab !== 'database';

  if (tab === 'builder' || tab === 'database') {
    renderFormTabs();
  }
  if (tab === 'builder') {
    renderCanvas();
    renderProperties();
    applyLayoutSizes();
  } else if (tab === 'database') {
    renderDbScreen();
  } else if (tab === 'auth') {
    renderAuthScreen();
    loadAuthUsers();
  } else if (tab === 'routines') {
    openRoutinesScreen();
  }
}

function bindFormTabs() {
  const wrap = $('#form-tabs');
  if (!wrap) return;
  wrap.addEventListener('click', (event) => {
    const add = event.target.closest('#form-tab-add');
    if (add) {
      addForm();
      return;
    }
    if (event.target.closest('[data-open-database]')) {
      switchMainTab('database');
      return;
    }
    const close = event.target.closest('[data-close-form]');
    if (close) {
      closeFormTab(close.dataset.closeForm);
      return;
    }
    const open = event.target.closest('[data-open-form]');
    if (open) openFormTab(open.dataset.openForm);
  });
}

function renderFormTabs() {
  const wrap = $('#form-tabs');
  if (!wrap || !state.project) return;

  const forms = state.project.forms;
  const known = new Set(forms.map((form) => form.id));
  state.openForms = state.openForms.filter((id) => known.has(id));
  if (!state.openForms.length && state.currentFormId) state.openForms = [state.currentFormId];

  const canClose = state.openForms.length > 1;
  let html = state.openForms
    .map((formId) => {
      const form = findForm(formId);
      if (!form) return '';
      const active = formId === state.currentFormId && state.mainTab !== 'database';
      return (
        '<div class="form-tab' + (active ? ' active' : '') + '">' +
        '<button type="button" class="form-tab-label" data-open-form="' + escapeAttr(form.id) + '" title="' + escapeAttr(form.name) + '">' +
        escapeHtml(form.name) + '</button>' +
        (canClose
          ? '<button type="button" class="form-tab-close" data-close-form="' + escapeAttr(form.id) + '" title="Закрыть форму">×</button>'
          : '') +
        '</div>'
      );
    })
    .join('');

  html +=
    '<button type="button" class="form-tab system-tab' +
    (state.mainTab === 'database' ? ' active' : '') +
    '" data-open-database title="Таблицы и связи — в той же полосе, что и формы">' +
    '<span class="st-icon">▦</span> Таблицы и связи</button>';
  html += '<button type="button" class="form-tab-add" id="form-tab-add" title="Новая форма">＋</button>';
  wrap.innerHTML = html;
}

function openFormTab(formId) {
  if (!findForm(formId)) return;
  if (!state.openForms.includes(formId)) state.openForms.push(formId);
  if (state.currentFormId !== formId) selectForm(formId);
  else renderFormTabs();
  if (state.mainTab !== 'builder') switchMainTab('builder');
}

function closeFormTab(formId) {
  if (state.openForms.length <= 1) return;
  const index = state.openForms.indexOf(formId);
  if (index < 0) return;
  state.openForms.splice(index, 1);
  if (state.currentFormId === formId) {
    const next = state.openForms[Math.min(index, state.openForms.length - 1)];
    selectForm(next);
  } else {
    renderFormTabs();
  }
}

/* =========================================================================
   Палитра
   ========================================================================= */

function bindPalette() {
  $$('.palette-item').forEach((item) => {
    item.addEventListener('dragstart', (event) => {
      const payload = JSON.stringify({ kind: 'element', type: item.dataset.type });
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('application/x-db2ui', payload);
      event.dataTransfer.setData('text/plain', payload);
    });
    item.addEventListener('click', () => {
      addElement(item.dataset.type, null, null);
    });
  });

  $('#table-list').addEventListener('dragstart', (event) => {
    const item = event.target.closest('.table-item');
    if (!item) return;
    const table = state.tables.find(
      (t) => t.schema === item.dataset.schema && t.name === item.dataset.table
    );
    if (!table) return;
    const payload = JSON.stringify({
      kind: 'table',
      schema: table.schema,
      table: table.name,
      label: table.label,
    });
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('application/x-db2ui', payload);
    event.dataTransfer.setData('text/plain', payload);
  });

  $('#table-list').addEventListener('click', (event) => {
    const item = event.target.closest('.table-item');
    if (!item) return;
    const table = state.tables.find(
      (t) => t.schema === item.dataset.schema && t.name === item.dataset.table
    );
    if (table) addElement('table', null, null, { table: tableRefOf(table), name: table.label });
  });
}

function renderTablePalette() {
  const list = $('#table-list');
  if (!list) return;
  if (!state.tables.length) {
    list.innerHTML = '<div class="empty-small">В этой базе не найдено пользовательских таблиц.</div>';
    return;
  }

  list.innerHTML = state.tables
    .map(
      (table) => `
      <div class="table-item" draggable="true"
           data-schema="${escapeAttr(table.schema)}"
           data-table="${escapeAttr(table.name)}"
           title="Перетащите таблицу на холст">
        <span class="ti-icon">▦</span>
        <span class="ti-text">
          <b>${escapeHtml(table.label)}</b>
          <small>${table.columns.length} колонок${table.primary_key.length ? '' : ' · без ключа'}</small>
        </span>
      </div>`
    )
    .join('');
}

/* =========================================================================
   Выделение и вкладки форм
   ========================================================================= */

function selectForm(formId) {
  const form = findForm(formId);
  if (!form) return;
  state.currentFormId = formId;
  state.multi = [];
  state.selected = { kind: 'form', formId };
  if (!state.openForms.includes(formId)) state.openForms.push(formId);
  state.expanded.add(formId);
  state.preview.formId = formId;
  renderFormTabs();
  renderCanvas();
  renderTree();
  renderProperties();
  updateCrumb();
}

function selectElement(formId, elementId) {
  const form = findForm(formId);
  const element = findElementById(form, elementId);
  if (!form || !element) return;
  state.currentFormId = formId;
  if (!state.openForms.includes(formId)) state.openForms.push(formId);
  state.multi = [elementId];
  state.selected = { kind: 'element', formId, elementId };
  state.expanded.add(formId);
  renderFormTabs();
  renderCanvas();
  renderTree();
  renderProperties();
  updateCrumb();
}

function selectMany(formId, ids) {
  const form = findForm(formId);
  if (!form) return;
  const clean = Array.from(new Set(ids)).filter((id) => findElementById(form, id));
  if (!clean.length) {
    selectForm(formId);
    return;
  }
  state.currentFormId = formId;
  if (!state.openForms.includes(formId)) state.openForms.push(formId);
  state.multi = clean;
  state.selected = clean.length === 1
    ? { kind: 'element', formId, elementId: clean[0] }
    : { kind: 'multi', formId };
  state.expanded.add(formId);
  renderFormTabs();
  renderCanvas();
  renderTree();
  renderProperties();
  updateCrumb();
}

function updateSelectionClasses() {
  const ids = new Set(selectedIds());
  $$('#canvas .element').forEach((node) => {
    node.classList.toggle('selected', ids.has(node.dataset.id));
  });
  updateAlignToolbar();
}

function updateCrumb() {
  const form = currentForm();
  const crumb = $('#form-crumb');
  if (crumb) crumb.textContent = form ? form.name : '—';
  const previewName = $('#preview-form-name');
  if (previewName && state.mainTab === 'builder' && form) previewName.textContent = form.name;
}

function updateFormSizeLabel(form) {
  const label = $('#form-size-label');
  if (!label) return;
  const root = rootFormElement(form);
  label.textContent = root
    ? 'экран ' + Math.round(root.w) + ' × ' + Math.round(root.h) + ' px'
    : 'рабочее пространство';
}

function elementGeometryStyle(element) {
  return (
    'left:' + Math.round(element.x) + 'px;' +
    'top:' + Math.round(element.y) + 'px;' +
    'width:' + Math.round(element.w) + 'px;' +
    'height:' + Math.round(element.h) + 'px'
  );
}

function applyFormSurfaceStyles(form) {
  const canvas = $('#canvas');
  if (!canvas) return;
  const root = rootFormElement(form);
  const width = root ? Math.max(1180, root.x + root.w + 260) : 1400;
  const height = root ? Math.max(820, root.y + root.h + 260) : 1000;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.style.background = '#f8fafc';
  if (showGridEnabled()) {
    canvas.style.backgroundImage = 'radial-gradient(#dde5f1 1px, transparent 1px)';
    canvas.style.backgroundSize = gridSize() + 'px ' + gridSize() + 'px';
  } else {
    canvas.style.backgroundImage = 'none';
    canvas.style.backgroundSize = 'auto';
  }
  updateFormSizeLabel(form);
}

function syncSettingsUi() {
  const snap = $('#snap-toggle');
  if (snap) snap.checked = snapEnabled();
  syncProjectDialog();
  const form = currentForm();
  if (form) applyFormSurfaceStyles(form);
}

function updateAlignToolbar() {
  const form = currentForm();
  const root = rootFormElement(form);
  const count = form
    ? selectedElements().filter((element) => element !== root).length
    : 0;
  $$('#align-toolbar .align-btn').forEach((button) => {
    const mode = button.dataset.align;
    if (mode === 'distribute-h' || mode === 'distribute-v') {
      button.disabled = count < 3;
    } else {
      button.disabled = count < 1;
    }
  });
}

/* =========================================================================
   Добавление и изменение элементов
   ========================================================================= */

function uniqueElementName(form, type) {
  const base = TYPE_LABELS[type] || 'Элемент';
  let index = 1;
  const used = new Set((form?.elements || []).map((el) => el.name));
  while (used.has(base + ' ' + index)) index += 1;
  return base + ' ' + index;
}

function nextPosition(parent, form, width, height) {
  const content = containerContentSize(parent);
  const index = parent ? elementChildren(form, parent.id).length : 0;
  const x = 22 + (index % 8) * 24;
  const y = 22 + (index % 8) * 22;
  return {
    x: clamp(x, 0, Math.max(0, content.w - width)),
    y: clamp(y, 0, Math.max(0, content.h - height)),
  };
}

function defaultElement(type, form, extra = {}) {
  const sizes = {
    text: [260, 46],
    button: [180, 44],
    input: [280, 66],
    select: [280, 66],
    image: [320, 220],
    table: [680, 380],
    panel: [420, 280],
    sql: [720, 400],
  };
  const [defaultW, defaultH] = sizes[type] || [200, 60];
  const w = Math.max(20, Math.round(num(extra.w, defaultW)));
  const h = Math.max(20, Math.round(num(extra.h, defaultH)));
  const parentId = String(extra.parentId || '');
  const parent = parentId ? findElementById(form, parentId) : rootFormElement(form);
  const pos = nextPosition(parent, form, w, h);
  const base = {
    ...extra,
    id: uid('el'),
    type,
    name: String(extra.name || uniqueElementName(form, type)).slice(0, 120),
    x: extra.x == null ? pos.x : Math.max(0, Math.round(num(extra.x, pos.x))),
    y: extra.y == null ? pos.y : Math.max(0, Math.round(num(extra.y, pos.y))),
    w,
    h,
    parentId: parent ? parent.id : '',
  };

  if (type === 'text') {
    return {
      ...base,
      text: 'Заголовок',
      fontSize: 20,
      fontWeight: '700',
      color: '#172033',
      align: 'left',
      ...extra,
    };
  }
  if (type === 'button') {
    return {
      ...base,
      text: 'Кнопка',
      action: 'navigate',
      targetForm: '',
      table: '',
      postLoginForm: '',
      roleRoutes: [],
      color: '#4f46e5',
      textColor: '#ffffff',
      fontSize: 14,
      ...extra,
    };
  }
  if (type === 'input') {
    return {
      ...base,
      label: 'Поле',
      table: '',
      column: '',
      placeholder: '',
      inputType: 'text',
      required: false,
      ...extra,
    };
  }
  if (type === 'select') {
    return {
      ...base,
      label: 'Выбор',
      table: '',
      column: '',
      labelColumn: '',
      placeholder: '— выберите —',
      required: false,
      ...extra,
    };
  }
  if (type === 'image') {
    return {
      ...base,
      src: '',
      alt: 'Изображение',
      fit: 'contain',
      radius: 0,
      ...extra,
    };
  }
  if (type === 'panel') {
    return {
      ...base,
      panel: { ...PANEL_DEFAULT, ...(extra.panel || {}) },
      ...extra,
    };
  }
  if (type === 'sql') {
    return {
      ...base,
      query: SQL_DEFAULT.query,
      limit: SQL_DEFAULT.limit,
      ...extra,
    };
  }
  return {
    ...base,
    table: '',
    limit: 50,
    editable: true,
    allowAdd: true,
    allowEdit: true,
    allowDelete: true,
    ...extra,
  };
}

function elementsWithChildren(form, elements) {
  const ids = new Set(elements.map((element) => element.id));
  let changed = true;
  while (changed) {
    changed = false;
    (form?.elements || []).forEach((element) => {
      if (element.parentId && ids.has(element.parentId) && !ids.has(element.id)) {
        ids.add(element.id);
        changed = true;
      }
    });
  }
  return (form?.elements || []).filter((element) => ids.has(element.id));
}

function addElementInto(container, type, x, y, extra = {}) {
  const form = currentForm();
  if (!form || !isContainerElement(container) || type === 'form' || !TYPE_LABELS[type]) return null;
  const element = defaultElement(type, form, { ...extra, parentId: container.id });
  if (x != null) element.x = Math.max(0, Math.round(num(x, element.x)));
  if (y != null) element.y = Math.max(0, Math.round(num(y, element.y)));
  fitElementIntoParent(form, element);
  form.elements.push(element);
  state.expanded.add(form.id);
  state.preview.formId = form.id;
  selectElement(form.id, element.id);
  scheduleSave();
  return element;
}

function addElement(type, x, y, extra = {}) {
  const form = currentForm();
  if (!form || type === 'form' || !TYPE_LABELS[type]) return null;
  const parent = extra.parentId
    ? findElementById(form, extra.parentId)
    : rootFormElement(form);
  if (!isContainerElement(parent)) return null;

  const element = addElementInto(parent, type, x, y, extra);
  if (!element) return null;

  const table = element.type === 'table' ? tableFromValue(element.table) : null;
  if (table) toast('Таблица «' + table.label + '» добавлена на форму', 'success');
  else if (parent.type === 'panel') {
    toast('Элемент добавлен в панель «' + parent.name + '»', 'success');
  }
  return element;
}

function cloneElementsInto(form, sources, offset = 24) {
  const idMap = new Map(sources.map((element) => [element.id, uid('el')]));
  const copies = [];

  sources.forEach((source) => {
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = idMap.get(source.id);
    copy.name = uniqueElementName(form, copy.type);
    if (copy.type === 'form') copy.type = 'panel';
    if (copy.type === 'panel') copy.panel = normalizePanel(copy.panel);

    const copiedParent = source.parentId && idMap.has(source.parentId)
      ? idMap.get(source.parentId)
      : '';
    if (copiedParent) {
      copy.parentId = copiedParent;
    } else {
      const parent = source.parentId ? findElementById(form, source.parentId) : rootFormElement(form);
      copy.parentId = parent && isContainerElement(parent) ? parent.id : '';
      copy.x = Math.max(0, Math.round(num(copy.x, 0) + offset));
      copy.y = Math.max(0, Math.round(num(copy.y, 0) + offset));
    }

    fitElementIntoParent(form, copy);
    form.elements.push(copy);
    copies.push(copy);
  });

  return copies;
}

function duplicateSelectedElements() {
  const form = currentForm();
  const selected = selectedElements().filter((element) => element.type !== 'form');
  if (!form || !selected.length) {
    toast('Выделите элементы, которые нужно продублировать.', 'error');
    return;
  }
  const elements = elementsWithChildren(form, selected);
  const copies = cloneElementsInto(form, elements, 24);
  selectMany(form.id, copies.map((copy) => copy.id));
  scheduleSave();
  toast(copies.length > 1 ? 'Элементы скопированы' : 'Элемент скопирован', 'success');
}

function copySelectedElements() {
  const form = currentForm();
  const selected = selectedElements().filter((element) => element.type !== 'form');
  if (!form || !selected.length) {
    toast('Сначала выделите элементы для копирования.', 'error');
    return;
  }
  const elements = elementsWithChildren(form, selected);
  state.clipboard = {
    formId: form.id,
    elements: JSON.parse(JSON.stringify(elements)),
  };
  state.pasteCount = 0;
  toast('Скопировано элементов: ' + elements.length + '. Вставка — Ctrl+V', 'info');
}

function pasteElements() {
  const clip = state.clipboard;
  if (!clip || !Array.isArray(clip.elements) || !clip.elements.length) {
    toast('Буфер пуст. Выделите элементы и нажмите Ctrl+C.', 'error');
    return;
  }
  const form = currentForm();
  if (!form) return;
  state.pasteCount += 1;
  const added = cloneElementsInto(form, clip.elements, 20 * state.pasteCount);
  selectMany(form.id, added.map((copy) => copy.id));
  scheduleSave();
  toast('Вставлено элементов: ' + added.length, 'success');
}

function deleteSelectedElements() {
  const form = currentForm();
  const selected = selectedElements().filter((element) => element.type !== 'form');
  if (!form || !selected.length) {
    if (selectedElements().some((element) => element.type === 'form')) {
      toast('Это экран приложения. Удалить его можно вместе с формой во вкладке справа.', 'info');
    }
    return;
  }
  const elements = elementsWithChildren(form, selected);
  const message = elements.length === 1
    ? 'Удалить элемент «' + elements[0].name + '»?'
    : 'Удалить выделенные элементы (' + elements.length + ')?';
  if (!confirm(message)) return;
  const ids = new Set(elements.map((element) => element.id));
  form.elements = form.elements.filter((element) => !ids.has(element.id));
  selectForm(form.id);
  scheduleSave();
  toast('Элемент(ы) удалён(ы)', 'info');
}

/* =========================================================================
   Дерево форм
   ========================================================================= */

function bindTree() {
  $('#forms-tree').addEventListener('click', (event) => {
    const wrap = event.target.closest('.tree-form');
    if (!wrap) return;
    const formId = wrap.dataset.formId;

    const menuButton = event.target.closest('[data-act="menu"]');
    if (menuButton) {
      event.stopPropagation();
      const rect = menuButton.getBoundingClientRect();
      openFormMenu(formId, rect.left, rect.bottom + 4);
      return;
    }

    const chevron = event.target.closest('[data-act="toggle"]');
    if (chevron) {
      event.stopPropagation();
      if (state.expanded.has(formId)) state.expanded.delete(formId);
      else state.expanded.add(formId);
      renderTree();
      return;
    }

    const elementRow = event.target.closest('.tree-element');
    if (elementRow) {
      selectElement(formId, elementRow.dataset.elementId);
      return;
    }

    if (event.target.closest('.form-row')) openFormTab(formId);
  });
}

function treeElementRow(form, element, depth, selectedSet) {
  return `
    <div class="tree-element ${depth > 0 ? 'tree-child' : ''} ${selectedSet.has(element.id) ? 'selected' : ''}"
         data-element-id="${escapeAttr(element.id)}"
         style="padding-left:${10 + depth * 14}px">
      <span class="te-icon">${TYPE_ICONS[element.type] || '•'}</span>
      <span class="te-name">${escapeHtml(element.name)}</span>
      ${isContainerElement(element) ? '<span class="te-count">' + elementChildren(form, element.id).length + '</span>' : ''}
    </div>`;
}

function treeElementsHtml(form, parentId, depth, selectedSet) {
  return elementChildren(form, parentId)
    .map((element) => {
      const row = treeElementRow(form, element, depth, selectedSet);
      if (!isContainerElement(element)) return row;
      const nested = treeElementsHtml(form, element.id, depth + 1, selectedSet);
      return row + nested;
    })
    .join('');
}

function renderTree() {
  const tree = $('#forms-tree');
  if (!tree || !state.project) return;

  const selectedSet = new Set(selectedIds());
  tree.innerHTML = state.project.forms
    .map((form) => {
      const expanded = state.expanded.has(form.id);
      const isCurrent = form.id === state.currentFormId;
      const root = rootFormElement(form);
      const children = root
        ? treeElementsHtml(form, root.id, 1, selectedSet)
        : '';
      const content =
        (root ? treeElementRow(form, root, 0, selectedSet) : '') +
        (children || '<div class="tree-empty">Экран пуст — перетащите элемент внутрь формы</div>');

      return `
      <div class="tree-form ${isCurrent ? 'current' : ''}" data-form-id="${escapeAttr(form.id)}">
        <div class="tree-row form-row">
          <button class="chevron" data-act="toggle" title="Свернуть / развернуть">${expanded ? '▾' : '▸'}</button>
          <span class="form-title">${escapeHtml(form.name)}</span>
          ${form.id === state.project.start_form ? '<span class="badge-start">старт</span>' : ''}
          <button class="tree-menu-btn" data-act="menu" title="Действия с формой">⋯</button>
        </div>
        <div class="tree-elements" ${expanded ? '' : 'hidden'}>${content}</div>
      </div>`;
    })
    .join('');
}

function uniqueFormName(base) {
  const forms = state.project?.forms || [];
  let index = forms.length + 1;
  while (forms.some((form) => form.name === base + ' ' + index)) index += 1;
  return base + ' ' + index;
}

function addForm() {
  const form = newFormObject(uniqueFormName('Форма'));
  state.project.forms.push(form);
  state.openForms.push(form.id);
  state.expanded.add(form.id);
  selectForm(form.id);
  scheduleSave();
  toast('Форма «' + form.name + '» создана', 'success');
}

function renameForm(formId) {
  const form = findForm(formId);
  if (!form) return;
  const name = prompt('Название формы', form.name);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    toast('Название формы не может быть пустым', 'error');
    return;
  }
  form.name = trimmed.slice(0, 120);
  renderTree();
  renderFormTabs();
  renderProperties();
  updateCrumb();
  scheduleSave();
}

function deleteForm(formId) {
  if (state.project.forms.length <= 1) {
    toast('В проекте должна остаться хотя бы одна форма', 'error');
    return;
  }
  const form = findForm(formId);
  if (!form) return;
  if (!confirm('Удалить форму «' + form.name + '» вместе с её элементами?')) return;

  state.project.forms = state.project.forms.filter((item) => item.id !== formId);
  state.project.forms.forEach((item) => {
    item.elements.forEach((el) => {
      if (el.type === 'button' && el.targetForm === formId) el.targetForm = '';
    });
  });
  state.openForms = state.openForms.filter((id) => id !== formId);
  state.expanded.delete(formId);
  if (state.project.start_form === formId) state.project.start_form = state.project.forms[0].id;
  if (state.currentFormId === formId) state.currentFormId = state.project.forms[0].id;
  state.selected = { kind: 'form', formId: state.currentFormId };
  state.multi = [];
  if (!state.openForms.length) state.openForms = [state.currentFormId];
  renderAll();
  scheduleSave();
  toast('Форма удалена', 'info');
}

function setStartForm(formId) {
  if (!findForm(formId)) return;
  state.project.start_form = formId;
  renderTree();
  renderProperties();
  scheduleSave();
  toast('Стартовая форма обновлена', 'success');
}

/* =========================================================================
   Контекстное меню
   ========================================================================= */

function closeContextMenu() {
  $$('.context-menu').forEach((node) => node.remove());
}

function openContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    if (item.danger) button.classList.add('danger');
    button.addEventListener('click', () => {
      closeContextMenu();
      if (item.run) item.run();
    });
    menu.appendChild(button);
  });
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}

function openFormMenu(formId, x, y) {
  const form = findForm(formId);
  if (!form) return;
  const items = [
    { label: 'Переименовать', run: () => renameForm(formId) },
    { label: 'Добавить форму', run: addForm },
  ];
  if (formId !== state.project.start_form) {
    items.push({ label: 'Сделать стартовой', run: () => setStartForm(formId) });
  }
  if (state.project.forms.length > 1) {
    items.push({ label: 'Удалить форму', danger: true, run: () => deleteForm(formId) });
  }
  openContextMenu(x, y, items);
}

/* =========================================================================
   Холст
   ========================================================================= */

function bindCanvas() {
  const canvas = $('#canvas');
  if (!canvas) return;

  canvas.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    canvas.classList.add('drag-over');
  });
  canvas.addEventListener('dragleave', (event) => {
    if (event.target === canvas) canvas.classList.remove('drag-over');
  });
  canvas.addEventListener('drop', (event) => {
    event.preventDefault();
    canvas.classList.remove('drag-over');
    const raw =
      event.dataTransfer.getData('application/x-db2ui') ||
      event.dataTransfer.getData('text/plain');
    if (!raw) return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      return;
    }

    const form = currentForm();
    const root = rootFormElement(form);
    if (!form || !root) return;

    const bodyNode = event.target.closest('.container-body');
    const elementNode = bodyNode
      ? bodyNode.closest('.element[data-id]')
      : event.target.closest('.element[data-id]');
    const candidate = elementNode ? findElementById(form, elementNode.dataset.id) : root;
    const container = isContainerElement(candidate) ? candidate : root;
    const body = bodyNode || elementNode?.querySelector('.container-body') ||
      canvas.querySelector('.el-form > .container-body');
    if (!body) return;

    const rect = body.getBoundingClientRect();
    const x = event.clientX - rect.left - 20;
    const y = event.clientY - rect.top - 16;

    if (payload.kind === 'table') {
      const table = state.tables.find(
        (t) => t.schema === payload.schema && t.name === payload.table
      );
      if (!table) return;
      addElement('table', x, y, {
        parentId: container.id,
        table: tableRefOf(table),
        name: table.label,
      });
      return;
    }
    if (payload.kind === 'element' && TYPE_LABELS[payload.type] && payload.type !== 'form') {
      addElement(payload.type, x, y, { parentId: container.id });
    }
  });

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const form = currentForm();
    if (!form) return;
    const node = event.target.closest('.element');

    if (!node) {
      beginMarquee(event, form, canvas);
      return;
    }

    const element = findElementById(form, node.dataset.id);
    if (!element) return;
    event.preventDefault();

    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    let ids = selectedIds();

    if (additive) {
      if (ids.includes(element.id)) ids = ids.filter((id) => id !== element.id);
      else ids = ids.concat(element.id);
      if (!ids.length) selectForm(form.id);
      else selectMany(form.id, ids);
      return;
    }

    if (!ids.includes(element.id)) {
      ids = [element.id];
      selectMany(form.id, ids);
    }

    const currentIds = selectedIds();
    const parentId = element.parentId || '';
    const group = element.type === 'form'
      ? [element]
      : form.elements.filter(
          (item) =>
            currentIds.includes(item.id) &&
            (item.parentId || '') === parentId &&
            item.type !== 'form'
        );
    const elements = group.length ? group : [element];
    if (!elements.length) return;

    if (event.target.closest('.resize-handle')) {
      if (elements.length === 1) beginResize(event, form, element);
      else beginGroupResize(event, form, elements);
      return;
    }
    beginDrag(event, form, elements, element);
  });

  canvas.addEventListener('dblclick', (event) => {
    const form = currentForm();
    if (!form) return;
    const node = event.target.closest('.element');
    if (!node) return;
    const element = findElementById(form, node.dataset.id);
    if (!element) return;
    if (element.type === 'text' || element.type === 'button') {
      event.preventDefault();
      beginInlineEdit(node, element);
      return;
    }
    if (element.type === 'image') {
      event.preventDefault();
      pickImageForElement(element);
      return;
    }
  });
}

function beginMarquee(event, form, canvas) {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const startX = event.clientX - rect.left;
  const startY = event.clientY - rect.top;
  const box = document.createElement('div');
  box.className = 'marquee-box';
  canvas.appendChild(box);
  let moved = false;
  let bounds = { left: startX, top: startY, right: startX, bottom: startY };
  let finished = false;

  const onMove = (moveEvent) => {
    const x = moveEvent.clientX - rect.left;
    const y = moveEvent.clientY - rect.top;
    const left = Math.max(0, Math.min(startX, x));
    const top = Math.max(0, Math.min(startY, y));
    const right = Math.min(canvas.clientWidth, Math.max(startX, x));
    const bottom = Math.min(canvas.clientHeight, Math.max(startY, y));
    bounds = { left, top, right, bottom };
    if (Math.abs(x - startX) > 3 || Math.abs(y - startY) > 3) moved = true;
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.width = Math.max(0, right - left) + 'px';
    box.style.height = Math.max(0, bottom - top) + 'px';
  };

  const onUp = () => {
    if (finished) return;
    finished = true;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    box.remove();
    if (!moved) {
      selectForm(form.id);
      return;
    }
    const root = rootFormElement(form);
    const offsetX = root ? root.x : 0;
    const offsetY = root ? root.y : 0;
    const ids = topLevelElements(form)
      .filter((element) => {
        const left = element.x + offsetX;
        const top = element.y + offsetY;
        const right = left + element.w;
        const bottom = top + element.h;
        return right > bounds.left && left < bounds.right &&
          bottom > bounds.top && top < bounds.bottom;
      })
      .map((element) => element.id);
    if (ids.length) selectMany(form.id, ids);
    else selectForm(form.id);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function readImageFile(file, onDone) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    toast('Выберите файл изображения (PNG, JPEG, GIF, SVG, WebP).', 'error');
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    toast('Файл больше 2 МБ. Уменьшите изображение или укажите ссылку.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => onDone(String(reader.result || ''));
  reader.onerror = () => toast('Не удалось прочитать файл изображения', 'error');
  reader.readAsDataURL(file);
}

function pickImageForElement(element) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    readImageFile(file, (dataUrl) => {
      element.src = dataUrl;
      renderCanvas();
      renderProperties();
      scheduleSave();
      toast('Изображение добавлено в проект', 'success');
    });
  });
  input.click();
}

function beginInlineEdit(node, element) {
  const target = element.type === 'text'
    ? node.querySelector('.el-text')
    : node.querySelector('.el-button');
  if (!target) return;
  const original = target.textContent;
  let finished = false;
  target.setAttribute('contenteditable', 'true');
  target.classList.add('inline-edit');
  target.focus();
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }

  const finish = (save) => {
    if (finished) return;
    finished = true;
    target.removeAttribute('contenteditable');
    target.classList.remove('inline-edit');
    if (!save) {
      target.textContent = original;
      return;
    }
    const value = target.textContent.replace(/\s+/g, ' ').trim();
    element.text = (value || original).slice(0, 2000);
    renderCanvas();
    renderProperties();
    scheduleSave();
  };

  target.addEventListener('blur', () => finish(true), { once: true });
  target.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      target.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finished = true;
      target.textContent = original;
      target.removeAttribute('contenteditable');
      target.classList.remove('inline-edit');
      target.blur();
    }
  });
}

function setGeometry(node, element) {
  if (!node) return;
  node.style.left = element.x + 'px';
  node.style.top = element.y + 'px';
  node.style.width = element.w + 'px';
  node.style.height = element.h + 'px';
}

function updateGeometryFields(element) {
  const panel = $('#properties');
  if (!panel || !element) return;
  const values = {
    x: Math.round(element.x),
    y: Math.round(element.y),
    w: Math.round(element.w),
    h: Math.round(element.h),
  };
  Object.entries(values).forEach(([prop, value]) => {
    const field = panel.querySelector('[data-prop="' + prop + '"]');
    if (field && document.activeElement !== field) field.value = value;
  });
}

function renderCanvas() {
  const canvas = $('#canvas');
  if (!canvas || !state.project) return;
  const form = currentForm();
  applyFormSurfaceStyles(form);

  if (!form) {
    canvas.innerHTML = '';
    return;
  }

  const root = rootFormElement(form);
  if (!root) {
    canvas.innerHTML =
      '<div class="canvas-empty"><div><b>В этой форме нет экрана</b>' +
      'Создайте форму заново или добавьте экран через свойства формы.</div></div>';
    updateSelectionClasses();
    return;
  }

  const selectedSet = new Set(selectedIds());
  const visited = new Set([form.id, root.id]);
  canvas.innerHTML = elementWrapperHtml(root, form, 'editor', 0, visited, selectedSet);
  updateSelectionClasses();
  updateFormSizeLabel(form);
  renderGapBadges();

  requestAnimationFrame(() => {
    hydrateTables(canvas, 'editor');
    hydrateSelects(canvas);
    hydrateSql(canvas, 'editor');
  });
}

function elementsMarkup(form, mode, parentId, depth, visited, selectedSet) {
  return elementChildren(form, parentId)
    .filter((element) => !visited.has(element.id))
    .map((element) => elementWrapperHtml(element, form, mode, depth, visited, selectedSet))
    .join('');
}

function elementWrapperHtml(element, form, mode, depth, visited, selectedSet) {
  const isEditor = mode === 'editor';
  const parent = parentElementOf(form, element);
  const classes = [isEditor ? 'element' : 'preview-element'];
  if (depth > 0) classes.push('nested');
  if (isContainerElement(element)) classes.push('container-el');
  if (element.type === 'form') classes.push('root-form');
  if (isEditor && selectedSet && selectedSet.has(element.id)) classes.push('selected');

  const badge = isEditor
    ? '<span class="el-badge">' + escapeHtml(element.name) + '</span>'
    : '';
  const handle = isEditor
    ? '<span class="resize-handle" title="Изменить размер. Дочерние элементы масштабируются вместе с контейнером"></span>'
    : '';
  const nextVisited = new Set(visited);
  nextVisited.add(element.id);

  return (
    '<div class="' + classes.join(' ') + '" data-id="' + escapeAttr(element.id) + '"' +
    ' data-form-id="' + escapeAttr(form.id) + '"' +
    (parent ? ' data-parent-id="' + escapeAttr(parent.id) + '"' : '') +
    ' style="' + elementGeometryStyle(element) + '">' +
    badge +
    elementInner(element, mode, depth, nextVisited, form) +
    handle +
    '</div>'
  );
}

function hydrateTables(root, mode, force = false) {
  $$('.el-table-body', root).forEach((body) => {
    const wrapper = body.closest('[data-id]');
    if (!wrapper) return;
    const element = findElementAnywhere(wrapper.dataset.id);
    if (element && element.type === 'table') loadTableBody(element, body, mode, force);
  });
}

function preferredLabelColumn(table) {
  if (!table) return '';
  const textTypes = new Set(['text', 'varchar', 'bpchar', 'char', 'citext']);
  const preferred = table.columns.find(
    (column) => !column.is_pk && textTypes.has(column.udt_name)
  );
  const fallback = table.columns.find((column) => !column.is_pk);
  return (preferred || fallback || table.columns[0] || {}).name || '';
}

function labelColumnFor(element, table) {
  if (!table) return '';
  if (element.labelColumn && table.columns.some((column) => column.name === element.labelColumn)) {
    return element.labelColumn;
  }
  return preferredLabelColumn(table);
}

async function fillSelectControl(node, element) {
  if (!node) return;
  const placeholder = element.placeholder || '— выберите —';
  const table = tableFromValue(element.table);
  if (!table) {
    node.innerHTML = '<option value="">Сначала выберите таблицу в свойствах</option>';
    return;
  }
  if (!element.column) {
    node.innerHTML = '<option value="">Сначала выберите колонку в свойствах</option>';
    return;
  }

  const token = String(Math.random());
  node.dataset.token = token;
  node.innerHTML = '<option value="">Загрузка…</option>';

  try {
    const column = table.columns.find((item) => item.name === element.column);
    const options = [];
    let seen = new Set();

    if (column?.references) {
      const ref = column.references;
      const refTable = state.tables.find(
        (item) => item.schema === ref.ref_schema && item.name === ref.ref_table
      );
      if (!refTable) throw new Error('Связанная таблица не найдена. Обновите схему.');
      const data = await fetchRows(refTable, 500, false);
      const labelColumn = labelColumnFor(element, refTable);
      (data.rows || []).forEach((row) => {
        const value = row[ref.ref_column];
        if (value == null) return;
        const key = String(value);
        if (seen.has(key)) return;
        seen.add(key);
        const label = labelColumn ? row[labelColumn] : value;
        options.push({ value, label: label == null ? value : label });
      });
    } else {
      const data = await fetchRows(table, 500, false);
      (data.rows || []).forEach((row) => {
        const value = row[element.column];
        if (value == null) return;
        const key = String(value);
        if (seen.has(key)) return;
        seen.add(key);
        options.push({ value, label: value });
      });
    }

    if (!node.isConnected || node.dataset.token !== token) return;
    const previous = node.value;
    node.innerHTML =
      '<option value="">' + escapeHtml(placeholder) + '</option>' +
      options
        .map(
          (option) =>
            '<option value="' + escapeAttr(option.value) + '">' +
            escapeHtml(option.label) + '</option>'
        )
        .join('');
    if (previous && options.some((option) => String(option.value) === String(previous))) {
      node.value = previous;
    }
  } catch (error) {
    if (node.isConnected && node.dataset.token === token) {
      node.innerHTML = '<option value="">Ошибка: ' + escapeHtml(error.message) + '</option>';
    }
  }
}

function hydrateSelects(root) {
  $$('.el-select-control', root).forEach((node) => {
    const wrapper = node.closest('[data-id]');
    if (!wrapper) return;
    const element = findElementAnywhere(wrapper.dataset.id);
    if (element && element.type === 'select') fillSelectControl(node, element);
  });
}

function hydrateSql(root, mode, force = false) {
  $$('.el-sql-body', root).forEach((body) => {
    const wrapper = body.closest('[data-id]');
    if (!wrapper) return;
    const element = findElementAnywhere(wrapper.dataset.id);
    if (element && element.type === 'sql') loadSqlBody(element, body, mode, force);
  });
}

async function loadSqlBody(element, body, mode, force = false) {
  if (!body) return;
  const query = String(element.query || '').trim();
  if (!query) {
    body.innerHTML = '<div class="table-empty">Укажите SQL-запрос в свойствах справа.</div>';
    return;
  }

  const limit = clamp(Math.round(num(element.limit, 100)), 1, 500);
  const key = JSON.stringify([query, limit]);
  const cached = sqlCache.get(key);
  if (!force && cached && Date.now() - cached.time < CACHE_TTL) {
    renderSqlInto(body, cached.data);
    return;
  }

  const token = String(Math.random());
  body.dataset.token = token;
  body.innerHTML = '<div class="table-loading">Выполнение запроса…</div>';
  try {
    const data = await api('/api/sql/query', {
      method: 'POST',
      body: JSON.stringify({ sql: query, limit }),
    });
    if (!body.isConnected || body.dataset.token !== token) return;
    sqlCache.set(key, { time: Date.now(), data });
    renderSqlInto(body, data);
  } catch (error) {
    if (!body.isConnected || body.dataset.token !== token) return;
    body.innerHTML = '<div class="table-error">' + escapeHtml(error.message) + '</div>';
  }
}

function renderSqlInto(body, data) {
  const rows = data.rows || [];
  const columns = data.columns || [];
  if (!rows.length) {
    body.innerHTML = '<div class="table-empty">Запрос не вернул строк.</div>';
    body._rows = [];
    return;
  }
  let html = '<table class="data-table"><thead><tr>';
  columns.forEach((column) => {
    html += '<th>' + escapeHtml(column) + '</th>';
  });
  html += '</tr></thead><tbody>';
  rows.forEach((row) => {
    html += '<tr>';
    columns.forEach((column) => {
      html += '<td>' + formatCell(row[column]) + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  body.innerHTML = html;
  body._rows = rows;
}

/* =========================================================================
   Примагничивание и выравнивание
   ========================================================================= */

function collectSnapTargets(form, exclude, parentId) {
  const xs = [];
  const ys = [];
  const parent = parentId ? findElementById(form, parentId) : null;
  const content = parent ? containerContentSize(parent) : { w: form.width, h: form.height };
  elementChildren(form, parentId).forEach((element) => {
    if (exclude.has(element.id)) return;
    xs.push({ pos: element.x }, { pos: element.x + element.w / 2 }, { pos: element.x + element.w });
    ys.push({ pos: element.y }, { pos: element.y + element.h / 2 }, { pos: element.y + element.h });
  });
  xs.push({ pos: content.w / 2 });
  ys.push({ pos: content.h / 2 });
  return { xs, ys };
}

function guideOffset(parentId) {
  const canvas = $('#canvas');
  if (!parentId) {
    const root = rootFormElement(currentForm());
    return { x: root ? root.x : 0, y: root ? root.y : 0 };
  }
  const body = canvas?.querySelector('.element[data-id="' + parentId + '"] > .el-form > .container-body, ' +
        '.element[data-id="' + parentId + '"] > .el-panel > .container-body');
  if (!canvas || !body) return { x: 0, y: 0 };
  const canvasRect = canvas.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  return { x: bodyRect.left - canvasRect.left, y: bodyRect.top - canvasRect.top };
}

function updateContainerNode(node, element) {
  if (!node || !isContainerElement(element)) return;
  const body = node.querySelector('.container-body');
  if (body) body.style.cssText = containerBodyStyle(element);
}

function snapAxis(start, size, targets, grid, useSnap, threshold) {
  if (!useSnap) return { value: start, guide: null };
  const edges = [
    { value: start, offset: 0 },
    { value: start + size / 2, offset: size / 2 },
    { value: start + size, offset: size },
  ];
  let best = null;
  targets.forEach((target) => {
    edges.forEach((edge) => {
      const delta = target.pos - edge.value;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, pos: target.pos };
      }
    });
  });
  if (best) return { value: start + best.delta, guide: best.pos };
  return { value: Math.round(start / grid) * grid, guide: null };
}

function matchEdge(value, targets, threshold) {
  let best = null;
  targets.forEach((target) => {
    const delta = target.pos - value;
    if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
      best = { delta, pos: target.pos };
    }
  });
  return best ? best.pos : null;
}

function clearGuides() {
  $$('#canvas .snap-guide').forEach((node) => node.remove());
}

function showGuides(guides) {
  clearGuides();
  const canvas = $('#canvas');
  if (!canvas) return;
  guides.forEach((guide) => {
    if (guide == null) return;
    const line = document.createElement('div');
    line.className = 'snap-guide vertical';
    line.style.left = guide + 'px';
    canvas.appendChild(line);
  });
}

function showGuidesXy(guideX, guideY) {
  clearGuides();
  const canvas = $('#canvas');
  if (!canvas) return;
  if (guideX != null) {
    const vertical = document.createElement('div');
    vertical.className = 'snap-guide vertical';
    vertical.style.left = guideX + 'px';
    canvas.appendChild(vertical);
  }
  if (guideY != null) {
    const horizontal = document.createElement('div');
    horizontal.className = 'snap-guide horizontal';
    horizontal.style.top = guideY + 'px';
    canvas.appendChild(horizontal);
  }
}

function beginDrag(event, form, elements, primary) {
  const startX = event.clientX;
  const startY = event.clientY;
  const origins = new Map(elements.map((element) => [element.id, { x: element.x, y: element.y }]));
  const primaryOrigin = origins.get(primary.id);
  if (!primaryOrigin) return;

  const parentId = primary.parentId || '';
  const parent = parentId ? findElementById(form, parentId) : null;
  const content = parent ? containerContentSize(parent) : { w: 4000, h: 4000 };
  const offset = guideOffset(parentId);

  const nodes = new Map();
  elements.forEach((element) => {
    const node = $('#canvas .element[data-id="' + element.id + '"]');
    if (node) nodes.set(element.id, node);
  });

  let moved = false;
  const exclude = new Set(elements.map((element) => element.id));
  const grid = gridSize();
  const isFormDrag = primary.type === 'form';
  const useSnap = isFormDrag ? false : snapEnabled();

  const onMove = (moveEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;

    const targets = isFormDrag
      ? { xs: [], ys: [] }
      : collectSnapTargets(form, exclude, parentId);
    const nextX = snapAxis(primaryOrigin.x + dx, primary.w, targets.xs, grid, useSnap, SNAP_THRESHOLD);
    const nextY = snapAxis(primaryOrigin.y + dy, primary.h, targets.ys, grid, useSnap, SNAP_THRESHOLD);
    const deltaX = nextX.value - primaryOrigin.x;
    const deltaY = nextY.value - primaryOrigin.y;

    elements.forEach((element) => {
      const origin = origins.get(element.id);
      element.x = clamp(
        Math.round(origin.x + deltaX),
        0,
        Math.max(0, content.w - element.w)
      );
      element.y = clamp(
        Math.round(origin.y + deltaY),
        0,
        Math.max(0, content.h - element.h)
      );
      setGeometry(nodes.get(element.id), element);
    });

    showGuidesXy(
      nextX.guide == null ? null : nextX.guide + offset.x,
      nextY.guide == null ? null : nextY.guide + offset.y
    );
    updateGeometryFields(primary);
    renderGapBadges();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    clearGuides();
    if (moved) {
      renderProperties();
      renderCanvas();
      scheduleSave();
    }
  };

  document.body.style.cursor = 'move';
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function beginResize(event, form, element) {
  const startX = event.clientX;
  const startY = event.clientY;
  const originW = element.w;
  const originH = element.h;
  const node = $('#canvas .element[data-id="' + element.id + '"]');
  const minimums = {
    form: [FORM_MIN_WIDTH, FORM_MIN_HEIGHT],
    text: [60, 24],
    button: [80, 32],
    input: [150, 48],
    select: [150, 48],
    image: [60, 40],
    table: [320, 180],
    panel: [180, 120],
    sql: [320, 180],
  };
  const [minW, minH] = minimums[element.type] || [60, 24];
  const isRoot = element.type === 'form';
  const parentId = isRoot ? '' : element.parentId || '';
  const parent = parentId ? findElementById(form, parentId) : null;
  const parentContent = parent ? containerContentSize(parent) : null;
  const maxW = isRoot
    ? FORM_MAX_SIZE
    : Math.max(minW, (parentContent?.w || 20) - element.x);
  const maxH = isRoot
    ? FORM_MAX_SIZE
    : Math.max(minH, (parentContent?.h || 20) - element.y);
  const oldContent = containerContentSize(element, originW, originH);
  const snapshot = isContainerElement(element) ? snapshotSubtree(form, element) : null;
  const descendantNodes = new Map();
  if (node) {
    node.querySelectorAll('.element[data-id]').forEach((childNode) => {
      descendantNodes.set(childNode.dataset.id, childNode);
    });
  }
  const offset = guideOffset(parentId);
  const exclude = new Set([element.id]);
  const grid = gridSize();
  const useSnap = isRoot ? false : snapEnabled();
  let moved = false;

  const onMove = (moveEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;

    const targets = collectSnapTargets(form, exclude, parentId);
    let width = originW + dx;
    let height = originH + dy;
    let guideX = null;
    let guideY = null;

    if (useSnap) {
      guideX = matchEdge(element.x + width, targets.xs, SNAP_THRESHOLD);
      guideY = matchEdge(element.y + height, targets.ys, SNAP_THRESHOLD);
      if (guideX != null) width = guideX - element.x;
      else width = Math.round(width / grid) * grid;
      if (guideY != null) height = guideY - element.y;
      else height = Math.round(height / grid) * grid;
    }

    element.w = clamp(Math.round(width), minW, maxW);
    element.h = clamp(Math.round(height), minH, maxH);

    if (snapshot) {
      const nextContent = containerContentSize(element, element.w, element.h);
      scaleSubtreeGeometry(
        form,
        element,
        snapshot,
        nextContent.w / Math.max(1, oldContent.w),
        nextContent.h / Math.max(1, oldContent.h)
      );
      descendantsOf(form, element.id).forEach((child) => {
        const childNode = descendantNodes.get(child.id);
        if (!childNode) return;
        setGeometry(childNode, child);
        if (isContainerElement(child)) updateContainerNode(childNode, child);
      });
    }

    setGeometry(node, element);
    updateContainerNode(node, element);
    updateGeometryFields(element);
    showGuidesXy(
      guideX == null ? null : guideX + offset.x,
      guideY == null ? null : guideY + offset.y
    );
    renderGapBadges();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    clearGuides();
    if (moved) {
      if (element.type === 'form') {
        form.width = Math.round(element.w);
        form.height = Math.round(element.h);
      }
      renderCanvas();
      renderProperties();
      scheduleSave();
    }
  };

  document.body.style.cursor = 'nwse-resize';
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function beginGroupResize(event, form, elements) {
  const startX = event.clientX;
  const startY = event.clientY;
  const left = Math.min(...elements.map((element) => element.x));
  const top = Math.min(...elements.map((element) => element.y));
  const right = Math.max(...elements.map((element) => element.x + element.w));
  const bottom = Math.max(...elements.map((element) => element.y + element.h));
  const originW = Math.max(40, right - left);
  const originH = Math.max(24, bottom - top);
  const origins = new Map(
    elements.map((element) => [
      element.id,
      { x: element.x, y: element.y, w: element.w, h: element.h },
    ])
  );
  const parentId = elements[0]?.parentId || '';
  const parent = parentId ? findElementById(form, parentId) : null;
  const content = parent ? containerContentSize(parent) : { w: form.width, h: form.height };
  const containerSnapshots = new Map();
  elements.forEach((element) => {
    if (isContainerElement(element)) {
      containerSnapshots.set(element.id, snapshotSubtree(form, element));
    }
  });
  const nodes = new Map();
  const descendants = new Map();
  elements.forEach((element) => {
    const node = $('#canvas .element[data-id="' + element.id + '"]');
    if (!node) return;
    nodes.set(element.id, node);
    node.querySelectorAll('.element[data-id]').forEach((childNode) => {
      descendants.set(childNode.dataset.id, childNode);
    });
  });
  let moved = false;

  const onMove = (moveEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;

    const width = clamp(originW + dx, 40, Math.max(40, content.w - left));
    const height = clamp(originH + dy, 24, Math.max(24, content.h - top));
    const scaleX = width / originW;
    const scaleY = height / originH;

    elements.forEach((element) => {
      const origin = origins.get(element.id);
      if (!origin) return;
      element.x = clamp(
        Math.round(left + (origin.x - left) * scaleX),
        0,
        Math.max(0, content.w - 20)
      );
      element.y = clamp(
        Math.round(top + (origin.y - top) * scaleY),
        0,
        Math.max(0, content.h - 20)
      );
      element.w = clamp(
        Math.round(origin.w * scaleX),
        20,
        Math.max(20, content.w - element.x)
      );
      element.h = clamp(
        Math.round(origin.h * scaleY),
        20,
        Math.max(20, content.h - element.y)
      );
      setGeometry(nodes.get(element.id), element);
      updateContainerNode(nodes.get(element.id), element);

      const snapshot = containerSnapshots.get(element.id);
      if (snapshot) {
        scaleSubtreeGeometry(form, element, snapshot, scaleX, scaleY);
      }
    });

    descendants.forEach((childNode, id) => {
      const child = findElementById(form, id);
      if (!child) return;
      setGeometry(childNode, child);
      if (isContainerElement(child)) updateContainerNode(childNode, child);
    });

    updateGeometryFields(elements[0]);
    renderGapBadges();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    clearGuides();
    if (moved) {
      renderCanvas();
      renderProperties();
      scheduleSave();
    }
  };

  document.body.style.cursor = 'nwse-resize';
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function groupSelectionByParent(elements) {
  const groups = new Map();
  elements.forEach((element) => {
    const key = element.parentId || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(element);
  });
  return groups;
}

function parentContentSize(form, parentId) {
  const parent = parentId ? findElementById(form, parentId) : null;
  return parent ? containerContentSize(parent) : { w: form.width, h: form.height };
}

function alignSelection(mode) {
  const form = currentForm();
  const elements = selectedElements().filter((element) => element.type !== 'form');
  if (!form || !elements.length) return;
  const groups = groupSelectionByParent(elements);
  if ((mode === 'distribute-h' || mode === 'distribute-v') && elements.length < 3) {
    toast('Для распределения выделите минимум три элемента (Ctrl+клик).', 'error');
    return;
  }
  const grid = gridSize();

  groups.forEach((group, parentId) => {
    const content = parentContentSize(form, parentId);

    if (mode === 'grid') {
      group.forEach((element) => {
        element.x = clamp(Math.round(element.x / grid) * grid, 0, Math.max(0, content.w - element.w));
        element.y = clamp(Math.round(element.y / grid) * grid, 0, Math.max(0, content.h - element.h));
      });
    } else if (mode === 'distribute-h' || mode === 'distribute-v') {
      if (group.length < 3) return;
      const horizontal = mode === 'distribute-h';
      const sorted = group.slice().sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const start = horizontal ? first.x : first.y;
      const end = horizontal ? last.x + last.w : last.y + last.h;
      const total = sorted.reduce((sum, element) => sum + (horizontal ? element.w : element.h), 0);
      const gap = (end - start - total) / (sorted.length - 1);
      if (gap < 0) return;
      let cursor = start;
      sorted.forEach((element) => {
        if (horizontal) element.x = Math.round(cursor);
        else element.y = Math.round(cursor);
        cursor += (horizontal ? element.w : element.h) + gap;
      });
      state.gapAxis = horizontal ? 'h' : 'v';
    } else {
      const single = group.length === 1;
      const left = single ? 0 : Math.min(...group.map((element) => element.x));
      const right = single ? content.w : Math.max(...group.map((element) => element.x + element.w));
      const top = single ? 0 : Math.min(...group.map((element) => element.y));
      const bottom = single ? content.h : Math.max(...group.map((element) => element.y + element.h));
      group.forEach((element) => {
        if (mode === 'left') element.x = left;
        else if (mode === 'right') element.x = right - element.w;
        else if (mode === 'center-h') element.x = Math.round((left + right) / 2 - element.w / 2);
        else if (mode === 'top') element.y = top;
        else if (mode === 'bottom') element.y = bottom - element.h;
        else if (mode === 'middle-v') element.y = Math.round((top + bottom) / 2 - element.h / 2);
      });
    }

    group.forEach((element) => {
      element.x = clamp(element.x, 0, Math.max(0, content.w - element.w));
      element.y = clamp(element.y, 0, Math.max(0, content.h - element.h));
    });
  });

  renderCanvas();
  renderProperties();
  scheduleSave();
}

function applyEqualGap(axis) {
  const form = currentForm();
  const elements = selectedElements().filter((element) => element.type !== 'form');
  if (!form || elements.length < 2) {
    toast('Выделите минимум два элемента (Ctrl+клик), чтобы задать отступ.', 'error');
    return;
  }
  const parentIds = new Set(elements.map((element) => element.parentId || ''));
  if (parentIds.size > 1) {
    toast('Элементы должны находиться в одном контейнере (форме или панели).', 'error');
    return;
  }
  const content = parentContentSize(form, elements[0].parentId || '');
  const input = $('#gap-input');
  const gap = clamp(Math.round(num(input ? input.value : 16, 16)), 0, 400);
  const horizontal = axis !== 'v';
  const sorted = elements.slice().sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const start = horizontal ? sorted[0].x : sorted[0].y;
  let cursor = start;
  const limit = horizontal ? content.w : content.h;
  let overflow = false;
  const positions = [];
  sorted.forEach((element) => {
    positions.push({ element, value: Math.round(cursor) });
    cursor += (horizontal ? element.w : element.h) + gap;
    if (cursor - gap > limit) overflow = true;
  });
  if (overflow) {
    toast('Элементы с отступом ' + gap + ' px не помещаются в контейнере. Уменьшите отступ.', 'error');
    return;
  }
  positions.forEach(({ element, value }) => {
    if (horizontal) element.x = value;
    else element.y = value;
  });
  state.gapAxis = horizontal ? 'h' : 'v';
  renderCanvas();
  renderProperties();
  scheduleSave();
  toast('Отступ между элементами: ' + gap + ' px', 'success');
}

function overlapRange(startA, sizeA, startB, sizeB) {
  const start = Math.max(startA, startB);
  const end = Math.min(startA + sizeA, startB + sizeB);
  return { start, end, size: end - start };
}

function collectInnerMeasurements(group) {
  const items = [];

  group.forEach((first) => {
    group.forEach((second) => {
      if (first === second) return;

      // Вертикальный промежуток: second ниже first, проекции пересекаются.
      if (first.y + first.h <= second.y) {
        const overlap = overlapRange(first.x, first.w, second.x, second.w);
        if (overlap.size > 1) {
          const blocked = group.some(
            (other) =>
              other !== first &&
              other !== second &&
              other.y + other.h > first.y + first.h &&
              other.y < second.y &&
              overlapRange(other.x, other.w, overlap.start, overlap.size).size > 1
          );
          if (!blocked) {
            items.push({
              axis: 'v',
              cross: overlap.start + overlap.size / 2,
              from: first.y + first.h,
              to: second.y,
              gap: second.y - (first.y + first.h),
            });
          }
        }
      }

      // Горизонтальный промежуток: second правее first, проекции пересекаются.
      if (first.x + first.w <= second.x) {
        const overlap = overlapRange(first.y, first.h, second.y, second.h);
        if (overlap.size > 1) {
          const blocked = group.some(
            (other) =>
              other !== first &&
              other !== second &&
              other.x + other.w > first.x + first.w &&
              other.x < second.x &&
              overlapRange(other.y, other.h, overlap.start, overlap.size).size > 1
          );
          if (!blocked) {
            items.push({
              axis: 'h',
              cross: overlap.start + overlap.size / 2,
              from: first.x + first.w,
              to: second.x,
              gap: second.x - (first.x + first.w),
            });
          }
        }
      }
    });
  });

  return items;
}

function collectNeighborMeasurements(element, siblings) {
  const items = [];
  let left = null;
  let right = null;
  let up = null;
  let down = null;

  siblings.forEach((other) => {
    if (other.id === element.id) return;
    const yOverlap = overlapRange(element.y, element.h, other.y, other.h);
    const xOverlap = overlapRange(element.x, element.w, other.x, other.w);

    if (yOverlap.size > 1) {
      const otherRight = other.x + other.w;
      if (otherRight <= element.x) {
        const gap = element.x - otherRight;
        if (!left || otherRight > left.edge) {
          left = { edge: otherRight, gap, overlap: yOverlap };
        }
      }
      if (other.x >= element.x + element.w) {
        const gap = other.x - (element.x + element.w);
        if (!right || other.x < right.edge) {
          right = { edge: other.x, gap, overlap: yOverlap };
        }
      }
    }

    if (xOverlap.size > 1) {
      const otherBottom = other.y + other.h;
      if (otherBottom <= element.y) {
        const gap = element.y - otherBottom;
        if (!up || otherBottom > up.edge) {
          up = { edge: otherBottom, gap, overlap: xOverlap };
        }
      }
      if (other.y >= element.y + element.h) {
        const gap = other.y - (element.y + element.h);
        if (!down || other.y < down.edge) {
          down = { edge: other.y, gap, overlap: xOverlap };
        }
      }
    }
  });

  if (left) {
    items.push({
      axis: 'h',
      cross: left.overlap.start + left.overlap.size / 2,
      from: left.edge,
      to: element.x,
      gap: left.gap,
    });
  }
  if (right) {
    items.push({
      axis: 'h',
      cross: right.overlap.start + right.overlap.size / 2,
      from: element.x + element.w,
      to: right.edge,
      gap: right.gap,
    });
  }
  if (up) {
    items.push({
      axis: 'v',
      cross: up.overlap.start + up.overlap.size / 2,
      from: up.edge,
      to: element.y,
      gap: up.gap,
    });
  }
  if (down) {
    items.push({
      axis: 'v',
      cross: down.overlap.start + down.overlap.size / 2,
      from: element.y + element.h,
      to: down.edge,
      gap: down.gap,
    });
  }

  return items;
}

function measurementOffset(parentId) {
  if (!parentId) {
    const root = rootFormElement(currentForm());
    return { x: root ? root.x : 0, y: root ? root.y : 0 };
  }
  return guideOffset(parentId);
}

function measurementMarkup(items, offset) {
  return items
    .filter((item) => item.to >= item.from)
    .map((item) => {
      const label = String(Math.max(0, Math.round(item.gap)));
      if (item.axis === 'v') {
        const x = Math.round(item.cross + offset.x);
        const y = Math.round(item.from + offset.y);
        const height = Math.max(0, Math.round(item.to - item.from));
        const middle = y + height / 2;
        return (
          '<div class="measure-line vertical" style="left:' + x + 'px;top:' + y +
          'px;height:' + height + 'px"></div>' +
          '<div class="measure-label" style="left:' + x + 'px;top:' + middle + 'px">' +
          label + '</div>'
        );
      }
      const x = Math.round(item.from + offset.x);
      const y = Math.round(item.cross + offset.y);
      const width = Math.max(0, Math.round(item.to - item.from));
      const middle = x + width / 2;
      return (
        '<div class="measure-line horizontal" style="left:' + x + 'px;top:' + y +
        'px;width:' + width + 'px"></div>' +
        '<div class="measure-label" style="left:' + middle + 'px;top:' + y + 'px">' +
        label + '</div>'
      );
    })
    .join('');
}

function renderGapBadges() {
  const canvas = $('#canvas');
  if (!canvas) return;
  let layer = canvas.querySelector('.measure-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'measure-layer';
    canvas.appendChild(layer);
  }
  layer.innerHTML = '';

  const form = currentForm();
  if (!form) return;
  const elements = selectedElements().filter((element) => element.type !== 'form');
  if (!elements.length) return;

  const selectedSet = new Set(elements.map((element) => element.id));
  const groups = groupSelectionByParent(elements);
  let html = '';

  groups.forEach((group, parentId) => {
    const offset = measurementOffset(parentId);
    if (group.length === 1) {
      const siblings = elementChildren(form, parentId).filter(
        (element) => !selectedSet.has(element.id)
      );
      html += measurementMarkup(collectNeighborMeasurements(group[0], siblings), offset);
    } else {
      html += measurementMarkup(collectInnerMeasurements(group), offset);
    }
  });

  layer.innerHTML = html;
}

/* =========================================================================
   Отрисовка элементов
   ========================================================================= */

function elementInner(element, mode, depth = 0, visited = new Set(), form = null) {
  if (element.type === 'text') {
    return (
      '<div class="el-text" style="' +
      'font-size:' + num(element.fontSize, 20) + 'px;' +
      'font-weight:' + escapeAttr(element.fontWeight || '700') + ';' +
      'color:' + escapeAttr(element.color || '#172033') + ';' +
      'text-align:' + escapeAttr(element.align || 'left') + ';' +
      '">' + escapeHtml(element.text || '') + '</div>'
    );
  }

  if (element.type === 'button') {
    return (
      '<button type="button" class="el-button" tabindex="-1" style="' +
      'background:' + escapeAttr(element.color || '#4f46e5') + ';' +
      'color:' + escapeAttr(element.textColor || '#ffffff') + ';' +
      'font-size:' + num(element.fontSize, 14) + 'px;' +
      '">' + escapeHtml(element.text || 'Кнопка') + '</button>'
    );
  }

  if (element.type === 'input') {
    const label = element.label
      ? '<label>' + escapeHtml(element.label) + (element.required ? ' <em style="color:#dc2626;font-style:normal">*</em>' : '') + '</label>'
      : '';
    return (
      '<div class="el-input">' +
      label +
      '<input class="el-input-control" type="' + escapeAttr(element.inputType || 'text') + '"' +
      ' placeholder="' + escapeAttr(element.placeholder || '') + '"' +
      ' value=""' + (mode === 'preview' ? '' : ' readonly tabindex="-1"') + '>' +
      '</div>'
    );
  }

  if (element.type === 'select') {
    const label = element.label
      ? '<label>' + escapeHtml(element.label) + (element.required ? ' <em style="color:#dc2626;font-style:normal">*</em>' : '') + '</label>'
      : '';
    return (
      '<div class="el-input el-select">' +
      label +
      '<select class="el-input-control el-select-control" data-element-select="' + escapeAttr(element.id) + '"' +
      (mode === 'preview' ? '' : ' disabled tabindex="-1"') + '>' +
      '<option value="">' + escapeHtml(element.placeholder || '— выберите —') + '</option>' +
      '</select>' +
      '</div>'
    );
  }

  if (element.type === 'image') {
    if (element.src) {
      return (
        '<img class="el-image" src="' + escapeAttr(element.src) + '" alt="' + escapeAttr(element.alt || '') + '"' +
        ' draggable="false" style="object-fit:' + escapeAttr(element.fit || 'contain') + ';' +
        'border-radius:' + num(element.radius, 0) + 'px">'
      );
    }
    return (
      '<div class="el-image-empty">🖼<span>Двойной клик, чтобы выбрать изображение</span></div>'
    );
  }

  if (element.type === 'table') {
    const table = tableFromValue(element.table);
    const subtitle = table ? table.label : '⚠ таблица не выбрана';
    let actions = '';
    if (mode === 'preview') {
      const canAdd = table && element.editable !== false && element.allowAdd !== false;
      actions =
        (canAdd ? '<button type="button" class="mini-btn primary" data-act="add">＋ Добавить</button>' : '') +
        '<button type="button" class="mini-btn" data-act="reload" title="Обновить данные">↻</button>';
    } else if (table) {
      actions = '<span class="mini-btn">' + table.columns.length + ' кол.</span>';
    }
    return (
      '<div class="el-table">' +
      '<div class="el-table-head">' +
      '<div class="el-table-title"><b>' + escapeHtml(element.name || 'Таблица') + '</b>' +
      '<small>' + escapeHtml(subtitle) + '</small></div>' +
      '<div class="el-table-actions">' + actions + '</div>' +
      '</div>' +
      '<div class="el-table-body"><div class="table-loading">Загрузка данных…</div></div>' +
      '</div>'
    );
  }

  if (element.type === 'sql') {
    const subtitle = 'SQL-запрос · до ' + clamp(Math.round(num(element.limit, 100)), 1, 500) + ' строк';
    const actions = mode === 'preview'
      ? '<button type="button" class="mini-btn" data-act="sql-run" title="Выполнить запрос заново">↻</button>'
      : '';
    return (
      '<div class="el-table el-sql" title="' + escapeAttr(element.query || '') + '">' +
      '<div class="el-table-head">' +
      '<div class="el-table-title"><b>' + escapeHtml(element.name || 'SQL-запрос') + '</b>' +
      '<small>' + escapeHtml(subtitle) + '</small></div>' +
      '<div class="el-table-actions">' + actions + '</div>' +
      '</div>' +
      '<div class="el-table-body el-sql-body"><div class="table-loading">Выполнение запроса…</div></div>' +
      '</div>'
    );
  }

  if (element.type === 'form') {
    return formInner(element, form, mode, depth, visited);
  }

  if (element.type === 'panel') {
    return panelInner(element, form, mode, depth, visited);
  }

  return '<div class="el-text">Неизвестный элемент</div>';
}

function containerBodyInner(element, form, mode, depth, visited) {
  const isEditor = mode === 'editor';
  const selectedSet = isEditor ? new Set(selectedIds()) : null;
  const children = elementChildren(form, element.id).filter(
    (child) => !visited.has(child.id)
  );
  let content = children
    .map((child) =>
      elementWrapperHtml(child, form, mode, depth + 1, visited, selectedSet)
    )
    .join('');

  if (!content && isEditor) {
    content = element.type === 'form'
      ? '<div class="form-empty">Экран приложения. Перетащите сюда элементы из палитры — ' +
        'в предпросмотре будет показан только этот экран.</div>'
      : '<div class="panel-empty">Перетащите элемент из палитры в панель</div>';
  }

  return (
    '<div class="container-body" data-body-for="' + escapeAttr(element.id) + '"' +
    ' style="' + containerBodyStyle(element) + '">' + content + '</div>'
  );
}

function formInner(element, form, mode, depth, visited) {
  const background = form?.background || '#ffffff';
  return (
    '<div class="el-form" data-form-surface="' + escapeAttr(element.id) + '"' +
    ' style="background:' + escapeAttr(background) + '">' +
    containerBodyInner(element, form, mode, depth, visited) +
    '</div>'
  );
}

function panelInner(element, form, mode, depth, visited) {
  if (!form) return '<div class="el-panel"></div>';
  const config = normalizePanel(element.panel);
  const childCount = elementChildren(form, element.id).length;
  const title = config.title
    ? '<div class="panel-head"><span>' + escapeHtml(config.title) + '</span>' +
      '<small>' + childCount + ' эл.</small></div>'
    : '';
  return (
    '<div class="el-panel' + (config.border ? ' bordered' : '') + '" data-panel-id="' +
    escapeAttr(element.id) + '" style="background:' + escapeAttr(config.background) + '">' +
    title +
    containerBodyInner(element, form, mode, depth, visited) +
    '</div>'
  );
}

/* =========================================================================
   Панель свойств
   ========================================================================= */

function propField(label, prop, value, options = {}) {
  const attrs = [];
  if (options.min != null) attrs.push('min="' + options.min + '"');
  if (options.max != null) attrs.push('max="' + options.max + '"');
  if (options.step != null) attrs.push('step="' + options.step + '"');
  if (options.placeholder) attrs.push('placeholder="' + escapeAttr(options.placeholder) + '"');
  return (
    '<label class="prop-field' + (options.full ? ' full' : '') + '">' +
    '<span>' + escapeHtml(label) + '</span>' +
    '<input data-prop="' + prop + '" type="' + (options.type || 'text') + '"' +
    ' value="' + escapeAttr(value == null ? '' : value) + '" ' + attrs.join(' ') + '>' +
    '</label>'
  );
}

function propTextarea(label, prop, value) {
  return (
    '<label class="prop-field full"><span>' + escapeHtml(label) + '</span>' +
    '<textarea data-prop="' + prop + '">' + escapeHtml(value || '') + '</textarea></label>'
  );
}

function propSelect(label, prop, optionsHtml, full) {
  return (
    '<label class="prop-field' + (full ? ' full' : '') + '">' +
    '<span>' + escapeHtml(label) + '</span>' +
    '<select data-prop="' + prop + '">' + optionsHtml + '</select></label>'
  );
}

function propCheck(label, prop, checked) {
  return (
    '<label class="prop-check"><input type="checkbox" data-prop="' + prop + '"' +
    (checked ? ' checked' : '') + '><span>' + escapeHtml(label) + '</span></label>'
  );
}

function selectOptions(map, selected) {
  return Object.entries(map)
    .map(
      ([value, label]) =>
        '<option value="' + escapeAttr(value) + '"' +
        (String(selected) === value ? ' selected' : '') + '>' +
        escapeHtml(label) + '</option>'
    )
    .join('');
}

function formOptions(selected, excludeId, emptyLabel) {
  let html = '<option value="">' + escapeHtml(emptyLabel || '— выберите форму —') + '</option>';
  (state.project?.forms || []).forEach((form) => {
    if (excludeId && form.id === excludeId) return;
    html +=
      '<option value="' + escapeAttr(form.id) + '"' +
      (form.id === selected ? ' selected' : '') + '>' +
      escapeHtml(form.name) + '</option>';
  });
  if (selected && !(state.project?.forms || []).some((form) => form.id === selected)) {
    html += '<option value="' + escapeAttr(selected) + '" selected>⚠ форма не найдена</option>';
  }
  return html;
}

function knownRoles() {
  const roles = [];
  const seen = new Set();
  const add = (raw) => {
    const role = String(raw || '').trim();
    if (!role) return;
    const key = role.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roles.push(role);
  };
  (state.authUsers || []).forEach((user) => add(user.role));
  return roles.sort((a, b) => a.localeCompare(b, 'ru'));
}

function roleOptionsHtml(selected, unavailable) {
  const current = String(selected || '').trim();
  const roles = knownRoles();
  const blocked = new Set((unavailable || []).map((role) => String(role).toLowerCase()));
  if (current && !roles.some((role) => role.toLowerCase() === current.toLowerCase())) {
    roles.push(current);
  }  let html = '<option value="">— выберите роль —</option>';
  roles.forEach((role) => {
    const isCurrent = role.toLowerCase() === current.toLowerCase();
    const disabled = !isCurrent && blocked.has(role.toLowerCase());
    html +=
      '<option value="' + escapeAttr(role) + '"' +
      (isCurrent ? ' selected' : '') +
      (disabled ? ' disabled' : '') + '>' +
      escapeHtml(role) + (disabled ? ' · уже выбрана' : '') + '</option>';
  });
  if (!roles.length) {
    html += '<option value="" disabled>роли не найдены</option>';
  }
  return html;
}

function ensureAuthRolesLoaded() {
  if (state.authRolesRequested || state.authUsers.length || !authConfigured()) return;
  state.authRolesRequested = true;
  loadAuthUsers().then(() => {
    const element = selectedElement();
    if (element && element.type === 'button' &&
        (element.action === 'login' || element.action === 'register')) {
      renderProperties();
    }
  });
}

function roleRouteRowsHtml(element) {
  ensureAuthRolesLoaded();
  const routes = normalizeRoleRoutes(element.roleRoutes);
  const rows = routes.map((route, index) => {
    const unavailable = routes
      .filter((item, itemIndex) => itemIndex !== index)
      .map((item) => String(item.role || '').trim())
      .filter(Boolean);
    return (
      '<div class="role-route-row">' +
        '<select data-role-route-field="role" data-role-route-index="' + index + '"' +
        ' title="Роль из таблицы авторизации">' +
        roleOptionsHtml(route.role, unavailable) +
        '</select>' +
        '<select data-role-route-field="formId" data-role-route-index="' + index + '">' +
        formOptions(route.formId, '', '— форма —') +
        '</select>' +
        '<button type="button" class="icon-btn danger" data-click="remove-role-route"' +
        ' data-role-route-index="' + index + '" title="Удалить переход">×</button>' +
      '</div>'
    );
  }).join('');
  return (
    '<div class="prop-field full role-routes">' +
      '<div class="role-routes-head">' +
        '<span>После успешного входа</span>' +
        '<span class="role-routes-actions">' +
          '<button type="button" class="mini-btn" data-click="refresh-role-list"' +
          ' title="Обновить список ролей из таблицы авторизации">↻</button>' +
          '<button type="button" class="mini-btn" data-click="add-role-route">+ роль</button>' +
        '</span>' +
      '</div>' +
      propSelect('Форма по умолчанию', 'postLoginForm',
        formOptions(element.postLoginForm, '', '— на стартовую форму —'), true) +
      (rows ? '<div class="role-route-list">' + rows + '</div>' : '') +
      '<div class="prop-hint">Роль выбирается из списка — он собран по пользователям' +
      ' на вкладке «Авторизация». Если список пуст, укажите колонку роли' +
      ' в настройках авторизации и нажмите ↻. Сравнение идёт без учёта регистра.' +
      ' Если совпадений нет, откроется форма по умолчанию.</div>' +
    '</div>'
  );
}

function tableOptions(selected, emptyLabel) {
  let html = '<option value="">' + escapeHtml(emptyLabel || '— не выбрана —') + '</option>';
  let found = !selected;
  state.tables.forEach((table) => {
    const ref = tableRefOf(table);
    const isSelected = sameTableRef(ref, selected);
    if (isSelected) found = true;
    html +=
      '<option value="' + escapeAttr(ref) + '"' +
      (isSelected ? ' selected' : '') + '>' +
      escapeHtml(table.label) + '</option>';
  });
  if (!found) {
    html += '<option value="' + escapeAttr(selected) + '" selected>⚠ привязка потеряна</option>';
  }
  return html;
}

function columnOptions(element) {
  const table = tableFromValue(element.table);
  if (!table) return '<option value="">— сначала выберите таблицу —</option>';
  let html = '<option value="">— не выбрана —</option>';
  table.columns.forEach((column) => {
    html +=
      '<option value="' + escapeAttr(column.name) + '"' +
      (column.name === element.column ? ' selected' : '') + '>' +
      escapeHtml(column.name) + ' · ' + escapeHtml(column.data_type) +
      (column.is_pk ? ' 🔑' : '') + '</option>';
  });
  if (element.column && !table.columns.some((column) => column.name === element.column)) {
    html += '<option value="' + escapeAttr(element.column) + '" selected>⚠ ' +
      escapeHtml(element.column) + '</option>';
  }
  return html;
}

function renderProperties() {
  const panel = $('#properties');
  if (!panel || !state.project) return;
  if (state.selected?.kind === 'multi') {
    panel.innerHTML = multiPropertiesHtml();
  } else {
    const element = selectedElement();
    if (element) {
      panel.innerHTML = elementPropertiesHtml(element, findForm(state.selected.formId) || currentForm());
    } else {
      const form = selectedForm() || currentForm();
      panel.innerHTML = form
        ? formPropertiesHtml(form)
        : '<div class="empty-props">Выберите форму или элемент</div>';
    }
  }
  updateAlignToolbar();
  decorateHints(panel);
}

/* =========================================================================
   Подсказки: закрытие и запоминание
   ========================================================================= */

const HIDDEN_HINTS_KEY = 'db2ui.hiddenHints.v1';
let hiddenHintKeys = null;

function hintKeyFor(hint) {
  const text = String(hint.textContent || '').replace(/\s+/g, ' ').trim();
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 'h' + (hash >>> 0).toString(36);
}

function hiddenHintSet() {
  if (hiddenHintKeys) return hiddenHintKeys;
  hiddenHintKeys = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_HINTS_KEY) || '[]');
    if (Array.isArray(raw)) {
      raw.slice(0, 300).forEach((key) => hiddenHintKeys.add(String(key)));
    }
  } catch (error) {
    // повреждённое хранилище игнорируем
  }
  return hiddenHintKeys;
}

function rememberHiddenHint(key) {
  if (!key) return;
  const set = hiddenHintSet();
  set.add(key);
  try {
    localStorage.setItem(HIDDEN_HINTS_KEY, JSON.stringify(Array.from(set).slice(-300)));
  } catch (error) {
    // localStorage может быть недоступен
  }
}

function decorateHints(root) {
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  const hints = scope.querySelectorAll('.prop-hint, .palette-hint');
  hints.forEach((hint) => {
    if (!hint.querySelector('.hint-close')) {
      hint.dataset.hintKey = hintKeyFor(hint);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'hint-close';
      close.title = 'Скрыть подсказку';
      close.setAttribute('aria-label', 'Скрыть подсказку');
      close.textContent = '×';
      hint.appendChild(close);
    }
    hint.hidden = hiddenHintSet().has(hint.dataset.hintKey || '');
  });
}

function bindHintDismissal() {
  document.addEventListener('click', (event) => {
    const close = event.target.closest('.hint-close');
    if (!close) return;
    const hint = close.closest('.prop-hint, .palette-hint');
    if (!hint) return;
    event.preventDefault();
    hint.hidden = true;
    rememberHiddenHint(hint.dataset.hintKey);
  });
  decorateHints(document);
}

function formPropertiesHtml(form) {
  const isStart = state.project.start_form === form.id;
  const root = rootFormElement(form);
  const width = root ? Math.round(root.w) : form.width;
  const height = root ? Math.round(root.h) : form.height;
  return `
    <div class="prop-title">
      <h3 data-prop-title>${escapeHtml(form.name)}</h3>
      <span class="type-chip">форма</span>
    </div>
    <div class="prop-grid">
      <label class="prop-field full"><span>Название формы</span>
        <input data-form-prop="name" value="${escapeAttr(form.name)}">
      </label>
      <label class="prop-field"><span>Ширина экрана, px</span>
        <input data-form-prop="width" type="number" min="${FORM_MIN_WIDTH}" max="${FORM_MAX_SIZE}" value="${width}">
      </label>
      <label class="prop-field"><span>Высота экрана, px</span>
        <input data-form-prop="height" type="number" min="${FORM_MIN_HEIGHT}" max="${FORM_MAX_SIZE}" value="${height}">
      </label>
      <label class="prop-field full"><span>Цвет экрана</span>
        <input data-form-prop="background" type="color" value="${escapeAttr(form.background || '#ffffff')}">
      </label>
    </div>
    <div class="prop-hint">
      Точечный холст — только рабочее пространство. В предпросмотре показывается
      <b>только этот экран</b>. Размер экрана меняется за ползунок на самом элементе
      «Форма», а все элементы внутри масштабируются вместе с ним.
    </div>
    <div class="prop-hint">
      Чтобы сгруппировать элементы, добавьте внутрь формы элемент <b>Панель</b>.
      Панель свободно меняет размер, а её содержимое масштабируется.
      Элементов на экране: <b>${Math.max(0, form.elements.length - 1)}</b>.
    </div>
    <div class="start-card">
      <b>${isStart ? 'Стартовая форма' : 'Сделать стартовой?'}</b>
      <p>Именно этот экран открывается первым в режиме предпросмотра.</p>
      <button type="button" class="btn btn-ghost btn-sm" data-click="make-start"${isStart ? ' disabled' : ''}>
        ${isStart ? 'Уже стартовая' : 'Сделать стартовой'}
      </button>
    </div>
    <div class="prop-actions">
      <button type="button" class="btn btn-danger btn-sm" data-click="delete-form"
        ${state.project.forms.length <= 1 ? 'disabled' : ''}>Удалить форму</button>
    </div>`;
}

function multiPropertiesHtml() {
  const count = selectedIds().length;
  return `
    <div class="prop-title">
      <h3>Выбрано элементов: ${count}</h3>
      <span class="type-chip">группа</span>
    </div>
    <div class="prop-hint">
      Используйте кнопки выравнивания на панели над холстом или перемещайте
      элементы вместе мышью. Потяните за маркер размера у любого выделенного
      элемента — вся группа будет масштабироваться одновременно.
      Ctrl/Shift добавляет элементы к выделению.
    </div>
    <div class="prop-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-click="duplicate-element">Дублировать</button>
      <button type="button" class="btn btn-danger btn-sm" data-click="delete-element">Удалить</button>
    </div>`;
}

function refTableColumns(element) {
  const table = tableFromValue(element.table);
  if (!table) return [];
  const column = table.columns.find((item) => item.name === element.column);
  const ref = column?.references;
  if (!ref) return table.columns;
  return state.tables.find(
    (item) => item.schema === ref.ref_schema && item.name === ref.ref_table
  )?.columns || table.columns;
}

function labelColumnOptions(element) {
  const columns = refTableColumns(element);
  if (!columns.length) return '<option value="">— сначала выберите таблицу —</option>';
  return '<option value="">— авто (текстовая колонка) —</option>' +
    columns
      .map(
        (column) =>
          '<option value="' + escapeAttr(column.name) + '"' +
          (column.name === element.labelColumn ? ' selected' : '') + '>' +
          escapeHtml(column.name) + '</option>'
      )
      .join('');
}

function elementPropertiesHtml(element, form) {
  const parent = parentElementOf(form, element);
  const minW = element.type === 'form' ? FORM_MIN_WIDTH : 20;
  const minH = element.type === 'form' ? FORM_MIN_HEIGHT : 20;
  const geometry = `
      ${propField('X', 'x', Math.round(element.x), { type: 'number', min: 0 })}
      ${propField('Y', 'y', Math.round(element.y), { type: 'number', min: 0 })}
      ${propField('Ширина', 'w', Math.round(element.w), { type: 'number', min: minW })}
      ${propField('Высота', 'h', Math.round(element.h), { type: 'number', min: minH })}`;

  const common = `
    <div class="prop-title">
      <h3 data-prop-title>${escapeHtml(element.name)}</h3>
      <span class="type-chip">${TYPE_LABELS[element.type] || element.type}</span>
    </div>
    <div class="prop-grid">
      ${propField('Название', 'name', element.name, { full: true })}
      ${geometry}
    </div>
    ${parent ? '<div class="prop-hint">Элемент находится внутри: <b>' + escapeHtml(parent.name) + '</b>. Координаты и размер задаются относительно этого контейнера.</div>' : ''}
    <div style="height:14px"></div>`;

  let specific = '';

  if (element.type === 'form') {
    specific =
      '<div class="prop-grid">' +
      propField('Цвет экрана', 'background', form?.background || '#ffffff', { type: 'color', full: true }) +
      '</div>' +
      '<div class="prop-hint">Это экран приложения. В предпросмотре показывается только он. ' +
      'Меняйте размер за ползунок — элементы внутри масштабируются пропорционально. ' +
      'Перетаскивание самой формы двигает экран по рабочему пространству.</div>';
  } else if (element.type === 'text') {
    specific =
      '<div class="prop-grid">' +
      propTextarea('Текст', 'text', element.text) +
      propField('Размер шрифта', 'fontSize', element.fontSize || 20, { type: 'number', min: 8, max: 96 }) +
      propSelect('Начертание', 'fontWeight',
        selectOptions({ normal: 'Обычное', '600': 'Полужирное', '700': 'Жирное', '800': 'Очень жирное' }, String(element.fontWeight || '700'))) +
      propField('Цвет', 'color', element.color || '#172033', { type: 'color' }) +
      propSelect('Выравнивание', 'align',
        selectOptions({ left: 'По левому краю', center: 'По центру', right: 'По правому краю' }, element.align || 'left')) +
      '</div>';
  } else if (element.type === 'button') {
    let actionFields = '';
    const action = element.action || 'navigate';
    if (action === 'navigate') {
      actionFields = propSelect('Форма для перехода', 'targetForm', formOptions(element.targetForm), true);
    } else if (action === 'insert') {
      actionFields = propSelect('Таблица для добавления', 'table',
        tableOptions(element.table, '— выберите таблицу —'), true);
    } else if (action === 'login' || action === 'register') {
      actionFields =
        '<div class="prop-hint">Кнопка возьмёт логин и пароль из полей текущей формы. Для входа или регистрации добавьте два поля ввода: логин и пароль.</div>' +
        roleRouteRowsHtml(element);
    }
    specific =
      '<div class="prop-grid">' +
      propField('Надпись на кнопке', 'text', element.text || 'Кнопка', { full: true }) +
      propSelect('Действие', 'action', selectOptions(ACTIONS, action), true) +
      actionFields +
      propField('Размер шрифта', 'fontSize', element.fontSize || 14, { type: 'number', min: 8, max: 48 }) +
      propField('Цвет кнопки', 'color', element.color || '#4f46e5', { type: 'color' }) +
      propField('Цвет текста', 'textColor', element.textColor || '#ffffff', { type: 'color' }) +
      '</div>' +
      '<div class="prop-hint">Кнопка может открывать форму, возвращать на главную, входить, регистрировать, добавлять запись, обновлять таблицы или выполнять выход.</div>';
  } else if (element.type === 'input') {
    specific =
      '<div class="prop-grid">' +
      propField('Подпись поля', 'label', element.label || '', { full: true }) +
      propSelect('Таблица', 'table', tableOptions(element.table, '— не выбрана —'), true) +
      propSelect('Колонка', 'column', columnOptions(element), true) +
      propField('Подсказка', 'placeholder', element.placeholder || '', { full: true }) +
      propSelect('Тип поля', 'inputType', selectOptions(INPUT_TYPES, element.inputType || 'text'), true) +
      '</div>' +
      propCheck('Обязательное поле', 'required', !!element.required) +
      '<div class="prop-hint">Поле привязывается к колонке таблицы. Кнопка с действием «Добавить запись из полей» переносит значения в базу.</div>';
  } else if (element.type === 'select') {
    specific =
      '<div class="prop-grid">' +
      propField('Подпись поля', 'label', element.label || 'Выбор', { full: true }) +
      propSelect('Таблица', 'table', tableOptions(element.table, '— не выбрана —'), true) +
      propSelect('Колонка (значение)', 'column', columnOptions(element), true) +
      propSelect('Показывать колонку', 'labelColumn', labelColumnOptions(element), true) +
      propField('Подсказка', 'placeholder', element.placeholder || '— выберите —', { full: true }) +
      '</div>' +
      propCheck('Обязательное поле', 'required', !!element.required) +
      '<div class="prop-hint">Если колонка ссылается на другую таблицу (внешний ключ), список покажет понятные названия вместо 1, 2, 3. Например, роли вместо идентификаторов.</div>';
  } else if (element.type === 'image') {
    specific =
      '<div class="prop-grid">' +
      propField('Ссылка на изображение', 'src', element.src || '', { full: true, placeholder: 'https://… или выберите файл' }) +
      propField('Подпись (alt)', 'alt', element.alt || '', { full: true }) +
      propSelect('Вписывание', 'fit',
        selectOptions({ contain: 'Вписать целиком', cover: 'Заполнить с обрезкой', fill: 'Растянуть' }, element.fit || 'contain'), true) +
      propField('Скругление, px', 'radius', element.radius || 0, { type: 'number', min: 0, max: 80 }) +
      '</div>' +
      '<label class="prop-field full"><span>Файл с компьютера</span>' +
      '<input type="file" accept="image/*" data-image-file></label>' +
      '<div class="prop-hint">Файл до 2 МБ сохраняется внутри проекта как data URL, поэтому проект остаётся переносимым.</div>';
  } else if (element.type === 'table') {
    const table = tableFromValue(element.table);
    const noKey = table && !table.primary_key.length;
    specific =
      '<div class="prop-grid">' +
      propSelect('Таблица из базы', 'table', tableOptions(element.table, '— не выбрана —'), true) +
      propField('Строк на экране', 'limit', element.limit || 50, { type: 'number', min: 1, max: 200 }) +
      '</div>' +
      propCheck('Разрешить изменение данных', 'editable', element.editable !== false) +
      (element.editable !== false
        ? '<div style="height:8px"></div>' +
          propCheck('Добавлять записи', 'allowAdd', element.allowAdd !== false) +
          propCheck('Редактировать записи', 'allowEdit', element.allowEdit !== false) +
          propCheck('Удалять записи', 'allowDelete', element.allowDelete !== false)
        : '') +
      (noKey
        ? '<div class="prop-hint warn">У таблицы нет первичного ключа. Добавлять записи можно, а изменять и удалять — нельзя.</div>'
        : '<div class="prop-hint">Изменения и удаление работают, если у таблицы есть первичный ключ.</div>');
  } else if (element.type === 'panel') {
    const config = normalizePanel(element.panel);
    specific =
      '<div class="prop-grid">' +
      propField('Заголовок панели', 'panel.title', config.title, { full: true }) +
      propField('Внутренние поля, px', 'panel.padding', config.padding, { type: 'number', min: 0, max: 80 }) +
      propField('Фон панели', 'panel.background', config.background, { type: 'color' }) +
      '</div>' +
      propCheck('Показывать рамку', 'panel.border', config.border) +
      '<div class="prop-hint">Свободная панель, как в WinForms. Потяните за маркер размера — элементы внутри ' +
      'масштабируются вместе с панелью. Перетащите элемент из палитры прямо в панель, чтобы вложить его. ' +
      'В панель можно вкладывать другие панели.</div>';
  } else if (element.type === 'sql') {
    specific =
      '<div class="prop-grid">' +
      propTextarea('SQL-запрос (SELECT)', 'query', element.query || '') +
      propField('Максимум строк', 'limit', element.limit || 100, { type: 'number', min: 1, max: 500 }) +
      '</div>' +
      '<div class="prop-hint">Разрешены только читающие запросы: <b>SELECT</b> или <b>WITH</b>. Результат показывается в таблице на форме и в предпросмотре. Один запрос — один элемент.</div>';
  }

  const actions = element.type === 'form'
    ? ''
    : `
    <div class="prop-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-click="duplicate-element">Дублировать</button>
      <button type="button" class="btn btn-danger btn-sm" data-click="delete-element">Удалить</button>
    </div>`;

  return common + specific + actions;
}

function bindProperties() {
  const panel = $('#properties');
  if (!panel) return;

  panel.addEventListener('input', (event) => {
    const routeField = event.target.closest('[data-role-route-field]');
    if (routeField) {
      applyRoleRouteField(routeField);
      return;
    }

    const formNameInput = event.target.closest('[data-form-prop]');
    if (formNameInput) {
      const prop = formNameInput.dataset.formProp;
      // Ширина и высота применяются по change, чтобы не масштабировать
      // элементы на каждый промежуточный символ.
      if (prop === 'width' || prop === 'height') return;
      applyFormProperty(prop, formNameInput.value, formNameInput);
      return;
    }

    const field = event.target.closest('[data-prop]');
    if (!field) return;
    const element = selectedElement();
    if (!element) return;
    const prop = field.dataset.prop;
    let value;
    if (field.type === 'checkbox') value = field.checked;
    else if (field.type === 'number') value = field.value === '' ? 0 : Number(field.value);
    else value = field.value;
    applyElementProperty(element, prop, value, field);
  });

  panel.addEventListener('change', (event) => {
    const routeField = event.target.closest('[data-role-route-field]');
    if (routeField) {
      applyRoleRouteField(routeField);
      return;
    }

    const formSelect = event.target.closest('[data-form-prop]');
    if (formSelect && (event.target.tagName === 'SELECT' ||
        formSelect.dataset.formProp === 'width' ||
        formSelect.dataset.formProp === 'height')) {
      applyFormProperty(formSelect.dataset.formProp, formSelect.value, formSelect);
      return;
    }
    const fileInput = event.target.closest('[data-image-file]');
    if (!fileInput) return;
    const element = selectedElement();
    if (!element || element.type !== 'image') return;
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast('Выберите файл изображения (PNG, JPEG, GIF, SVG, WebP).', 'error');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast('Файл больше 2 МБ. Уменьшите изображение или укажите ссылку.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      element.src = String(reader.result || '');
      renderCanvas();
      renderProperties();
      scheduleSave();
      toast('Изображение добавлено в проект', 'success');
    };
    reader.onerror = () => toast('Не удалось прочитать файл изображения', 'error');
    reader.readAsDataURL(file);
  });

  panel.addEventListener('click', (event) => {
    const button = event.target.closest('[data-click]');
    if (!button) return;
    const action = button.dataset.click;
    if (action === 'duplicate-element') duplicateSelectedElements();
    else if (action === 'delete-element') deleteSelectedElements();
    else if (action === 'make-start') {
      const form = selectedForm() || currentForm();
      if (form) setStartForm(form.id);
    } else if (action === 'delete-form') {
      const form = selectedForm() || currentForm();
      if (form) deleteForm(form.id);
    } else if (action === 'add-role-route') {
      const element = selectedElement();
      if (!element || element.type !== 'button') return;
      element.roleRoutes = normalizeRoleRoutes(element.roleRoutes);
      element.roleRoutes.push({ role: '', formId: '' });
      renderProperties();
      scheduleSave();
    } else if (action === 'refresh-role-list') {
      state.authRolesRequested = true;
      loadAuthUsers().then(() => {
        const element = selectedElement();
        if (element && element.type === 'button') renderProperties();
      });
    } else if (action === 'remove-role-route') {
      const element = selectedElement();
      if (!element || element.type !== 'button') return;
      const index = Number(button.dataset.roleRouteIndex);
      if (!Number.isInteger(index) || index < 0) return;
      element.roleRoutes = normalizeRoleRoutes(element.roleRoutes);
      element.roleRoutes.splice(index, 1);
      renderProperties();
      scheduleSave();
    }
  });
}

function applyRoleRouteField(field) {
  const element = selectedElement();
  if (!element || element.type !== 'button') return;
  const index = Number(field.dataset.roleRouteIndex);
  const key = field.dataset.roleRouteField;
  if (!Number.isInteger(index) || index < 0 || !key) return;
  if (!Array.isArray(element.roleRoutes)) element.roleRoutes = [];
  const route = element.roleRoutes[index];
  if (!route || typeof route !== 'object') return;
  route[key] = String(field.value || '').slice(0, key === 'formId' ? 80 : 120);
  scheduleSave();
}

function scaleContainerDescendants(form, container, axis, ratio) {
  if (!container || !Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return;
  descendantsOf(form, container.id).forEach((element) => {
    if (axis === 'x') {
      element.x = Math.max(0, Math.round(element.x * ratio));
      element.w = Math.max(20, Math.round(element.w * ratio));
    } else {
      element.y = Math.max(0, Math.round(element.y * ratio));
      element.h = Math.max(20, Math.round(element.h * ratio));
    }
  });
}

function applyFormProperty(prop, rawValue) {
  const form = selectedForm() || currentForm();
  if (!form) return;
  const root = rootFormElement(form);
  if (prop === 'name') {
    const name = String(rawValue || '').slice(0, 120);
    form.name = name;
    if (root) root.name = name;
    const title = $('#properties [data-prop-title]');
    if (title) title.textContent = name || 'Форма';
    renderTree();
    renderFormTabs();
    updateCrumb();
  } else if (prop === 'width' && root) {
    const next = clamp(Math.round(num(rawValue, root.w)), FORM_MIN_WIDTH, FORM_MAX_SIZE);
    const ratio = root.w ? next / root.w : 1;
    scaleContainerDescendants(form, root, 'x', ratio);
    root.w = next;
    form.width = next;
    applyFormSurfaceStyles(form);
    renderCanvas();
  } else if (prop === 'height' && root) {
    const next = clamp(Math.round(num(rawValue, root.h)), FORM_MIN_HEIGHT, FORM_MAX_SIZE);
    const ratio = root.h ? next / root.h : 1;
    scaleContainerDescendants(form, root, 'y', ratio);
    root.h = next;
    form.height = next;
    applyFormSurfaceStyles(form);
    renderCanvas();
  } else if (prop === 'background') {
    form.background = String(rawValue || '#ffffff');
    renderCanvas();
  }
  scheduleSave();
}

function applyElementProperty(element, prop, value) {
  const form = currentForm();
  if (!form) return;
  const isRoot = element.type === 'form';
  const parent = parentElementOf(form, element);
  const parentContent = parent ? containerContentSize(parent) : { w: FORM_MAX_SIZE, h: FORM_MAX_SIZE };

  if (prop.indexOf('panel.') === 0) {
    const key = prop.slice('panel.'.length);
    element.panel = normalizePanel(element.panel);
    if (key === 'title') {
      element.panel.title = String(value || '').slice(0, 120);
    } else if (key === 'background') {
      element.panel.background = String(value || PANEL_DEFAULT.background);
    } else if (key === 'border') {
      element.panel.border = !!value;
    } else if (key === 'padding') {
      const oldContent = containerContentSize(element);
      const snapshot = snapshotSubtree(form, element);
      element.panel.padding = clamp(Math.round(num(value, element.panel.padding)), 0, 80);
      const nextContent = containerContentSize(element);
      scaleSubtreeGeometry(
        form,
        element,
        snapshot,
        nextContent.w / Math.max(1, oldContent.w),
        nextContent.h / Math.max(1, oldContent.h)
      );
    }
  } else if (['x', 'y', 'w', 'h'].includes(prop)) {
    if (prop === 'x') {
      element.x = clamp(Math.round(num(value, 0)), 0, Math.max(0, parentContent.w - element.w));
    } else if (prop === 'y') {
      element.y = clamp(Math.round(num(value, 0)), 0, Math.max(0, parentContent.h - element.h));
    } else {
      const oldContent = containerContentSize(element);
      const snapshot = isContainerElement(element) ? snapshotSubtree(form, element) : null;
      const minW = isRoot ? FORM_MIN_WIDTH : 20;
      const minH = isRoot ? FORM_MIN_HEIGHT : 20;
      if (prop === 'w') {
        element.w = clamp(Math.round(num(value, element.w)), minW, Math.max(minW, parentContent.w - element.x));
      } else {
        element.h = clamp(Math.round(num(value, element.h)), minH, Math.max(minH, parentContent.h - element.y));
      }
      if (snapshot) {
        const nextContent = containerContentSize(element);
        scaleSubtreeGeometry(
          form,
          element,
          snapshot,
          nextContent.w / Math.max(1, oldContent.w),
          nextContent.h / Math.max(1, oldContent.h)
        );
      }
      if (isRoot) {
        form.width = Math.round(element.w);
        form.height = Math.round(element.h);
      }
    }
  } else if (prop === 'background' && isRoot) {
    form.background = String(value || '#ffffff');
  } else if (prop === 'query') {
    element.query = String(value || '').slice(0, 20000);
    sqlCache.clear();
  } else if (prop === 'limit' && element.type === 'sql') {
    element.limit = clamp(Math.round(num(value, SQL_DEFAULT.limit)), 1, 500);
    sqlCache.clear();
  } else if (prop === 'table') {
    element.table = value || '';
    if (element.type === 'input' || element.type === 'select') {
      const table = tableFromValue(element.table);
      if (!table || !table.columns.some((column) => column.name === element.column)) {
        element.column = '';
      }
      element.labelColumn = '';
    }
  } else if (prop === 'column') {
    element.column = value || '';
    const table = tableFromValue(element.table);
    const column = table?.columns.find((item) => item.name === element.column);
    if (column && (!element.label || /^Поле( ввода)?( \d+)?$/.test(element.label))) {
      element.label = column.name;
    }
    if (element.type === 'select') {
      const ref = column?.references;
      const refTable = ref
        ? state.tables.find(
            (item) => item.schema === ref.ref_schema && item.name === ref.ref_table
          )
        : null;
      const preferred = refTable ? preferredLabelColumn(refTable) : '';
      if (!element.labelColumn || !refTable || !refTable.columns.some((item) => item.name === element.labelColumn)) {
        element.labelColumn = preferred;
      }
    }
  } else {
    element[prop] = value;
  }

  renderCanvas();

  if (prop === 'name') {
    const title = $('#properties [data-prop-title]');
    if (title) title.textContent = element.name;
    if (isRoot) {
      form.name = element.name;
      renderFormTabs();
      updateCrumb();
    }
    renderTree();
  }

  if (['action', 'table', 'column', 'formId', 'editable'].includes(prop)) renderProperties();
  scheduleSave();
}

/* =========================================================================
   Данные таблиц
   ========================================================================= */

function invalidateTable(table) {
  Array.from(rowCache.keys()).forEach((key) => {
    try {
      const parsed = JSON.parse(key);
      if (parsed[0] === table.schema && parsed[1] === table.name) rowCache.delete(key);
    } catch (error) {
      rowCache.delete(key);
    }
  });
}

async function fetchRows(table, limit, force) {
  const key = JSON.stringify([table.schema, table.name, limit]);
  const cached = rowCache.get(key);
  if (!force && cached && Date.now() - cached.time < CACHE_TTL) return cached.data;
  const data = await api(
    '/api/table?schema=' + encodeURIComponent(table.schema) +
    '&table=' + encodeURIComponent(table.name) +
    '&limit=' + encodeURIComponent(limit)
  );
  rowCache.set(key, { time: Date.now(), data });
  return data;
}

function formatCell(value) {
  if (value === null || value === undefined) return '<span class="null">NULL</span>';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
  return escapeHtml(String(value));
}

function renderTableInto(body, element, table, data, mode) {
  const rows = data.rows || [];
  const columns = data.table?.columns || table.columns || [];

  if (!rows.length) {
    body.innerHTML = '<div class="table-empty">В таблице пока нет записей.</div>';
    body._rows = [];
    body._table = data.table || table;
    return;
  }

  const canEdit = mode === 'preview' && element.editable !== false;
  const showActions =
    canEdit &&
    table.primary_key.length > 0 &&
    (element.allowEdit !== false || element.allowDelete !== false);

  let html = '<table class="data-table"><thead><tr>';
  columns.forEach((column) => {
    html += '<th>' + escapeHtml(column.name) + (column.is_pk ? ' 🔑' : '') + '</th>';
  });
  if (showActions) html += '<th></th>';
  html += '</tr></thead><tbody>';

  rows.forEach((row, index) => {
    html += '<tr>';
    columns.forEach((column) => {
      html += '<td>' + formatCell(row[column.name]) + '</td>';
    });
    if (showActions) {
      html += '<td><div class="row-actions">';
      if (element.allowEdit !== false) {
        html += '<button type="button" class="row-btn" data-act="edit" data-row-index="' + index + '" title="Изменить">✎</button>';
      }
      if (element.allowDelete !== false) {
        html += '<button type="button" class="row-btn danger" data-act="delete" data-row-index="' + index + '" title="Удалить">🗑</button>';
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

async function loadTableBody(element, body, mode, force = false) {
  if (!body) return;
  const table = tableFromValue(element.table);
  if (!table) {
    body.innerHTML = '<div class="table-empty">Выберите таблицу в панели свойств справа.</div>';
    return;
  }

  const token = String(Math.random());
  body.dataset.token = token;
  body.innerHTML = '<div class="table-loading">Загрузка данных…</div>';
  try {
    const data = await fetchRows(table, Math.max(1, num(element.limit, 50)), force);
    if (!body.isConnected || body.dataset.token !== token) return;
    renderTableInto(body, element, table, data, mode);
  } catch (error) {
    if (!body.isConnected || body.dataset.token !== token) return;
    body.innerHTML = '<div class="table-error">' + escapeHtml(error.message) + '</div>';
  }
}

/* =========================================================================
   Предпросмотр
   ========================================================================= */

function bindPreview() {
  const canvas = $('#preview-canvas');
  if (canvas) {
    canvas.addEventListener('click', async (event) => {
      const button = event.target.closest('.el-button');
      if (button) {
        const wrapper = button.closest('[data-id]');
        const element = findElementAnywhere(wrapper?.dataset.id);
        if (element) {
          await runButtonAction(element, wrapper?.dataset.formId || previewForm()?.id);
        }
        return;
      }

      const actionNode = event.target.closest('[data-act]');
      if (!actionNode) return;
      const wrapper = actionNode.closest('[data-id]');
      const element = findElementAnywhere(wrapper?.dataset.id);
      if (!element) return;
      const action = actionNode.dataset.act;

      if (action === 'sql-run') {
        const body = actionNode.closest('.el-sql')?.querySelector('.el-sql-body');
        if (body) loadSqlBody(element, body, 'preview', true);
        return;
      }
      if (action === 'add') {
        openRecordDialog('create', element, null);
        return;
      }
      if (action === 'reload') {
        const body = actionNode.closest('.el-table')?.querySelector('.el-table-body');
        if (body) loadTableBody(element, body, 'preview', true);
        return;
      }
      if (action === 'edit' || action === 'delete') {
        const body = actionNode.closest('.el-table-body');
        const row = body?._rows?.[Number(actionNode.dataset.rowIndex)];
        if (!row) return;
        if (action === 'edit') openRecordDialog('edit', element, row);
        else await deleteRecord(element, row);
      }
    });
  }

  const loginForm = $('#preview-login-form');
  if (loginForm) loginForm.addEventListener('submit', submitPreviewLogin);

  const loginBack = $('#preview-login-back');
  if (loginBack) loginBack.addEventListener('click', exitPreview);
  const registerBack = $('#preview-register-back');
  if (registerBack) registerBack.addEventListener('click', exitPreview);

  const showRegister = $('#preview-show-register');
  if (showRegister) showRegister.addEventListener('click', showPreviewRegister);
  const showLogin = $('#preview-show-login');
  if (showLogin) showLogin.addEventListener('click', showPreviewLogin);

  const registerForm = $('#preview-register-form');
  if (registerForm) registerForm.addEventListener('submit', submitPreviewRegister);
}

function goPreviewHome() {
  if (!state.project) return;
  if (state.auth.enabled && !state.auth.authenticated) {
    showPreviewLogin();
    return;
  }
  const startId = findForm(state.project.start_form)
    ? state.project.start_form
    : state.project.forms[0]?.id;
  if (startId) renderPreview(startId);
}

async function refreshAuthStatus() {
  try {
    state.auth = normalizeAuthStatus(await api('/api/auth/status'));
  } catch (error) {
    // статус не критичен для открытия предпросмотра
  }
}

async function startPreview() {
  try {
    await flushSave();
  } catch (error) {
    // сохранение уже показало ошибку; предпросмотр всё равно можно открыть
  }
  if (!state.project) return;

  const startId = findForm(state.project.start_form)
    ? state.project.start_form
    : state.project.forms[0].id;
  state.preview = { formId: startId };
  showPreviewScreen();
  await refreshAuthStatus();

  if (state.auth.enabled && !state.auth.authenticated) {
    showPreviewLogin();
    updatePreviewAuthChrome();
    return;
  }

  hidePreviewLogin();
  renderPreview(startId);
}

function exitPreview() {
  showBuilderScreen();
  switchMainTab('builder');
  renderAll();
}

function renderPreview(formId) {
  const form = findForm(formId) || findForm(state.project?.start_form) || state.project?.forms?.[0];
  if (!form) return;
  state.preview.formId = form.id;
  state.auth.formId = form.id;
  $('#preview-form-name').textContent = form.name;

  const canvas = $('#preview-canvas');
  const root = rootFormElement(form);
  const width = root ? Math.round(root.w) : form.width;
  const height = root ? Math.round(root.h) : form.height;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.style.minHeight = '0';
  canvas.style.background = form.background || '#ffffff';
  canvas.style.backgroundImage = 'none';
  canvas.style.border = 'none';
  canvas.style.borderRadius = '0';
  canvas.classList.add('preview-form-surface');

  if (!root) {
    canvas.innerHTML = '';
  } else {
    canvas.innerHTML = elementsMarkup(
      form,
      'preview',
      root.id,
      0,
      new Set([form.id, root.id]),
      null
    );
  }

  const title = $('#preview-window-title');
  if (title) title.textContent = form.name;
  const size = $('#preview-window-size');
  if (size) size.textContent = width + ' × ' + height + ' px';

  $('#preview-window').hidden = false;
  $('#preview-login').hidden = true;
  updatePreviewAuthChrome();

  requestAnimationFrame(() => {
    hydrateTables(canvas, 'preview');
    hydrateSelects(canvas);
    hydrateSql(canvas, 'preview');
  });
}

function updatePreviewAuthChrome() {
  const user = state.auth.user;
  const chip = $('#preview-user');
  const logout = $('#preview-logout-btn');
  if (chip) {
    chip.hidden = !user;
    chip.textContent = user ? user.login + (user.role ? ' · ' + user.role : '') : '';
  }
  if (logout) logout.hidden = !user;
}

function showPreviewLogin() {
  const auth = authConfig();
  const title = $('#preview-login-title');
  if (title) title.textContent = auth.title || AUTH_DEFAULT.title;
  hideError('#preview-login-error');
  hideError('#preview-register-error');
  const loginForm = $('#preview-login-form');
  const registerForm = $('#preview-register-form');
  if (loginForm) loginForm.hidden = false;
  if (registerForm) registerForm.hidden = true;
  const showRegister = $('#preview-show-register');
  if (showRegister) {
    showRegister.hidden = !(auth.allow_registration !== false && authConfigured());
  }
  $('#preview-window').hidden = true;
  $('#preview-login').hidden = false;
  const login = $('#preview-login-form [name="login"]');
  if (login) {
    login.value = '';
    login.focus();
  }
  const password = $('#preview-login-form [name="password"]');
  if (password) password.value = '';
}

function showPreviewRegister() {
  const auth = authConfig();
  if (auth.allow_registration === false || !authConfigured()) {
    showPreviewLogin();
    toast('Регистрация отключена в настройках проекта.', 'error');
    return;
  }
  hideError('#preview-login-error');
  hideError('#preview-register-error');
  const title = $('#preview-register-title');
  if (title) title.textContent = 'Регистрация';
  const loginForm = $('#preview-login-form');
  const registerForm = $('#preview-register-form');
  if (loginForm) loginForm.hidden = true;
  if (registerForm) {
    registerForm.hidden = false;
    const login = registerForm.querySelector('[name="login"]');
    if (login) {
      login.value = '';
      login.focus();
    }
    ['password', 'password2'].forEach((name) => {
      const field = registerForm.querySelector('[name="' + name + '"]');
      if (field) field.value = '';
    });
  }
}

function hidePreviewLogin() {
  const login = $('#preview-login');
  if (login) login.hidden = true;
  const windowNode = $('#preview-window');
  if (windowNode) windowNode.hidden = false;
}

async function submitPreviewLogin(event) {
  event.preventDefault();
  const form = event.target;
  const login = String(form.querySelector('[name="login"]').value || '').trim();
  const password = String(form.querySelector('[name="password"]').value || '');
  const button = $('#preview-login-btn');
  hideError('#preview-login-error');
  if (!login || !password) {
    showError('#preview-login-error', 'Введите логин и пароль.');
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = 'Проверка…';
  }
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login, password }),
    });
    state.auth = { ...state.auth, authenticated: true, user: data.user };
    hidePreviewLogin();
    renderPreview(state.preview.formId || state.project.start_form);
    toast('Добро пожаловать, ' + (data.user?.login || login), 'success');
  } catch (error) {
    showError('#preview-login-error', error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Войти';
    }
  }
}

async function submitPreviewRegister(event) {
  event.preventDefault();
  const form = event.target;
  const login = String(form.querySelector('[name="login"]').value || '').trim();
  const password = String(form.querySelector('[name="password"]').value || '');
  const password2 = String(form.querySelector('[name="password2"]').value || '');
  const button = $('#preview-register-btn');
  hideError('#preview-register-error');

  if (login.length < 3) {
    showError('#preview-register-error', 'Логин должен содержать не менее 3 символов.');
    return;
  }
  if (!/^[A-Za-zА-Яа-яЁё0-9._@-]+$/.test(login)) {
    showError('#preview-register-error', 'Логин может содержать буквы, цифры и символы . _ @ -');
    return;
  }
  if (password.length < 4) {
    showError('#preview-register-error', 'Пароль должен содержать не менее 4 символов.');
    return;
  }
  if (password !== password2) {
    showError('#preview-register-error', 'Пароли не совпадают.');
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = 'Создание…';
  }
  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ login, password, password2 }),
    });
    state.auth = { ...state.auth, authenticated: true, user: data.user };
    hidePreviewLogin();
    renderPreview(state.preview.formId || state.project.start_form);
    toast('Аккаунт создан. Добро пожаловать, ' + (data.user?.login || login), 'success');
  } catch (error) {
    showError('#preview-register-error', error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Зарегистрироваться';
    }
  }
}

async function logoutPreview() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    // выходим локально даже при ошибке сети
  }
  state.auth = { ...state.auth, authenticated: false, user: null };
  updatePreviewAuthChrome();
  if (state.auth.enabled) {
    showPreviewLogin();
  } else {
    renderPreview(state.preview.formId || state.project.start_form);
  }
  toast('Вы вышли из учётной записи', 'info');
}

async function runButtonAction(element, formId) {
  const action = element.action || 'navigate';

  if (action === 'navigate') {
    if (element.targetForm && findForm(element.targetForm)) {
      renderPreview(element.targetForm);
    } else {
      toast('Для кнопки не выбрана форма перехода. Откройте свойства кнопки.', 'error');
    }
    return;
  }

  if (action === 'home') {
    renderPreview(state.project.start_form);
    return;
  }

  if (action === 'refresh') {
    reloadAllPreviewTables(true);
    toast('Данные обновлены', 'info');
    return;
  }

  if (action === 'logout') {
    await logoutPreview();
    return;
  }

  if (action === 'login' || action === 'register') {
    await authFromForm(action, formId, element);
    return;
  }

  if (action === 'insert') {
    await insertFromInputs(element, formId);
  }
}

function authFieldsFor(formId) {
  const form = findForm(formId) || previewForm();
  const inputs = (form?.elements || []).filter((element) => element.type === 'input');
  const find = (pattern) =>
    inputs.find((element) => pattern.test(
      [element.name, element.label, element.column, element.placeholder].join(' ')
    ));
  return {
    login: find(/login|логин|user|пользов/i) || inputs[0] || null,
    password: find(/pass|парол|pwd/i) || inputs[1] || null,
  };
}

function openPostLoginForm(element, user) {
  const roleFormId = roleRouteFormId(element, user?.role);
  const defaultFormId = element?.postLoginForm && findForm(element.postLoginForm)
    ? element.postLoginForm
    : '';
  const target = roleFormId || defaultFormId;
  if (target) {
    renderPreview(target);
    return true;
  }
  goPreviewHome();
  return false;
}

async function authFromForm(action, formId, element) {
  const fields = authFieldsFor(formId);
  const loginNode = fields.login ? previewInputNode(fields.login.id) : null;
  const passwordNode = fields.password ? previewInputNode(fields.password.id) : null;
  const login = loginNode ? String(loginNode.value || '').trim() : '';
  const password = passwordNode ? String(passwordNode.value || '') : '';

  if (!login || !password) {
    toast('Добавьте на форму два поля ввода: логин и пароль, и заполните их.', 'error');
    return;
  }
  if (action === 'register' && password.length < 4) {
    toast('Пароль должен содержать не менее 4 символов.', 'error');
    return;
  }

  try {
    const data = await api(
      action === 'register' ? '/api/auth/register' : '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ login, password }) }
    );
    state.auth = { ...state.auth, authenticated: true, user: data.user };
    updatePreviewAuthChrome();
    if (loginNode) loginNode.value = '';
    if (passwordNode) passwordNode.value = '';
    openPostLoginForm(element, data.user);
    toast(
      (action === 'register' ? 'Аккаунт создан: ' : 'Вы вошли как ') + (data.user?.login || login),
      'success'
    );
  } catch (error) {
    toast(error.message, 'error');
  }
}

function reloadAllPreviewTables(force) {
  const canvas = $('#preview-canvas');
  if (!canvas) return;
  $$('.el-table-body', canvas).forEach((body) => {
    const wrapper = body.closest('[data-id]');
    const element = findElementAnywhere(wrapper?.dataset.id);
    if (element && element.type === 'table') loadTableBody(element, body, 'preview', force);
  });
}

function reloadPreviewTables(table) {
  const canvas = $('#preview-canvas');
  if (!canvas || !table) return;
  $$('.el-table-body', canvas).forEach((body) => {
    const wrapper = body.closest('[data-id]');
    const element = findElementAnywhere(wrapper?.dataset.id);
    if (!element || element.type !== 'table') return;
    const bound = tableFromValue(element.table);
    if (!bound || bound.schema !== table.schema || bound.name !== table.name) return;
    loadTableBody(element, body, 'preview', true);
  });
}

function previewInputNode(elementId) {
  return $('#preview-canvas [data-id="' + elementId + '"] input, ' +
    '#preview-canvas [data-id="' + elementId + '"] textarea, ' +
    '#preview-canvas [data-id="' + elementId + '"] select');
}

async function insertFromInputs(buttonElement, formId) {
  const form = findForm(formId) || previewForm();
  if (!form) return;

  let tableValue = buttonElement.table || '';
  if (!tableValue) {
    const firstBound = form.elements.find((el) => el.type === 'input' && el.table);
    tableValue = firstBound?.table || '';
  }
  const table = tableFromValue(tableValue);
  if (!table) {
    toast('Сначала выберите таблицу для кнопки и привяжите поля к её колонкам.', 'error');
    return;
  }

  const values = {};
  let missing = '';
  let filled = 0;

  form.elements
    .filter((el) => (el.type === 'input' || el.type === 'select') && el.column && sameTableRef(el.table, tableValue))
    .forEach((inputElement) => {
      const node = previewInputNode(inputElement.id);
      const raw = node ? String(node.value).trim() : '';
      if (!raw) {
        if (inputElement.required && !missing) {
          missing = inputElement.label || inputElement.column;
        }
        return;
      }
      filled += 1;
      values[inputElement.column] = raw;
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
      body: JSON.stringify({ schema: table.schema, table: table.name, values }),
    });
    toast('Запись добавлена в «' + table.label + '»', 'success');
    invalidateTable(table);
    reloadPreviewTables(table);

    form.elements
      .filter((el) => (el.type === 'input' || el.type === 'select') && sameTableRef(el.table, tableValue))
      .forEach((inputElement) => {
        const node = previewInputNode(inputElement.id);
        if (node) node.value = '';
      });
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* =========================================================================
   Диалог записи
   ========================================================================= */

const NUMERIC_TYPES = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'money', 'oid']);
const TEXTAREA_TYPES = new Set(['text', 'json', 'jsonb', 'xml']);

function isNumericColumn(column) {
  return NUMERIC_TYPES.has(column.udt_name);
}

function columnHasDefault(column) {
  return column.default != null && String(column.default).trim() !== '';
}

function dialogControl(column, value, disabled, required) {
  const attrs =
    'data-column="' + escapeAttr(column.name) + '"' +
    (disabled ? ' disabled' : '') +
    (required ? ' required' : '');
  const raw = value == null ? '' : String(value);

  if (column.udt_name === 'bool') {
    const isTrue = value === true || value === 'true' || value === 't';
    const isFalse = value === false || value === 'false' || value === 'f';
    let options = '';
    if (column.nullable) {
      options += '<option value=""' + (!isTrue && !isFalse ? ' selected' : '') + '>— не задано —</option>';
    }
    options += '<option value="true"' + (isTrue ? ' selected' : '') + '>Да</option>';
    options += '<option value="false"' + (isFalse ? ' selected' : '') + '>Нет</option>';
    return '<select ' + attrs + '>' + options + '</select>';
  }

  if (TEXTAREA_TYPES.has(column.udt_name)) {
    return '<textarea ' + attrs + '>' + escapeHtml(raw) + '</textarea>';
  }

  if (isNumericColumn(column)) {
    const step = ['int2', 'int4', 'int8', 'oid'].includes(column.udt_name) ? '1' : 'any';
    return '<input ' + attrs + ' type="number" step="' + step + '" value="' + escapeAttr(raw) + '">';
  }

  if (column.udt_name === 'date') {
    return '<input ' + attrs + ' type="date" value="' + escapeAttr(raw.slice(0, 10)) + '">';
  }
  if (column.udt_name === 'time' || column.udt_name === 'timetz') {
    return '<input ' + attrs + ' type="time" value="' + escapeAttr(raw.slice(0, 8)) + '">';
  }
  if (column.udt_name === 'timestamp' || column.udt_name === 'timestamptz') {
    return '<input ' + attrs + ' type="datetime-local" value="' + escapeAttr(raw.slice(0, 16)) + '">';
  }

  return '<input ' + attrs + ' type="text" value="' + escapeAttr(raw) + '">';
}

function openRecordDialog(mode, element, row) {
  const table = tableFromValue(element.table);
  if (!table) {
    toast('Сначала выберите таблицу для этого элемента.', 'error');
    return;
  }

  const dialog = $('#record-dialog');
  const title = $('#dialog-title');
  const fields = $('#dialog-fields');
  const saveButton = $('#dialog-save');

  hideError('#dialog-error');
  saveButton.disabled = false;
  saveButton.textContent = 'Сохранить';
  title.textContent = (mode === 'edit' ? 'Изменить запись' : 'Новая запись') + ' — ' + table.label;

  const parts = [];
  table.columns.forEach((column) => {
    let include = false;
    let disabled = false;

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

    const value = row ? row[column.name] : null;
    const isLong = TEXTAREA_TYPES.has(column.udt_name);
    const full = isLong || column.name.length > 16;
    const required = mode === 'create'
      ? (!column.nullable && !columnHasDefault(column))
      : !column.nullable;
    const note = [
      column.is_pk ? ' 🔑' : '',
      required && !disabled ? ' <em>*</em>' : '',
      mode === 'create' && columnHasDefault(column) ? ' · по умолчанию' : '',
      disabled ? ' · ключ' : '',
    ].join('');
    parts.push(
      '<label class="field' + (full ? ' full' : '') + '">' +
      '<span>' + escapeHtml(column.name) + note + '</span>' +
      dialogControl(column, value, disabled, required) +
      '</label>'
    );
  });

  if (!parts.length) {
    toast('В этой таблице нет полей, доступных для заполнения.', 'error');
    return;
  }

  fields.innerHTML = parts.join('');
  state.dialog = { mode, elementId: element.id, table, row: row || null };

  openDialog('#record-dialog');
}

function showDialogError(message) {
  showError('#dialog-error', message);
}

async function submitRecord(event) {
  event.preventDefault();
  const dialogState = state.dialog;
  if (!dialogState) return;

  const values = {};
  let firstError = '';

  $$('#dialog-fields [data-column]').forEach((control) => {
    if (control.disabled) return;
    const column = dialogState.table.columns.find((item) => item.name === control.dataset.column);
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

    const raw = String(control.value).trim();
    if (!raw) {
      if (dialogState.mode === 'create' && (column.nullable || columnHasDefault(column))) {
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
    showDialogError(firstError);
    return;
  }
  if (!Object.keys(values).length) {
    showDialogError('Заполните хотя бы одно поле записи.');
    return;
  }

  const payload = {
    schema: dialogState.table.schema,
    table: dialogState.table.name,
    values,
  };
  if (dialogState.mode === 'edit' && dialogState.row) {
    const pk = {};
    dialogState.table.primary_key.forEach((column) => {
      pk[column] = dialogState.row[column];
    });
    payload.pk = pk;
  }

  const saveButton = $('#dialog-save');
  hideError('#dialog-error');
  saveButton.disabled = true;
  saveButton.textContent = 'Сохранение…';

  try {
    await api('/api/table/rows', {
      method: dialogState.mode === 'edit' ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    $('#record-dialog').close();
    toast(dialogState.mode === 'edit' ? 'Запись изменена' : 'Запись добавлена', 'success');
    invalidateTable(dialogState.table);
    reloadPreviewTables(dialogState.table);
  } catch (error) {
    showDialogError(error.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Сохранить';
  }
}

async function deleteRecord(element, row) {
  const table = tableFromValue(element.table);
  if (!table || !table.primary_key.length) {
    toast('Удаление недоступно: у таблицы нет первичного ключа.', 'error');
    return;
  }
  if (!confirm('Удалить запись из таблицы «' + table.label + '»?')) return;

  const pk = {};
  table.primary_key.forEach((column) => {
    pk[column] = row[column];
  });

  try {
    await api('/api/table/rows', {
      method: 'DELETE',
      body: JSON.stringify({ schema: table.schema, table: table.name, pk }),
    });
    toast('Запись удалена', 'success');
    invalidateTable(table);
    reloadPreviewTables(table);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function bindDialog() {
  $('#dialog-close').addEventListener('click', () => $('#record-dialog').close());
  $('#dialog-cancel').addEventListener('click', () => $('#record-dialog').close());
  $('#record-form').addEventListener('submit', submitRecord);
  $('#record-dialog').addEventListener('close', () => {
    state.dialog = null;
    hideError('#dialog-error');
    $('#dialog-fields').innerHTML = '';
  });
}

/* =========================================================================
   Редактор таблиц и связей
   ========================================================================= */

function typeOptions(selected) {
  return COLUMN_TYPES.map(([value, label]) =>
    '<option value="' + escapeAttr(value) + '"' +
    (value === selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>'
  ).join('');
}

function defaultOptions(selected) {
  const current = selected === "''" ? '__empty__' : (selected || '');
  return DEFAULT_OPTIONS.map(([value, label]) =>
    '<option value="' + escapeAttr(value) + '"' +
    (value === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>'
  ).join('');
}

function fillTypeSelect(select, selected) {
  if (select) select.innerHTML = typeOptions(selected || 'text');
}

function fillDefaultSelect(select, selected) {
  if (select) select.innerHTML = defaultOptions(selected || '');
}

function dbColumnRow(spec = {}) {
  const data = {
    name: '',
    type: 'text',
    nullable: true,
    primary_key: false,
    unique: false,
    default: '',
    ...spec,
  };
  return (
    '<div class="db-column-row">' +
    '<input data-dcol="name" placeholder="имя колонки" value="' + escapeAttr(data.name) + '">' +
    '<select data-dcol="type">' + typeOptions(data.type) + '</select>' +
    '<select data-dcol="default">' + defaultOptions(data.default) + '</select>' +
    '<label class="db-mini-check" title="Первичный ключ"><input type="checkbox" data-dcol="pk"' +
      (data.primary_key ? ' checked' : '') + '> PK</label>' +
    '<label class="db-mini-check" title="Уникальное"><input type="checkbox" data-dcol="unique"' +
      (data.unique ? ' checked' : '') + '> U</label>' +
    '<label class="db-mini-check" title="Обязательное"><input type="checkbox" data-dcol="notnull"' +
      (data.nullable === false ? ' checked' : '') + '> NN</label>' +
    '<button type="button" class="icon-btn danger" data-remove-column title="Убрать колонку">×</button>' +
    '</div>'
  );
}

function addDbColumnRow(spec = {}) {
  const wrap = $('#db-columns');
  if (!wrap) return;
  wrap.insertAdjacentHTML('beforeend', dbColumnRow(spec));
}

function collectDbColumns() {
  return $$('#db-columns .db-column-row').map((row) => {
    const nameInput = row.querySelector('[data-dcol="name"]');
    const typeSelect = row.querySelector('[data-dcol="type"]');
    const defaultSelect = row.querySelector('[data-dcol="default"]');
    const defaultValue = defaultSelect ? defaultSelect.value : '';
    return {
      name: nameInput ? nameInput.value.trim() : '',
      type: typeSelect ? typeSelect.value : 'text',
      primary_key: !!row.querySelector('[data-dcol="pk"]')?.checked,
      unique: !!row.querySelector('[data-dcol="unique"]')?.checked,
      nullable: !row.querySelector('[data-dcol="notnull"]')?.checked,
      default: defaultValue === '__empty__' ? "''" : defaultValue,
    };
  });
}

function bindDbScreen() {
  $('#db-new-table-btn').addEventListener('click', openDbTableDialog);
  $('#db-new-database-btn').addEventListener('click', openDbDatabaseDialog);
  $('#db-auto-layout-btn').addEventListener('click', autoLayoutDb);
  $('#db-refresh-btn').addEventListener('click', () => refreshSchema({ button: $('#db-refresh-btn') }));
  const cancelLink = $('#db-link-cancel');
  if (cancelLink) cancelLink.addEventListener('click', cancelDbLink);

  $('#db-add-column-row').addEventListener('click', () => addDbColumnRow({}));
  $('#db-columns').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-column]');
    if (!remove) return;
    const row = remove.closest('.db-column-row');
    if (row) row.remove();
  });

  $('#db-table-form').addEventListener('submit', submitDbTable);
  $('#db-column-form').addEventListener('submit', submitDbColumn);
  $('#db-relation-form').addEventListener('submit', submitDbRelation);
  $('#db-database-form').addEventListener('submit', submitDbDatabase);
  $('#db-relation-table').addEventListener('change', updateRelationRefColumns);

  $('#db-screen').addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const link = event.target.closest('[data-er-link]');
    if (link) {
      const card = link.closest('.db-card');
      if (card) {
        event.preventDefault();
        event.stopPropagation();
        startDbLink(card.dataset.schema, card.dataset.table, link.dataset.erLink);
      }
      return;
    }
    const column = event.target.closest('[data-er-col]');
    if (column && state.dbLink) {
      const card = column.closest('.db-card');
      if (card) {
        event.preventDefault();
        event.stopPropagation();
        completeDbLink(card.dataset.schema, card.dataset.table, column.dataset.erCol);
      }
      return;
    }
    const head = event.target.closest('.db-card-head');
    if (head && !event.target.closest('button')) {
      beginErCardDrag(event, head.closest('.db-card'));
    }
  });

  $('#db-screen').addEventListener('click', (event) => {
    const relationItem = event.target.closest('[data-focus-rel]');
    if (relationItem && !event.target.closest('button')) {
      highlightRelation(relationItem.dataset.focusRel);
      return;
    }

    const actionNode = event.target.closest('[data-db-act]');
    if (actionNode) {
      const action = actionNode.dataset.dbAct;
      if (action === 'drop-relation') {
        dropDbRelation(
          actionNode.dataset.relSchema,
          actionNode.dataset.relTable,
          actionNode.dataset.relName
        );
        return;
      }
      const container = actionNode.closest('.db-card') || actionNode.closest('[data-schema][data-table]');
      if (!container) return;
      const schema = container.dataset.schema;
      const table = container.dataset.table;
      if (action === 'add-column') openDbColumnDialog(schema, table);
      else if (action === 'add-relation') openDbRelationDialog(schema, table);
      else if (action === 'drop-table') dropDbTable(schema, table);
      else if (action === 'drop-column') dropDbColumn(schema, table, actionNode.dataset.column);
      return;
    }

    const item = event.target.closest('[data-db-table-item]');
    if (item) focusDbCard(item.dataset.schema, item.dataset.table);
  });
}

/* =========================================================================
   Функции, процедуры и триггеры
   ========================================================================= */

const ROUTINE_KIND_LABELS = {
  function: 'функция',
  procedure: 'процедура',
  trigger: 'триггер',
};

let routineDefinitionToken = 0;

function routinesListFor(kind) {
  if (kind === 'function') return state.routines.functions;
  if (kind === 'procedure') return state.routines.procedures;
  if (kind === 'trigger') return state.routines.triggers;
  return [];
}

function findRoutine(kind, oid) {
  return routinesListFor(kind).find((item) => String(item.oid) === String(oid)) || null;
}

function selectedRoutine() {
  const selected = state.routines.selected;
  if (!selected) return null;
  const item = findRoutine(selected.kind, selected.oid);
  return item ? { kind: selected.kind, item } : null;
}

function routineSubtitle(kind, item) {
  if (kind === 'trigger') {
    const parts = [
      item.timing,
      item.events,
      'ON ' + (item.table_schema || 'public') + '.' + (item.table_name || ''),
    ].filter(Boolean);
    if (item.enabled === false) parts.push('выключен');
    return parts.join(' ');
  }
  let text = '(' + (item.arguments || '') + ')';
  if (kind === 'function' && item.result) text += ' → ' + item.result;
  return text;
}

function renderRoutineList(kind, listSelector, countSelector) {
  const list = $(listSelector);
  if (!list) return;
  const items = routinesListFor(kind);
  const count = $(countSelector);
  if (count) count.textContent = String(items.length);

  if (!items.length) {
    const emptyText = kind === 'function'
      ? 'Функций пока нет.'
      : kind === 'procedure'
        ? 'Процедур пока нет.'
        : 'Триггеров пока нет.';
    list.innerHTML = '<div class="empty-small">' + emptyText + '</div>';
    return;
  }

  const selected = state.routines.selected;
  list.innerHTML = items
    .map((item) => {
      const isSelected =
        selected &&
        selected.kind === kind &&
        String(selected.oid) === String(item.oid);
      const shortKind = kind === 'function' ? 'fn' : kind === 'procedure' ? 'proc' : 'trg';
      return (
        '<div class="routines-item' + (isSelected ? ' active' : '') + '"' +
        ' role="button" tabindex="0"' +
        ' data-routine-kind="' + escapeAttr(kind) + '"' +
        ' data-routine-oid="' + escapeAttr(item.oid) + '"' +
        ' title="' + escapeAttr('Определение ' + item.schema + '.' + item.name) + '">' +
        '<div class="routines-item-head">' +
        '<b>' + escapeHtml(item.schema) + '.' + escapeHtml(item.name) + '</b>' +
        '<span class="routines-item-kind">' + escapeHtml(shortKind) + '</span>' +
        '</div>' +
        '<div class="routines-item-meta">' + escapeHtml(routineSubtitle(kind, item)) + '</div>' +
        '</div>'
      );
    })
    .join('');
}

function updateRoutineSelected() {
  const box = $('#routines-selected');
  const drop = $('#routines-drop-btn');
  const found = selectedRoutine();

  if (!found) {
    state.routines.selected = null;
    if (box) {
      box.hidden = true;
      box.innerHTML = '';
    }
    if (drop) drop.disabled = true;
    return;
  }

  const { kind, item } = found;
  if (box) {
    box.innerHTML =
      '<span class="routines-selected-kind">' + escapeHtml(ROUTINE_KIND_LABELS[kind] || 'объект') + '</span>' +
      '<b>' + escapeHtml(item.schema) + '.' + escapeHtml(item.name) + '</b>' +
      '<span class="routines-selected-meta">' + escapeHtml(routineSubtitle(kind, item)) + '</span>';
    box.hidden = false;
  }
  if (drop) drop.disabled = false;
}

function renderRoutinesScreen() {
  renderRoutineList('function', '#routines-function-list', '#routines-functions-count');
  renderRoutineList('procedure', '#routines-procedure-list', '#routines-procedures-count');
  renderRoutineList('trigger', '#routines-trigger-list', '#routines-triggers-count');
  updateRoutineSelected();
}

function applyRoutinesPayload(data) {
  const source = data && typeof data === 'object' ? data : {};
  state.routines.functions = Array.isArray(source.functions) ? source.functions : [];
  state.routines.procedures = Array.isArray(source.procedures) ? source.procedures : [];
  state.routines.triggers = Array.isArray(source.triggers) ? source.triggers : [];
  state.routines.loaded = true;
  renderRoutinesScreen();
}

async function loadRoutines(options = {}) {
  if (!state.connected || state.routines.loading) return;
  const button = options.button || null;
  const previousText = button ? button.textContent : '';
  state.routines.loading = true;
  if (button) {
    button.disabled = true;
    button.textContent = 'Загрузка…';
  }
  try {
    const data = await api('/api/db/routines');
    applyRoutinesPayload(data);
    if (options.toast) toast('Список объектов обновлён', 'success');
  } catch (error) {
    if (!options.silent) toast('Не удалось загрузить объекты: ' + error.message, 'error');
  } finally {
    state.routines.loading = false;
    if (button) {
      button.disabled = false;
      button.textContent = previousText;
    }
  }
}

function openRoutinesScreen() {
  renderRoutinesScreen();
  if (!state.routines.loaded && !state.routines.loading && state.connected) {
    loadRoutines();
  }
}

async function selectRoutine(kind, oid) {
  const item = findRoutine(kind, oid);
  if (!item) return;
  const token = ++routineDefinitionToken;
  state.routines.selected = { kind, oid: String(item.oid) };
  hideError('#routines-error');
  renderRoutinesScreen();

  const textarea = $('#routines-sql');
  const previous = textarea ? textarea.value : '';
  try {
    const data = await api(
      '/api/db/routines/definition?oid=' +
        encodeURIComponent(item.oid) +
        '&kind=' +
        encodeURIComponent(kind)
    );
    if (token !== routineDefinitionToken) return;
    if (textarea) {
      textarea.value = data.definition || '';
      textarea.focus();
    }
  } catch (error) {
    if (token !== routineDefinitionToken) return;
    if (textarea && previous) textarea.value = previous;
    showError('#routines-error', error.message);
    toast(error.message, 'error');
  }
}

async function executeRoutineCode() {
  const textarea = $('#routines-sql');
  if (!textarea) return;
  const code = textarea.value.trim();
  hideError('#routines-error');
  if (!code) {
    showError('#routines-error', 'Введите SQL-код функции, процедуры или триггера.');
    return;
  }

  const button = $('#routines-execute-btn');
  const previousText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Выполнение…';
  }
  routineDefinitionToken += 1;
  try {
    const data = await api('/api/db/routines/execute', {
      method: 'POST',
      body: JSON.stringify({ sql: textarea.value }),
    });
    applyRoutinesPayload(data);
    toast('Объект создан или обновлён', 'success');
  } catch (error) {
    showError('#routines-error', error.message);
    toast(error.message, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previousText;
    }
  }
}

async function dropRoutine() {
  const found = selectedRoutine();
  if (!found) {
    toast('Выберите функцию, процедуру или триггер для удаления.', 'error');
    return;
  }
  const { kind, item } = found;
  const label = ROUTINE_KIND_LABELS[kind] || 'объект';
  const title = item.schema + '.' + item.name;
  if (!confirm('Удалить ' + label + ' ' + title + '?')) return;

  hideError('#routines-error');
  const button = $('#routines-drop-btn');
  const previousText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Удаление…';
  }
  routineDefinitionToken += 1;
  state.routines.selected = null;
  try {
    const data = await api('/api/db/routines/drop', {
      method: 'POST',
      body: JSON.stringify({ oid: item.oid, kind }),
    });
    applyRoutinesPayload(data);
    toast('Удалено: ' + title, 'success');
  } catch (error) {
    state.routines.selected = { kind, oid: String(item.oid) };
    renderRoutinesScreen();
    showError('#routines-error', error.message);
    toast(error.message, 'error');
  } finally {
    if (button) {
      button.disabled = !selectedRoutine();
      button.textContent = previousText;
    }
  }
}

function applyRoutineTemplate(name) {
  const template = ROUTINE_TEMPLATES[name];
  if (!template) return;
  const textarea = $('#routines-sql');
  if (!textarea) return;
  const current = textarea.value.trim();
  const isTemplate = !current || Object.values(ROUTINE_TEMPLATES).some(
    (value) => value.trim() === current
  );
  if (!isTemplate && !confirm('Заменить текущий SQL шаблоном?')) return;
  textarea.value = template;
  textarea.focus();
  hideError('#routines-error');
  routineDefinitionToken += 1;
  state.routines.selected = null;
  renderRoutinesScreen();
}

function resetRoutinesUi() {
  routineDefinitionToken += 1;
  state.routines.selected = null;
  state.routines.loaded = false;
  const textarea = $('#routines-sql');
  if (textarea) textarea.value = ROUTINE_TEMPLATES.function;
  hideError('#routines-error');
  renderRoutinesScreen();
}

function bindRoutinesScreen() {
  const screen = $('#routines-screen');
  if (!screen) return;

  const refreshButton = $('#routines-refresh-btn');
  if (refreshButton) {
    refreshButton.addEventListener('click', () =>
      loadRoutines({ button: refreshButton, toast: true })
    );
  }

  const executeButton = $('#routines-execute-btn');
  if (executeButton) executeButton.addEventListener('click', executeRoutineCode);

  const dropButton = $('#routines-drop-btn');
  if (dropButton) dropButton.addEventListener('click', dropRoutine);

  const templates = $('#routines-templates');
  if (templates) {
    templates.addEventListener('click', (event) => {
      const button = event.target.closest('[data-routine-template]');
      if (button) applyRoutineTemplate(button.dataset.routineTemplate);
    });
  }

  screen.addEventListener('click', (event) => {
    const item = event.target.closest('[data-routine-kind][data-routine-oid]');
    if (!item) return;
    selectRoutine(item.dataset.routineKind, item.dataset.routineOid);
  });

  screen.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target.closest('[data-routine-kind][data-routine-oid]');
    if (!item) return;
    event.preventDefault();
    selectRoutine(item.dataset.routineKind, item.dataset.routineOid);
  });

  const textarea = $('#routines-sql');
  if (textarea) {
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        executeRoutineCode();
      }
    });
    textarea.addEventListener('input', () => hideError('#routines-error'));
  }
}

function renderDbScreen() {
  renderDbTables();
  renderDbRelations();
  const current = $('#db-current-name');
  if (current) current.textContent = state.db?.database || '—';
  renderDbDiagram();
}

function dbKey(schema, table) {
  return String(schema || 'public') + '.' + String(table || '');
}

function ensureDbLayout() {
  if (!state.project) return false;
  const layout = state.project.db_layout || (state.project.db_layout = {});
  const width = $('#db-diagram')?.clientWidth || 900;
  const cols = Math.max(1, Math.min(4, Math.floor(width / 300)));
  let changed = false;
  state.tables.forEach((table, index) => {
    const key = dbKey(table.schema, table.name);
    if (!layout[key]) {
      layout[key] = {
        x: 24 + (index % cols) * 300,
        y: 24 + Math.floor(index / cols) * 260,
      };
      changed = true;
    }
  });
  const valid = new Set(state.tables.map((table) => dbKey(table.schema, table.name)));
  Object.keys(layout).forEach((key) => {
    if (!valid.has(key)) {
      delete layout[key];
      changed = true;
    }
  });
  return changed;
}

function autoLayoutDb() {
  if (!state.project) return;
  if (!state.tables.length) {
    toast('В базе пока нет таблиц — создайте первую кнопкой «＋ Таблица».', 'error');
    return;
  }
  const layout = state.project.db_layout || (state.project.db_layout = {});
  const width = $('#db-diagram')?.clientWidth || 1000;
  const cols = Math.max(1, Math.min(4, Math.floor(width / 300)));
  state.tables.forEach((table, index) => {
    layout[dbKey(table.schema, table.name)] = {
      x: 24 + (index % cols) * 300,
      y: 24 + Math.floor(index / cols) * 260,
    };
  });
  renderDbDiagram();
  scheduleSave();
  toast('Таблицы разложены автоматически', 'success');
}

function renderDbTables() {
  const list = $('#db-table-list');
  if (!list) return;
  if (!state.tables.length) {
    list.innerHTML = '<div class="empty-small">Таблиц пока нет. Создайте первую.</div>';
    return;
  }
  list.innerHTML = state.tables
    .map(
      (table) => `
      <div class="db-table-item" data-db-table-item data-schema="${escapeAttr(table.schema)}"
           data-table="${escapeAttr(table.name)}" title="Показать таблицу на схеме">
        <span class="db-table-dot"></span>
        <span class="db-table-name">
          <b>${escapeHtml(table.label)}</b>
          <small>${table.columns.length} колонок</small>
        </span>
        <span class="db-item-actions">
          <button type="button" class="db-mini-btn" data-db-act="add-column" title="Добавить колонку">＋</button>
          <button type="button" class="db-mini-btn" data-db-act="add-relation" title="Добавить связь">↗</button>
        </span>
      </div>`
    )
    .join('');
}

function allRelations() {
  const items = [];
  state.tables.forEach((table) => {
    (table.foreign_keys || []).forEach((fk) => {
      items.push({
        schema: table.schema,
        table: table.name,
        label: table.label,
        name: fk.name,
        column: fk.column,
        ref_schema: fk.ref_schema,
        ref_table: fk.ref_table,
        ref_column: fk.ref_column,
      });
    });
  });
  return items;
}

function renderDbRelations() {
  const list = $('#db-relations-list');
  const count = $('#db-relations-count');
  if (!list) return;
  const relations = allRelations();
  if (count) count.textContent = String(relations.length);
  if (!relations.length) {
    list.innerHTML =
      '<div class="empty-small">Связей пока нет. Нажмите ↗ у колонки и выберите колонку другой таблицы.</div>';
    return;
  }
  list.innerHTML = relations
    .map(
      (relation) => `
      <div class="db-relation-item" data-focus-rel="${escapeAttr(relation.name)}" title="Показать линию на схеме">
        <span class="db-relation-text">
          <b>${escapeHtml(relation.label)}.${escapeHtml(relation.column)}</b>
          <span class="db-arrow">→</span>
          <b>${escapeHtml(relation.ref_table)}.${escapeHtml(relation.ref_column)}</b>
        </span>
        <button type="button" class="icon-btn danger" data-db-act="drop-relation"
                data-rel-schema="${escapeAttr(relation.schema)}"
                data-rel-table="${escapeAttr(relation.table)}"
                data-rel-name="${escapeAttr(relation.name)}"
                title="Удалить связь">×</button>
      </div>`
    )
    .join('');
}

function dbCardHtml(table) {
  const key = dbKey(table.schema, table.name);
  const pos = state.project?.db_layout?.[key] || { x: 24, y: 24 };
  const columns = table.columns
    .map((column) => {
      const fk = column.references;
      const flags = [
        column.is_pk ? '<span class="db-badge pk">PK</span>' : '',
        fk ? '<span class="db-badge fk" title="→ ' + escapeAttr(fk.ref_table + '.' + fk.ref_column) + '">FK</span>' : '',
        column.nullable === false ? '<span class="db-badge nn">NN</span>' : '',
      ].join('');
      return (
        '<div class="db-col er-col" data-er-col="' + escapeAttr(column.name) + '">' +
        '<span class="db-col-name">' + escapeHtml(column.name) + '</span>' +
        '<span class="db-col-type">' + escapeHtml(column.data_type) + '</span>' +
        '<span class="db-col-flags">' + flags + '</span>' +
        '<button type="button" class="db-col-link" data-er-link="' + escapeAttr(column.name) +
        '" title="Создать связь: нажмите, затем выберите колонку другой таблицы">↗</button>' +
        '<button type="button" class="db-col-drop" data-db-act="drop-column" data-column="' +
        escapeAttr(column.name) + '" title="Удалить колонку">×</button>' +
        '</div>'
      );
    })
    .join('');

  return (
    '<div class="db-card er-card" data-schema="' + escapeAttr(table.schema) + '" data-table="' +
    escapeAttr(table.name) + '" style="left:' + Math.round(pos.x) + 'px;top:' + Math.round(pos.y) + 'px">' +
    '<div class="db-card-head er-drag" title="Перетащите таблицу">' +
    '<div class="db-card-title"><b>' + escapeHtml(table.label) + '</b>' +
    '<small>' + table.columns.length + ' колонок · перетащите за заголовок</small></div>' +
    '<div class="db-card-actions">' +
    '<button type="button" class="db-mini-btn" data-db-act="add-column" title="Добавить колонку">＋</button>' +
    '<button type="button" class="db-mini-btn" data-db-act="add-relation" title="Создать связь через диалог">↗</button>' +
    '<button type="button" class="db-mini-btn danger" data-db-act="drop-table" title="Удалить таблицу">×</button>' +
    '</div>' +
    '</div>' +
    '<div class="db-card-cols">' + (columns || '<div class="empty-small">Нет колонок</div>') + '</div>' +
    '</div>'
  );
}

function renderDbDiagram() {
  const diagram = $('#db-diagram');
  if (!diagram) return;
  if (!state.tables.length) {
    diagram.innerHTML =
      '<div class="db-empty-state"><b>В базе пока нет таблиц</b>' +
      'Нажмите «＋ Таблица», чтобы создать первую. Связи появятся на схеме линиями.' +
      '</div>';
    return;
  }
  ensureDbLayout();
  const relations = allRelations();
  diagram.innerHTML =
    '<svg class="er-lines" id="er-lines" aria-hidden="true"></svg>' +
    state.tables.map(dbCardHtml).join('') +
    (relations.length
      ? ''
      : '<div class="er-empty-hint">Связей пока нет: нажмите ↗ у колонки, затем колонку другой таблицы.</div>');
  requestAnimationFrame(() => {
    drawErLines();
    updateDbLinkUi();
  });
}

function erColumnCenter(card, columnName) {
  const column = Array.from(card.querySelectorAll('[data-er-col]'))
    .find((node) => node.dataset.erCol === String(columnName));
  if (!column) return null;
  return {
    x: card.offsetLeft + card.offsetWidth,
    left: card.offsetLeft,
    y: card.offsetTop + column.offsetTop + column.offsetHeight / 2,
  };
}

function drawErLines() {
  const diagram = $('#db-diagram');
  const svg = $('#er-lines');
  if (!diagram || !svg) return;

  const cards = new Map();
  $$('#db-diagram .db-card').forEach((card) => {
    cards.set(dbKey(card.dataset.schema, card.dataset.table), card);
  });

  const width = Math.max(
    diagram.clientWidth,
    ...$$('#db-diagram .db-card').map((card) => card.offsetLeft + card.offsetWidth + 80)
  );
  const height = Math.max(
    diagram.clientHeight,
    ...$$('#db-diagram .db-card').map((card) => card.offsetTop + card.offsetHeight + 80)
  );
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  svg.style.width = width + 'px';
  svg.style.height = height + 'px';

  let body =
    '<defs><marker id="er-arrow" viewBox="0 0 10 10" refX="9" refY="5" ' +
    'markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M 0 0 L 10 5 L 0 10 z" fill="#7c8db5"/></marker></defs>';

  allRelations().forEach((relation) => {
    const source = cards.get(dbKey(relation.schema, relation.table));
    const target = cards.get(dbKey(relation.ref_schema, relation.ref_table));
    if (!source || !target) return;
    const from = erColumnCenter(source, relation.column);
    const to = erColumnCenter(target, relation.ref_column);
    if (!from || !to) return;

    const x1 = from.x;
    const y1 = from.y;
    const x2 = to.left;
    const y2 = to.y;
    const bend = Math.max(32, Math.abs(x2 - x1) / 2);
    const path =
      'M ' + x1 + ' ' + y1 +
      ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2;
    body +=
      '<path class="er-path" data-rel-name="' + escapeAttr(relation.name) + '" d="' + path +
      '" marker-end="url(#er-arrow)"><title>' +
      escapeHtml(relation.label + '.' + relation.column + ' → ' + relation.ref_table + '.' + relation.ref_column) +
      '</title></path>' +
      '<circle class="er-dot" cx="' + x1 + '" cy="' + y1 + '" r="3"></circle>' +
      '<circle class="er-dot" cx="' + x2 + '" cy="' + y2 + '" r="3"></circle>';
  });

  svg.innerHTML = body;
}

function highlightRelation(name) {
  $$('#db-diagram .er-path').forEach((path) => {
    path.classList.toggle('active', path.dataset.relName === name);
  });
  const path = $$('#db-diagram .er-path').find((node) => node.dataset.relName === name);
  if (path) {
    path.classList.add('active');
    setTimeout(() => path.classList.remove('active'), 1600);
  }
}

function focusDbCard(schema, table) {
  const card = $$('#db-diagram .db-card').find(
    (node) => node.dataset.schema === schema && node.dataset.table === table
  );
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1200);
}

/* ---- Перетаскивание таблиц и связи мышью -------------------------------- */

function beginErCardDrag(event, card) {
  if (event.button !== 0) return;
  event.preventDefault();
  const diagram = $('#db-diagram');
  if (!diagram || !card) return;
  const startX = event.clientX;
  const startY = event.clientY;
  const startLeft = card.offsetLeft;
  const startTop = card.offsetTop;
  const grid = 8;
  let moved = false;

  const onMove = (moveEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    const x = Math.max(0, Math.round((startLeft + dx) / grid) * grid);
    const y = Math.max(0, Math.round((startTop + dy) / grid) * grid);
    card.style.left = x + 'px';
    card.style.top = y + 'px';
    drawErLines();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    if (!moved) return;
    const layout = state.project.db_layout || (state.project.db_layout = {});
    layout[dbKey(card.dataset.schema, card.dataset.table)] = {
      x: card.offsetLeft,
      y: card.offsetTop,
    };
    scheduleSave();
  };

  document.body.style.cursor = 'grabbing';
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function startDbLink(schema, table, column) {
  if (state.dbLink &&
      state.dbLink.schema === schema &&
      state.dbLink.table === table &&
      state.dbLink.column === column) {
    cancelDbLink();
    return;
  }
  state.dbLink = { schema, table, column };
  updateDbLinkUi();
  toast('Выберите колонку в другой таблице, чтобы создать связь', 'info');
}

function cancelDbLink() {
  state.dbLink = null;
  updateDbLinkUi();
}

function updateDbLinkUi() {
  const hint = $('#db-link-hint');
  const link = state.dbLink;
  if (hint) {
    hint.hidden = !link;
    if (link) {
      hint.innerHTML =
        '<b>Связь:</b> ' + escapeHtml(link.table + '.' + link.column) +
        ' → выберите колонку-цель в другой таблице.' +
        ' <button type="button" id="db-link-cancel" class="btn btn-ghost btn-sm">Отмена</button>';
      const cancel = $('#db-link-cancel');
      if (cancel) cancel.addEventListener('click', cancelDbLink);
    }
  }
  $$('#db-diagram .db-card').forEach((card) => {
    card.classList.toggle('linking', !!link);
    card.classList.toggle(
      'link-source',
      !!link && card.dataset.schema === link.schema && card.dataset.table === link.table
    );
  });
  $$('#db-diagram .er-col').forEach((column) => {
    column.classList.toggle('link-ready', !!link);
  });
}

async function completeDbLink(schema, table, column) {
  const source = state.dbLink;
  if (!source) return;
  if (source.schema === schema && source.table === table && source.column === column) {
    toast('Выберите колонку в другой таблице или другую колонку этой же таблицы.', 'error');
    return;
  }
  cancelDbLink();
  try {
    const data = await api('/api/db/tables/relations/add', {
      method: 'POST',
      body: JSON.stringify({
        schema: source.schema,
        table: source.table,
        column: source.column,
        ref_schema: schema,
        ref_table: table,
        ref_column: column,
        on_delete: 'NO ACTION',
      }),
    });
    applyTables(data.tables);
    renderDbScreen();
    toast('Связь ' + source.table + '.' + source.column + ' → ' + table + '.' + column + ' создана', 'success');
  } catch (error) {
    toast('Не удалось создать связь: ' + error.message, 'error');
  }
}

/* ---- Диалоги редактора базы --------------------------------------------- */

function openDbTableDialog() {
  $('#db-table-name').value = '';
  $('#db-columns').innerHTML = '';
  addDbColumnRow({ name: 'id', type: 'serial', primary_key: true, nullable: false });
  addDbColumnRow({ name: 'name', type: 'text', nullable: true });
  hideError('#db-table-error');
  openDialog('#db-table-dialog');
  setTimeout(() => $('#db-table-name')?.focus(), 30);
}

async function submitDbTable(event) {
  event.preventDefault();
  hideError('#db-table-error');
  const name = $('#db-table-name').value.trim();
  const schema = 'public';
  const columns = collectDbColumns();

  if (!name) {
    showError('#db-table-error', 'Укажите имя таблицы.');
    return;
  }
  if (!columns.length) {
    showError('#db-table-error', 'Добавьте хотя бы одну колонку.');
    return;
  }
  if (columns.some((column) => !column.name)) {
    showError('#db-table-error', 'У каждой колонки должно быть имя.');
    return;
  }

  const button = $('#db-table-form button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const data = await api('/api/db/tables', {
      method: 'POST',
      body: JSON.stringify({ schema, name, columns }),
    });
    applyTables(data.tables);
    closeDialog('#db-table-dialog');
    renderDbScreen();
    toast('Таблица «' + name + '» создана', 'success');
  } catch (error) {
    showError('#db-table-error', error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function openDbColumnDialog(schema, table) {
  const found = state.tables.find((item) => item.schema === schema && item.name === table);
  state.dbColumnContext = { schema, table };
  $('#db-column-title').textContent = 'Новая колонка — ' + (found?.label || table);
  $('#db-column-name').value = '';
  fillTypeSelect($('#db-column-type'), 'text');
  fillDefaultSelect($('#db-column-default'), '');
  $('#db-column-notnull').checked = false;
  $('#db-column-unique').checked = false;
  hideError('#db-column-error');
  openDialog('#db-column-dialog');
  setTimeout(() => $('#db-column-name')?.focus(), 30);
}

async function submitDbColumn(event) {
  event.preventDefault();
  hideError('#db-column-error');
  const context = state.dbColumnContext;
  if (!context) return;
  const name = $('#db-column-name').value.trim();
  if (!name) {
    showError('#db-column-error', 'Укажите имя колонки.');
    return;
  }
  const defaultSelect = $('#db-column-default').value;
  const column = {
    name,
    type: $('#db-column-type').value,
    primary_key: false,
    unique: $('#db-column-unique').checked,
    nullable: !$('#db-column-notnull').checked,
    default: defaultSelect === '__empty__' ? "''" : defaultSelect,
  };

  const button = $('#db-column-form button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const data = await api('/api/db/tables/columns/add', {
      method: 'POST',
      body: JSON.stringify({ schema: context.schema, table: context.table, column }),
    });
    applyTables(data.tables);
    closeDialog('#db-column-dialog');
    renderDbScreen();
    toast('Колонка «' + name + '» добавлена', 'success');
  } catch (error) {
    showError('#db-column-error', error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function openDbRelationDialog(schema, table) {
  const found = state.tables.find((item) => item.schema === schema && item.name === table);
  if (!found) return;
  state.dbRelationContext = { schema, table };
  $('#db-relation-title').textContent = 'Новая связь — ' + found.label;

  $('#db-relation-column').innerHTML = found.columns
    .map((column) =>
      '<option value="' + escapeAttr(column.name) + '">' + escapeHtml(column.name) +
      ' · ' + escapeHtml(column.data_type) + (column.is_pk ? ' 🔑' : '') + '</option>'
    )
    .join('');

  const targets = state.tables.filter((item) => !(item.schema === schema && item.name === table));
  const targetList = targets.length ? targets : state.tables;
  $('#db-relation-table').innerHTML = targetList
    .map((item) =>
      '<option value="' + escapeAttr(tableRefOf(item)) + '">' + escapeHtml(item.label) + '</option>'
    )
    .join('');

  updateRelationRefColumns();
  hideError('#db-relation-error');
  openDialog('#db-relation-dialog');
}

function updateRelationRefColumns() {
  const select = $('#db-relation-ref-column');
  if (!select) return;
  const target = tableFromValue($('#db-relation-table').value);
  if (!target) {
    select.innerHTML = '<option value="">— нет таблицы —</option>';
    return;
  }
  select.innerHTML = target.columns
    .map((column) =>
      '<option value="' + escapeAttr(column.name) + '">' + escapeHtml(column.name) +
      ' · ' + escapeHtml(column.data_type) + (column.is_pk ? ' 🔑' : '') + '</option>'
    )
    .join('');
}

async function submitDbRelation(event) {
  event.preventDefault();
  hideError('#db-relation-error');
  const context = state.dbRelationContext;
  const target = tableFromValue($('#db-relation-table').value);
  if (!context || !target) {
    showError('#db-relation-error', 'Выберите таблицу-цель.');
    return;
  }
  const payload = {
    schema: context.schema,
    table: context.table,
    column: $('#db-relation-column').value,
    ref_schema: target.schema,
    ref_table: target.name,
    ref_column: $('#db-relation-ref-column').value,
    on_delete: $('#db-relation-on-delete').value,
  };

  const button = $('#db-relation-form button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const data = await api('/api/db/tables/relations/add', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    applyTables(data.tables);
    closeDialog('#db-relation-dialog');
    renderDbScreen();
    toast('Связь создана', 'success');
  } catch (error) {
    showError('#db-relation-error', error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function openDbDatabaseDialog() {
  $('#db-database-name').value = '';
  hideError('#db-database-error');
  openDialog('#db-database-dialog');
  setTimeout(() => $('#db-database-name')?.focus(), 30);
}

async function submitDbDatabase(event) {
  event.preventDefault();
  hideError('#db-database-error');
  const name = $('#db-database-name').value.trim();
  if (!name) {
    showError('#db-database-error', 'Укажите имя базы данных.');
    return;
  }
  const button = $('#db-database-form button[type="submit"]');
  if (button) button.disabled = true;
  try {
    await api('/api/database/create', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    closeDialog('#db-database-dialog');
    toast('База «' + name + '» создана. Она появится в списке при следующем подключении.', 'success');
  } catch (error) {
    showError('#db-database-error', error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function dropDbTable(schema, table) {
  if (!confirm('Удалить таблицу «' + table + '»? Все данные будут потеряны.')) return;
  try {
    const data = await api('/api/db/tables/drop', {
      method: 'POST',
      body: JSON.stringify({ schema, table }),
    });
    applyTables(data.tables);
    renderDbScreen();
    toast('Таблица удалена', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function dropDbColumn(schema, table, column) {
  if (!confirm('Удалить колонку «' + column + '» из таблицы «' + table + '»?')) return;
  try {
    const data = await api('/api/db/tables/columns/drop', {
      method: 'POST',
      body: JSON.stringify({ schema, table, column }),
    });
    applyTables(data.tables);
    renderDbScreen();
    toast('Колонка удалена', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function dropDbRelation(schema, table, name) {
  if (!confirm('Удалить связь «' + name + '»?')) return;
  try {
    const data = await api('/api/db/tables/relations/drop', {
      method: 'POST',
      body: JSON.stringify({ schema, table, name }),
    });
    applyTables(data.tables);
    renderDbScreen();
    toast('Связь удалена', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* =========================================================================
   Авторизация приложения
   ========================================================================= */

function authConfigured() {
  const auth = authConfig();
  return Boolean(auth.table && auth.login_column && auth.password_column);
}

function authTableSelectOptions(selectedRef) {
  let html = '<option value="">— выберите таблицу —</option>';
  let found = !selectedRef;
  state.tables.forEach((table) => {
    const ref = tableRefOf(table);
    if (ref === selectedRef) found = true;
    html += '<option value="' + escapeAttr(ref) + '"' +
      (ref === selectedRef ? ' selected' : '') + '>' + escapeHtml(table.label) + '</option>';
  });
  if (!found && selectedRef) {
    html += '<option value="' + escapeAttr(selectedRef) + '" selected>⚠ привязка потеряна</option>';
  }
  return html;
}

function fillAuthColumnSelect(select, table, selected, allowEmpty) {
  if (!select) return;
  if (!table) {
    select.innerHTML = '<option value="">— сначала выберите таблицу —</option>';
    return;
  }
  let html = allowEmpty ? '<option value="">— нет —</option>' : '<option value="">— выберите —</option>';
  table.columns.forEach((column) => {
    html += '<option value="' + escapeAttr(column.name) + '"' +
      (column.name === selected ? ' selected' : '') + '>' +
      escapeHtml(column.name) + ' · ' + escapeHtml(column.data_type) + '</option>';
  });
  if (selected && !table.columns.some((column) => column.name === selected)) {
    html += '<option value="' + escapeAttr(selected) + '" selected>⚠ ' + escapeHtml(selected) + '</option>';
  }
  select.innerHTML = html;
}

function renderAuthStatusLine() {
  let line = $('#auth-status-line');
  if (!line) {
    line = document.createElement('div');
    line.id = 'auth-status-line';
    line.className = 'prop-hint';
    const card = $('#auth-screen .auth-card');
    const grid = card?.querySelector('.auth-grid');
    if (card && grid) card.insertBefore(line, grid);
    else if (card) card.appendChild(line);
  }
  const auth = authConfig();
  if (authConfigured()) {
    line.classList.remove('warn');
    line.innerHTML =
      'Авторизация подключена к таблице <b>' + escapeHtml(auth.table) + '</b>. ' +
      'Вход запрашивается перед открытием предпросмотра, ' +
      'если включён переключатель выше.';
  } else {
    line.classList.add('warn');
    line.textContent =
      'Выберите таблицу пользователей и колонки логина и пароля. ' +
      'Или создайте готовую таблицу кнопкой справа.';
  }
  const setupButton = $('#auth-setup-btn');
  if (setupButton) {
    setupButton.textContent = authConfigured()
      ? 'Пересоздать таблицу пользователей'
      : 'Создать таблицу пользователей';
  }
  decorateHints(line);
}

function renderAuthScreen() {
  if (!state.project) return;
  const auth = authConfig();
  const enabled = $('#auth-screen [data-auth-prop="enabled"]');
  if (enabled) enabled.checked = auth.enabled;
  const allowRegistration = $('#auth-screen [data-auth-prop="allow_registration"]');
  if (allowRegistration) allowRegistration.checked = auth.allow_registration !== false;

  const title = $('#auth-screen [data-auth-prop="title"]');
  if (title) title.value = auth.title;
  const welcome = $('#auth-screen [data-auth-prop="welcome"]');
  if (welcome) welcome.value = auth.welcome;

  const selectedRef = auth.table ? tableRefOfParts(auth.schema, auth.table) : '';
  const tableSelect = $('#auth-screen [data-auth-prop="table"]');
  if (tableSelect) tableSelect.innerHTML = authTableSelectOptions(selectedRef);

  const table = auth.table
    ? state.tables.find((item) => item.schema === auth.schema && item.name === auth.table)
    : null;
  fillAuthColumnSelect($('#auth-screen [data-auth-prop="login_column"]'), table, auth.login_column, false);
  fillAuthColumnSelect($('#auth-screen [data-auth-prop="password_column"]'), table, auth.password_column, false);
  fillAuthColumnSelect($('#auth-screen [data-auth-prop="role_column"]'), table, auth.role_column, true);

  const mode = $('#auth-screen [data-auth-prop="password_mode"]');
  if (mode) mode.value = auth.password_mode;

  const setupButton = $('#auth-setup-btn');
  if (setupButton) {
    setupButton.textContent = authConfigured()
      ? 'Пересоздать таблицу пользователей'
      : 'Создать таблицу пользователей';
  }

  renderAuthStatusLine();
  renderAuthUsers();
}

function bindAuthScreen() {
  const screen = $('#auth-screen');
  if (!screen) return;

  screen.addEventListener('input', (event) => {
    const field = event.target.closest('[data-auth-prop]');
    if (!field) return;
    const prop = field.dataset.authProp;
    const auth = authConfig();

    if (prop === 'enabled') {
      auth.enabled = field.checked;
    } else if (prop === 'allow_registration') {
      auth.allow_registration = field.checked;
    } else if (prop === 'table') {
      const table = tableFromValue(field.value);
      auth.schema = table ? table.schema : 'public';
      auth.table = table ? table.name : '';
      auth.login_column = '';
      auth.password_column = '';
      auth.role_column = '';
      renderAuthScreen();
      scheduleSave();
      return;
    } else {
      auth[prop] = field.value;
    }

    renderAuthStatusLine();
    if (prop === 'enabled') renderAuthUsers();
    scheduleSave();
  });

  $('#auth-setup-btn').addEventListener('click', openAuthSetup);
  $('#auth-refresh-users-btn').addEventListener('click', () => loadAuthUsers());
  $('#auth-setup-form').addEventListener('submit', submitAuthSetup);
  $('#auth-add-user-form').addEventListener('submit', submitAuthUser);

  screen.addEventListener('change', (event) => {
    if (!event.target.closest('select[data-auth-prop]')) return;
    if (authConfigured()) loadAuthUsers();
  });

  $('#auth-users').addEventListener('click', (event) => {
    const reset = event.target.closest('[data-user-reset]');
    if (reset) {
      resetAuthUser(reset.dataset.userReset);
      return;
    }
    const remove = event.target.closest('[data-user-delete]');
    if (remove) deleteAuthUser(remove.dataset.userDelete);
  });
}

async function loadAuthUsers() {
  if (!authConfigured()) {
    state.authUsers = [];
    renderAuthUsers();
    return;
  }
  try {
    const data = await api('/api/auth/users');
    state.authUsers = Array.isArray(data.users) ? data.users : [];
    renderAuthUsers();
  } catch (error) {
    state.authUsers = [];
    const list = $('#auth-users');
    if (list) list.innerHTML = '<div class="empty-small">' + escapeHtml(error.message) + '</div>';
  }
}

function renderAuthUsers() {
  const list = $('#auth-users');
  if (!list) return;
  const form = $('#auth-add-user-form');
  if (!authConfigured()) {
    list.innerHTML = '<div class="empty-small">Сначала настройте таблицу пользователей.</div>';
    if (form) form.hidden = true;
    return;
  }
  if (form) form.hidden = false;
  if (!state.authUsers.length) {
    list.innerHTML = '<div class="empty-small">Пользователей пока нет. Добавьте первого ниже.</div>';
    return;
  }
  list.innerHTML = state.authUsers
    .map(
      (user) => `
      <div class="auth-user-row">
        <span class="auth-user-name">${escapeHtml(user.login)}</span>
        <span class="auth-user-role">${escapeHtml(user.role || '—')}</span>
        <span class="auth-user-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-user-reset="${escapeAttr(user.login)}">Пароль</button>
          <button type="button" class="btn btn-danger btn-sm" data-user-delete="${escapeAttr(user.login)}">Удалить</button>
        </span>
      </div>`
    )
    .join('');
}

async function submitAuthUser(event) {
  event.preventDefault();
  hideError('#auth-user-error');
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());
  const login = String(data.login || '').trim();
  const password = String(data.password || '');
  if (!login || !password) {
    showError('#auth-user-error', 'Укажите логин и пароль.');
    return;
  }
  if (login.length < 3) {
    showError('#auth-user-error', 'Логин должен содержать не менее 3 символов.');
    return;
  }
  if (password.length < 4) {
    showError('#auth-user-error', 'Пароль должен содержать не менее 4 символов.');
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    await api('/api/auth/users', {
      method: 'POST',
      body: JSON.stringify({ login, password, role: String(data.role || 'user') }),
    });
    form.reset();
    form.querySelector('[name="role"]').value = 'user';
    await loadAuthUsers();
    toast('Пользователь «' + login + '» добавлен', 'success');
  } catch (error) {
    showError('#auth-user-error', error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function resetAuthUser(login) {
  const password = prompt('Новый пароль для «' + login + '»', '');
  if (password == null || !password) return;
  try {
    await api('/api/auth/users', {
      method: 'PUT',
      body: JSON.stringify({ login, password }),
    });
    toast('Пароль обновлён', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteAuthUser(login) {
  if (!confirm('Удалить пользователя «' + login + '»?')) return;
  try {
    await api('/api/auth/users', {
      method: 'DELETE',
      body: JSON.stringify({ login }),
    });
    await loadAuthUsers();
    toast('Пользователь удалён', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openAuthSetup() {
  const auth = authConfig();
  $('#auth-setup-table').value = auth.table || 'app_users';
  $('#auth-setup-login').value = auth.login_column || 'login';
  $('#auth-setup-password').value = auth.password_column || 'password';
  $('#auth-setup-role').value = auth.role_column || 'role';
  $('#auth-setup-mode').value = auth.password_mode || 'sha256';
  $('#auth-setup-admin-login').value = 'admin';
  $('#auth-setup-admin-password').value = '';
  hideError('#auth-setup-error');
  openDialog('#auth-setup-dialog');
  setTimeout(() => $('#auth-setup-admin-password')?.focus(), 30);
}

async function submitAuthSetup(event) {
  event.preventDefault();
  hideError('#auth-setup-error');
  const payload = {
    schema: 'public',
    table: $('#auth-setup-table').value.trim() || 'app_users',
    login_column: $('#auth-setup-login').value.trim() || 'login',
    password_column: $('#auth-setup-password').value.trim() || 'password',
    role_column: $('#auth-setup-role').value.trim() || 'role',
    password_mode: $('#auth-setup-mode').value,
    admin_login: $('#auth-setup-admin-login').value.trim() || 'admin',
    admin_password: $('#auth-setup-admin-password').value,
  };
  if (!payload.admin_password) {
    showError('#auth-setup-error', 'Придумайте пароль администратора.');
    return;
  }
  if (payload.admin_password.length < 4) {
    showError('#auth-setup-error', 'Пароль администратора должен содержать не менее 4 символов.');
    return;
  }
  if (payload.admin_login.length < 3) {
    showError('#auth-setup-error', 'Логин администратора должен содержать не менее 3 символов.');
    return;
  }

  const button = $('#auth-setup-form button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const data = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.project.auth = normalizeAuth(data.config);
    applyTables(data.tables);
    closeDialog('#auth-setup-dialog');
    renderAuthScreen();
    await loadAuthUsers();
    scheduleSave();
    toast('Таблица пользователей готова', 'success');
  } catch (error) {
    showError('#auth-setup-error', error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

/* =========================================================================
   Диалог проекта
   ========================================================================= */

function bindProjectDialog() {
  $('#project-name').addEventListener('input', (event) => {
    if (!state.project) return;
    state.project.name = String(event.target.value || '').slice(0, 120);
    scheduleSave();
  });

  $('#project-grid').addEventListener('input', (event) => {
    if (!state.project) return;
    state.project.settings.grid = clamp(Math.round(num(event.target.value, GRID_DEFAULT)), 2, 64);
    syncSettingsUi();
    scheduleSave();
  });

  $('#project-snap').addEventListener('change', (event) => {
    if (!state.project) return;
    state.project.settings.snap = event.target.checked;
    syncSettingsUi();
    scheduleSave();
  });

  $('#project-show-grid').addEventListener('change', (event) => {
    if (!state.project) return;
    state.project.settings.show_grid = event.target.checked;
    syncSettingsUi();
    scheduleSave();
  });

  $('#project-download-btn').addEventListener('click', downloadCurrentProject);
  const exportHtml = $('#project-export-html-btn');
  if (exportHtml) exportHtml.addEventListener('click', downloadStandalonePreview);
  const exportApp = $('#project-export-app-btn');
  if (exportApp) exportApp.addEventListener('click', downloadPortableApp);
  $('#project-import-btn').addEventListener('click', () => $('#project-file-input').click());
  $('#project-file-input').addEventListener('change', importProjectFile);
  $('#project-save-as-btn').addEventListener('click', saveAsProject);
  $('#project-new-btn').addEventListener('click', newProject);

  $('#project-library').addEventListener('click', (event) => {
    const open = event.target.closest('[data-project-open]');
    if (open) {
      openLibraryProject(open.dataset.projectOpen);
      return;
    }
    const download = event.target.closest('[data-project-download]');
    if (download) {
      downloadLibraryProject(download.dataset.projectDownload);
      return;
    }
    const remove = event.target.closest('[data-project-delete]');
    if (remove) deleteLibraryProject(remove.dataset.projectDelete);
  });
}

function syncProjectDialog() {
  if (!state.project) return;
  const name = $('#project-name');
  if (name) name.value = state.project.name || '';
  const grid = $('#project-grid');
  if (grid) grid.value = gridSize();
  const snap = $('#project-snap');
  if (snap) snap.checked = snapEnabled();
  const show = $('#project-show-grid');
  if (show) show.checked = showGridEnabled();
}

function openProjectDialog() {
  if (!state.project) return;
  syncProjectDialog();
  hideError('#project-error');
  openDialog('#project-dialog');
  loadProjectLibrary();
}

async function loadProjectLibrary() {
  const list = $('#project-library');
  if (!list) return;
  list.innerHTML = '<div class="empty-small">Загрузка…</div>';
  try {
    const data = await api('/api/projects');
    const projects = Array.isArray(data.projects) ? data.projects : [];
    if (!projects.length) {
      list.innerHTML = '<div class="empty-small">Сохранённых проектов пока нет.</div>';
      return;
    }
    list.innerHTML = projects
      .map((project) => {
        const date = project.modified ? new Date(project.modified).toLocaleString('ru-RU') : '';
        return (
          '<div class="project-item' + (project.current ? ' current' : '') + '">' +
          '<div class="project-info">' +
          '<b>' + escapeHtml(project.name) + '</b>' +
          '<small>' + escapeHtml(project.database || '—') + ' · ' + project.forms +
          ' форм · ' + escapeHtml(date) + '</small>' +
          '<small class="project-file">' + escapeHtml(project.file) + '</small>' +
          '</div>' +
          '<div class="project-actions">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-project-open="' +
          escapeAttr(project.file) + '"' + (project.current ? ' disabled' : '') + '>Открыть</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-project-download="' +
          escapeAttr(project.file) + '" title="Скачать файл">⇩</button>' +
          '<button type="button" class="btn btn-danger btn-sm" data-project-delete="' +
          escapeAttr(project.file) + '"' + (project.current ? ' disabled' : '') + '>Удалить</button>' +
          '</div>' +
          '</div>'
        );
      })
      .join('');
  } catch (error) {
    list.innerHTML = '<div class="empty-small">' + escapeHtml(error.message) + '</div>';
  }
}

async function downloadStandalonePreview() {
  if (!state.project) {
    toast('Сначала подключитесь к базе и откройте проект.', 'error');
    return;
  }
  try {
    await flushSave();
  } catch (error) {
    // ошибка сохранения уже показана; экспортируем текущее состояние
  }
  try {
    const response = await fetch('/api/preview/export', { credentials: 'same-origin' });
    if (!response.ok) {
      let message = 'Не удалось создать HTML-предпросмотр.';
      try {
        const data = await response.json();
        if (data && data.error) message = data.error;
      } catch (error) {
        // ответ не JSON
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const safe = String(state.project.name || state.db?.database || 'preview')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 60) || 'preview';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safe + '.preview.html';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Автономный HTML скачан. Откройте его двойным кликом.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function downloadPortableApp() {
  if (!state.project) {
    toast('Сначала подключитесь к базе и откройте проект.', 'error');
    return;
  }
  try {
    await flushSave();
  } catch (error) {
    // ошибка сохранения уже показана; соберём архив из текущего состояния
  }
  try {
    const response = await fetch('/api/app/export', { credentials: 'same-origin' });
    if (!response.ok) {
      let message = 'Не удалось собрать приложение.';
      try {
        const data = await response.json();
        if (data && data.error) message = data.error;
      } catch (error) {
        // ответ не JSON
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const safe = String(state.project.name || state.db?.database || 'app')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 60) || 'app';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safe + '.app.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(
      'Приложение скачано. Распакуйте архив и запустите run.bat (или run.sh).',
      'success'
    );
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function downloadBlob(url, filename) {
  const response = await fetch(url);
  if (!response.ok) {
    let message = 'Не удалось скачать файл.';
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch (error) {
      // ignore
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

async function downloadCurrentProject() {
  hideError('#project-error');
  try {
    const name = (state.project?.name || 'project').replace(/[\\/:*?"<>|]+/g, '_');
    await downloadBlob('/api/project/export', name + '.db2ui.json');
    toast('Файл проекта скачан', 'success');
  } catch (error) {
    showError('#project-error', error.message);
  }
}

async function downloadLibraryProject(file) {
  hideError('#project-error');
  try {
    await downloadBlob('/api/projects/download?file=' + encodeURIComponent(file), file);
  } catch (error) {
    showError('#project-error', error.message);
  }
}

async function importProjectFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  hideError('#project-error');
  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error('Файл не является корректным JSON.');
    }
    const result = await api('/api/project/import', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    applyProject(result.project);
    await loadProjectLibrary();
    toast('Проект загружен из файла', 'success');
  } catch (error) {
    showError('#project-error', error.message);
  }
}

async function saveAsProject() {
  hideError('#project-error');
  const name = ($('#project-name').value || state.project?.name || '').trim();
  if (!name) {
    showError('#project-error', 'Укажите название проекта.');
    return;
  }
  try {
    const data = await api('/api/projects/save-as', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    applyProject(data.project);
    await loadProjectLibrary();
    toast('Сохранено как «' + name + '»', 'success');
  } catch (error) {
    showError('#project-error', error.message);
  }
}

async function newProject() {
  if (!confirm('Создать новый пустой проект? Текущий проект останется в библиотеке файлов.')) return;
  hideError('#project-error');
  try {
    const data = await api('/api/projects/new', { method: 'POST' });
    applyProject(data.project);
    await loadProjectLibrary();
    toast('Новый проект создан', 'success');
  } catch (error) {
    showError('#project-error', error.message);
  }
}

async function openLibraryProject(file) {
  hideError('#project-error');
  try {
    const data = await api('/api/projects/open', {
      method: 'POST',
      body: JSON.stringify({ file }),
    });
    applyProject(data.project);
    closeDialog('#project-dialog');
    toast('Проект открыт', 'success');
  } catch (error) {
    showError('#project-error', error.message);
  }
}

async function deleteLibraryProject(file) {
  if (!confirm('Удалить файл проекта «' + file + '»?')) return;
  hideError('#project-error');
  try {
    await api('/api/projects/delete', {
      method: 'POST',
      body: JSON.stringify({ file }),
    });
    await loadProjectLibrary();
    toast('Файл проекта удалён', 'info');
  } catch (error) {
    showError('#project-error', error.message);
  }
}

function applyProject(project) {
  state.project = normalizeProject(project, state.db?.database || '');
  state.currentFormId = state.project.start_form;
  state.openForms = [state.currentFormId];
  state.selected = { kind: 'form', formId: state.currentFormId };
  state.multi = [];
  state.expanded = new Set(state.project.forms.map((form) => form.id));
  syncSettingsUi();
  renderAll();
  resetHistory();
  if (state.mainTab === 'auth') renderAuthScreen();
  if (state.mainTab === 'routines') renderRoutinesScreen();
}

/* =========================================================================
   Глобальные события и запуск
   ========================================================================= */

function nudgeSelection(dx, dy) {
  const form = currentForm();
  const elements = selectedElements();
  if (!form || !elements.length) return;

  elements.forEach((element) => {
    const parent = parentElementOf(form, element);
    const content = parent
      ? containerContentSize(parent)
      : { w: FORM_MAX_SIZE, h: FORM_MAX_SIZE };
    element.x = clamp(element.x + dx, 0, Math.max(0, content.w - element.w));
    element.y = clamp(element.y + dy, 0, Math.max(0, content.h - element.h));
  });
  renderCanvas();
  renderProperties();
  scheduleSave();
}

function bindDialogClosers() {
  $$('.dialog-close-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = button.closest('dialog');
      if (dialog?.open) dialog.close();
    });
  });
}

function bindGlobal() {
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.context-menu')) closeContextMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeContextMenu();
      if (!isTypingTarget(event.target) && state.connected) {
        const form = currentForm();
        if (form) selectForm(form.id);
      }
      return;
    }

    if (isTypingTarget(event.target) || !state.connected) return;
    const builderVisible = !$('#builder').hidden && state.mainTab === 'builder';

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveProject();
      return;
    }

    if (!builderVisible) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redoProject();
      else undoProject();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redoProject();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      copySelectedElements();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      pasteElements();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSelectedElements();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      const form = currentForm();
      if (form) selectMany(form.id, topLevelElements(form).map((element) => element.id));
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selectedIds().length) {
        event.preventDefault();
        deleteSelectedElements();
      }
      return;
    }

    const step = event.shiftKey ? gridSize() : 1;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      nudgeSelection(-step, 0);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      nudgeSelection(step, 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      nudgeSelection(0, -step);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      nudgeSelection(0, step);
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

function init() {
  bindConnectScreen();
  bindBuilderChrome();
  bindGlobal();
  bindDialogClosers();
  restoreSession();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}


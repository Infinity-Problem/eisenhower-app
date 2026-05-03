(() => {
  'use strict';

  const QUADRANTS = ['do', 'schedule', 'delegate', 'delete'];
  const FILTERS = ['all', 'today', 'tomorrow', 'week', 'month', 'pastdue', 'done'];
  const QUADRANT_COLOR = {
    do: 'var(--do)',
    schedule: 'var(--schedule)',
    delegate: 'var(--delegate)',
    delete: 'var(--delete)',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let tasks = [];
  let api = null;
  let activeFilter = 'all';

  // Adoption state. baseSecAtRef = total seconds at the moment we received the
  // server payload; refLocalMs = Date.now() at that moment. Live elapsed is
  // baseSecAtRef + (Date.now() - refLocalMs)/1000. Keeps us off Python's clock.
  let adoption = null; // { taskId, taskText, baseSecAtRef, refLocalMs }

  // ---------- Date helpers ----------

  function localISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function todayISO() { return localISO(new Date()); }
  function addDaysISO(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    return localISO(new Date(y, m - 1, d + days));
  }
  function endOfWeekISO() {
    const d = new Date();
    const daysToSunday = (7 - d.getDay()) % 7;
    return addDaysISO(localISO(d), daysToSunday);
  }
  function endOfMonthISO() {
    const d = new Date();
    return localISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  }
  function formatDateBadge(iso) {
    if (!iso) return '';
    const today = todayISO();
    if (iso === today) return 'today';
    if (iso === addDaysISO(today, 1)) return 'tomorrow';
    if (iso === addDaysISO(today, -1)) return 'yesterday';
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sameYear = y === new Date().getFullYear();
    return sameYear
      ? `${months[m - 1]} ${d}`
      : `${months[m - 1]} ${d}, ${y}`;
  }
  function dateClass(iso, completed) {
    if (!iso || completed) return '';
    const today = todayISO();
    if (iso < today)  return 'overdue';
    if (iso === today) return 'today';
    if (iso === addDaysISO(today, 1)) return 'tomorrow';
    return '';
  }

  function formatHMS(totalSec) {
    totalSec = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function formatShortTime(totalSec) {
    totalSec = Math.max(0, Math.floor(totalSec));
    if (totalSec < 60)   return `${totalSec}s`;
    if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m`;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }

  function liveSecondsForTask(t) {
    let sec = t.time_spent_seconds || 0;
    if (adoption && adoption.taskId === t.id) {
      sec = adoption.baseSecAtRef + (Date.now() - adoption.refLocalMs) / 1000;
    }
    return sec;
  }

  function matchesFilter(task) {
    const f = activeFilter;
    if (f === 'done') return !!task.archived;
    // All other filters hide archived tasks.
    if (task.archived) return false;
    if (f === 'all') return true;
    const d = task.due_date;
    const today = todayISO();
    if (f === 'pastdue') return !!d && d < today && !task.completed;
    if (!d) return false;
    if (f === 'today')    return d === today;
    if (f === 'tomorrow') return d === addDaysISO(today, 1);
    if (f === 'week')     return d >= today && d <= endOfWeekISO();
    if (f === 'month')    return d >= today && d <= endOfMonthISO();
    return true;
  }

  const FILTER_LABELS = {
    all: 'all',
    today: 'today',
    tomorrow: 'tomorrow',
    week: 'this week',
    month: 'this month',
    pastdue: 'past due',
    done: 'archive',
  };

  // ---------- API bootstrap ----------

  function whenReady(fn) {
    if (window.pywebview && window.pywebview.api) {
      fn();
    } else {
      window.addEventListener('pywebviewready', fn, { once: true });
    }
  }

  // ---------- Rendering ----------

  function render() {
    QUADRANTS.forEach(q => {
      const list = document.querySelector(`.task-list[data-quadrant="${q}"]`);
      const count = document.querySelector(`.quadrant-count[data-count="${q}"]`);
      list.innerHTML = '';
      const items = tasks
        .filter(t => t.quadrant === q)
        .filter(matchesFilter);
      // Active first, completed at the bottom; within each, soonest due date first.
      items.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        const ad = a.due_date || '9999-99-99';
        const bd = b.due_date || '9999-99-99';
        return ad.localeCompare(bd);
      });
      items.forEach(t => list.appendChild(taskNode(t)));
      count.textContent = items.length;
    });
    const live = tasks.filter(t => !t.archived);
    const total = live.length;
    const done = live.filter(t => t.completed).length;
    document.getElementById('task-count').textContent =
      total === 0 ? 'no tasks'
      : done === 0 ? `${total} task${total === 1 ? '' : 's'}`
      : `${total - done} active · ${done} done`;
    renderBattery();
    renderCountPie();
    renderPie();
  }

  function taskNode(t) {
    const isAdopted = adoption && adoption.taskId === t.id;
    const li = document.createElement('li');
    li.className = 'task'
      + (t.completed ? ' completed' : '')
      + (isAdopted ? ' adopted' : '');
    li.draggable = true;
    li.dataset.id = t.id;

    const check = document.createElement('div');
    check.className = 'task-check';
    check.title = t.completed ? 'Mark incomplete' : 'Mark complete';
    check.addEventListener('click', () => toggleComplete(t.id));

    const meta = document.createElement('div');
    meta.className = 'task-meta';

    const text = document.createElement('div');
    text.className = 'task-text';
    text.textContent = t.text;
    text.title = 'Double-click to edit';
    text.addEventListener('dblclick', () => editTask(t.id, text));
    meta.appendChild(text);

    const dateRow = document.createElement('div');
    dateRow.style.cssText = 'display: flex; align-items: center; flex-wrap: wrap; gap: 4px;';

    const date = document.createElement('span');
    const cls = dateClass(t.due_date, t.completed);
    date.className = 'task-date' + (cls ? ' ' + cls : '');
    date.textContent = t.due_date ? formatDateBadge(t.due_date) : '+ date';
    date.title = t.due_date ? 'Click to change · Shift-click to clear' : 'Click to set due date';
    if (!t.due_date) date.style.opacity = '0.5';
    date.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey && t.due_date) {
        updateDate(t.id, null);
      } else {
        editDate(t.id, date);
      }
    });
    dateRow.appendChild(date);

    const totalSec = liveSecondsForTask(t);
    if (totalSec >= 1 || isAdopted) {
      const time = document.createElement('span');
      time.className = 'task-time';
      time.dataset.taskTime = t.id;
      time.textContent = formatShortTime(totalSec);
      time.title = 'Total time tracked';
      dateRow.appendChild(time);
    }

    meta.appendChild(dateRow);

    const adopt = document.createElement('button');
    adopt.className = 'task-adopt';
    adopt.innerHTML = isAdopted ? '&#9632;' : '&#9654;';
    adopt.title = isAdopted ? 'Stop tracking this task' : 'Adopt: start tracking this task';
    adopt.disabled = t.completed;
    if (t.completed) adopt.style.display = 'none';
    adopt.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isAdopted) releaseTask();
      else           adoptTask(t.id);
    });

    const del = document.createElement('button');
    del.className = 'task-delete';
    del.innerHTML = '&times;';
    del.title = 'Delete';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTask(t.id);
    });

    li.appendChild(check);
    li.appendChild(meta);
    li.appendChild(adopt);
    li.appendChild(del);

    li.addEventListener('dragstart', (e) => {
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t.id);
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));

    return li;
  }

  function editDate(id, badgeEl) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    const input = document.createElement('input');
    input.type = 'date';
    input.value = t.due_date || '';
    input.style.cssText = `
      background: var(--bg-panel); border: 1px solid var(--text-dim);
      color: var(--text); padding: 2px 4px; border-radius: 2px; font-size: 11px;
      color-scheme: dark; align-self: flex-start;
    `;
    badgeEl.replaceWith(input);
    input.focus();
    if (input.showPicker) { try { input.showPicker(); } catch (_) {} }

    let finished = false;
    const finish = async (commit) => {
      if (finished) return;
      finished = true;
      if (commit) {
        const value = input.value || null;
        if (value !== t.due_date) await updateDate(id, value);
      }
      render();
    };
    input.addEventListener('blur',  () => finish(true));
    input.addEventListener('change', () => finish(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); finished = true; render(); }
    });
  }

  async function updateDate(id, value) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    try {
      const updated = await api.update_task(id, { due_date: value });
      Object.assign(t, updated);
      render();
    } catch (err) {
      console.error('update_task (date) failed', err);
    }
  }

  // ---------- Task ops ----------

  async function addTask(text, quadrant, dueDate) {
    text = text.trim();
    if (!text) return;
    try {
      const created = await api.add_task(text, quadrant, dueDate || null);
      tasks.push(created);
      render();
    } catch (err) {
      console.error('add_task failed', err);
    }
  }

  async function toggleComplete(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    const next = !t.completed;
    try {
      const updated = await api.update_task(id, { completed: next });
      Object.assign(t, updated);
      // Backend auto-releases when completing the adopted task.
      if (next && adoption && adoption.taskId === id) {
        await refreshAdoption();
      }
      render();
    } catch (err) {
      console.error('update_task failed', err);
    }
  }

  async function deleteTask(id) {
    try {
      await api.delete_task(id);
      tasks = tasks.filter(t => t.id !== id);
      if (adoption && adoption.taskId === id) {
        adoption = null;
        renderAdoptionStrip();
      }
      render();
    } catch (err) {
      console.error('delete_task failed', err);
    }
  }

  async function moveTask(id, quadrant) {
    const t = tasks.find(x => x.id === id);
    if (!t || t.quadrant === quadrant) return;
    try {
      const updated = await api.update_task(id, { quadrant });
      Object.assign(t, updated);
      render();
    } catch (err) {
      console.error('update_task (move) failed', err);
    }
  }

  function editTask(id, textEl) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    const original = t.text;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = original;
    input.maxLength = 200;
    input.style.cssText = `
      flex: 1; background: var(--bg-panel); border: 1px solid var(--text-dim);
      color: var(--text); padding: 4px 6px; border-radius: 2px; font-size: 13px;
    `;
    textEl.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (commit) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      if (commit && value && value !== original) {
        try {
          const updated = await api.update_task(id, { text: value });
          Object.assign(t, updated);
        } catch (err) {
          console.error('update_task (text) failed', err);
        }
      }
      render();
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); finished = true; render(); }
    });
  }

  async function clearCompleted() {
    const doneCount = tasks.filter(t => t.completed && !t.archived).length;
    if (doneCount === 0) return;
    try {
      await api.archive_completed();
      tasks = await api.get_tasks();
      render();
    } catch (err) {
      console.error('archive_completed failed', err);
    }
  }

  // ---------- Adoption / time tracking ----------

  function applyAdoptionPayload(payload) {
    if (!payload) {
      adoption = null;
    } else {
      // Compose base seconds at the moment we received the payload.
      const elapsedSinceStart = Math.max(0, (payload.now_ms - payload.started_at_ms) / 1000);
      adoption = {
        taskId: payload.task_id,
        taskText: payload.task_text,
        baseSecAtRef: payload.base_seconds + elapsedSinceStart,
        refLocalMs: Date.now(),
      };
    }
  }

  async function refreshAdoption() {
    try {
      applyAdoptionPayload(await api.get_adoption_state());
    } catch (err) {
      console.error('get_adoption_state failed', err);
      adoption = null;
    }
    renderAdoptionStrip();
  }

  async function adoptTask(id) {
    try {
      applyAdoptionPayload(await api.adopt_task(id));
      // Refresh task list to get updated time_spent on the previous adoptee.
      tasks = await api.get_tasks();
      render();
      renderAdoptionStrip();
    } catch (err) {
      console.error('adopt_task failed', err);
    }
  }

  async function releaseTask() {
    try {
      await api.release_task();
      adoption = null;
      tasks = await api.get_tasks();
      render();
      renderAdoptionStrip();
    } catch (err) {
      console.error('release_task failed', err);
    }
  }

  // ---------- Battery + Pie chart ----------

  function renderBattery() {
    const visible = tasks.filter(matchesFilter);
    const total = visible.length;
    const done = visible.filter(t => t.completed).length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);

    const fill = document.getElementById('battery-fill');
    fill.style.width = `${pct}%`;
    fill.dataset.pct = pct === 0 ? '0' : '';
    fill.dataset.state = pct >= 100 ? 'full' : '';

    document.getElementById('battery-text').textContent = `${done} / ${total}`;
    document.getElementById('battery-pct').textContent = total === 0 ? 'no tasks in scope' : `${pct}% complete`;
    document.getElementById('battery-scope').textContent = FILTER_LABELS[activeFilter];
  }

  function drawPie(opts) {
    // opts: { svgId, totalId, legendId, scopeId, totals, formatValue, totalLabel, emptyLabel, centerFormat }
    const totals = opts.totals;
    const grand = QUADRANTS.reduce((s, q) => s + totals[q], 0);

    document.getElementById(opts.scopeId).textContent = FILTER_LABELS[activeFilter];

    const svg = document.getElementById(opts.svgId);
    svg.innerHTML = '';
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('cx', '50'); ring.setAttribute('cy', '50'); ring.setAttribute('r', '44');
    ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', 'var(--line)'); ring.setAttribute('stroke-width', '1');
    svg.appendChild(ring);

    const totalEl = document.getElementById(opts.totalId);
    if (grand <= 0) {
      totalEl.innerHTML = `<div>—</div><div class="pie-total-label">${opts.emptyLabel}</div>`;
    } else {
      totalEl.innerHTML = `<div>${opts.centerFormat(grand)}</div><div class="pie-total-label">${opts.totalLabel}</div>`;

      const nonzero = QUADRANTS.filter(q => totals[q] > 0);
      if (nonzero.length === 1) {
        const q = nonzero[0];
        const circ = document.createElementNS(SVG_NS, 'circle');
        circ.setAttribute('cx', '50'); circ.setAttribute('cy', '50'); circ.setAttribute('r', '40');
        circ.setAttribute('fill', QUADRANT_COLOR[q]); circ.setAttribute('class', 'pie-slice');
        svg.appendChild(circ);
      } else {
        let cumulative = 0;
        QUADRANTS.forEach(q => {
          const value = totals[q];
          if (value <= 0) return;
          const a0 = (cumulative / grand) * Math.PI * 2;
          const a1 = ((cumulative + value) / grand) * Math.PI * 2;
          cumulative += value;
          const r = 40, cx = 50, cy = 50;
          const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
          const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
          const large = (a1 - a0) > Math.PI ? 1 : 0;
          const path = document.createElementNS(SVG_NS, 'path');
          path.setAttribute('d', `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`);
          path.setAttribute('fill', QUADRANT_COLOR[q]);
          path.setAttribute('class', 'pie-slice');
          path.setAttribute('data-q', q);
          svg.appendChild(path);
        });
      }

      const hole = document.createElementNS(SVG_NS, 'circle');
      hole.setAttribute('cx', '50'); hole.setAttribute('cy', '50'); hole.setAttribute('r', '24');
      hole.setAttribute('fill', 'var(--bg-panel)');
      svg.appendChild(hole);
    }

    const legend = document.getElementById(opts.legendId);
    legend.innerHTML = '';
    QUADRANTS.forEach(q => {
      const value = totals[q];
      const row = document.createElement('div');
      row.className = 'legend-row' + (value <= 0 ? ' zero' : '');
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.style.background = QUADRANT_COLOR[q];
      const name = document.createElement('span');
      name.className = 'legend-name';
      name.textContent = q.toUpperCase();
      const val = document.createElement('span');
      val.className = 'legend-value';
      val.textContent = value > 0 ? opts.formatValue(value) : '—';
      row.appendChild(swatch); row.appendChild(name); row.appendChild(val);
      legend.appendChild(row);
    });
  }

  function renderPie() {
    const visible = tasks.filter(matchesFilter);
    const totals = { do: 0, schedule: 0, delegate: 0, delete: 0 };
    visible.forEach(t => { totals[t.quadrant] = (totals[t.quadrant] || 0) + liveSecondsForTask(t); });
    drawPie({
      svgId: 'pie-svg', totalId: 'pie-total', legendId: 'pie-legend', scopeId: 'pie-scope',
      totals,
      formatValue: formatShortTime,
      centerFormat: formatShortTime,
      totalLabel: 'total',
      emptyLabel: 'no time tracked',
    });
  }

  function renderCountPie() {
    // Open = not completed, not archived. Then narrowed by activeFilter.
    const visible = tasks.filter(t => !t.completed && matchesFilter(t));
    const totals = { do: 0, schedule: 0, delegate: 0, delete: 0 };
    visible.forEach(t => { totals[t.quadrant] = (totals[t.quadrant] || 0) + 1; });
    drawPie({
      svgId: 'count-svg', totalId: 'count-total', legendId: 'count-legend', scopeId: 'count-scope',
      totals,
      formatValue: (n) => String(n),
      centerFormat: (n) => String(n),
      totalLabel: 'open',
      emptyLabel: 'no open tasks',
    });
  }

  function renderAdoptionStrip() {
    const strip = document.getElementById('adoption-strip');
    const textEl = document.getElementById('adopt-text');
    const timerEl = document.getElementById('adopt-timer');
    if (!adoption) {
      strip.classList.add('idle');
      textEl.textContent = '';
      timerEl.textContent = '00:00:00';
      return;
    }
    strip.classList.remove('idle');
    textEl.textContent = adoption.taskText;
    timerEl.textContent = formatHMS(adoption.baseSecAtRef + (Date.now() - adoption.refLocalMs) / 1000);
  }

  function tickTimers() {
    if (!adoption) return;
    const live = adoption.baseSecAtRef + (Date.now() - adoption.refLocalMs) / 1000;
    const timerEl = document.getElementById('adopt-timer');
    if (timerEl) timerEl.textContent = formatHMS(live);
    const taskTimeEl = document.querySelector(`[data-task-time="${adoption.taskId}"]`);
    if (taskTimeEl) taskTimeEl.textContent = formatShortTime(live);
    // Refresh pie so the live elapsed shows up in the chart while ticking.
    renderPie();
  }

  // ---------- Drag & drop ----------

  function wireDropTargets() {
    document.querySelectorAll('.quadrant').forEach(q => {
      q.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        q.classList.add('drop-target');
      });
      q.addEventListener('dragleave', (e) => {
        if (!q.contains(e.relatedTarget)) q.classList.remove('drop-target');
      });
      q.addEventListener('drop', (e) => {
        e.preventDefault();
        q.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/plain');
        const quadrant = q.dataset.quadrant;
        if (id && quadrant) moveTask(id, quadrant);
      });
    });
  }

  // ---------- Global input column ----------

  let selectedQuadrant = 'do';

  function setSelected(quadrant) {
    if (!QUADRANTS.includes(quadrant)) return;
    selectedQuadrant = quadrant;
    document.querySelectorAll('.picker-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset.quadrant === quadrant);
    });
  }

  function flashPicker(quadrant) {
    const btn = document.querySelector(`.picker-btn[data-quadrant="${quadrant}"]`);
    if (!btn) return;
    btn.classList.remove('flash');
    void btn.offsetWidth;
    btn.classList.add('flash');
  }

  function commit(quadrant) {
    const input = document.getElementById('global-input');
    const dateInput = document.getElementById('due-date');
    const value = input.value;
    if (!value.trim()) return;
    const due = dateInput.value || null;
    input.value = '';
    dateInput.value = '';
    setSelected(quadrant);
    flashPicker(quadrant);
    addTask(value, quadrant, due);
    input.focus();
  }

  function wireQuadrantAdds() {
    document.querySelectorAll('.quadrant-add').forEach(form => {
      const input = form.querySelector('.quadrant-add-input');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const value = input.value;
        if (!value.trim()) return;
        input.value = '';
        addTask(value, form.dataset.quadrant, null);
      });
    });
  }

  function wireInputColumn() {
    setSelected('do');

    const input = document.getElementById('global-input');
    const dateInput = document.getElementById('due-date');

    document.getElementById('btn-date-today').addEventListener('click', () => {
      dateInput.value = todayISO();
      input.focus();
    });
    document.getElementById('btn-date-tomorrow').addEventListener('click', () => {
      dateInput.value = addDaysISO(todayISO(), 1);
      input.focus();
    });
    document.getElementById('btn-date-clear').addEventListener('click', () => {
      dateInput.value = '';
      input.focus();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commit(selectedQuadrant);
        return;
      }
      // 1..4 with Ctrl OR Alt commits to that quadrant; bare 1-4 is text input.
      if ((e.ctrlKey || e.altKey) && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        commit(QUADRANTS[parseInt(e.key, 10) - 1]);
      }
    });

    document.querySelectorAll('.picker-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = btn.dataset.quadrant;
        if (input.value.trim()) {
          commit(q);
        } else {
          setSelected(q);
          input.focus();
        }
      });
    });
  }

  // ---------- Window controls ----------

  function wireTitlebar() {
    document.getElementById('btn-minimize').addEventListener('click', () => api.minimize());
    document.getElementById('btn-close').addEventListener('click', () => api.close());
    document.getElementById('btn-clear-completed').addEventListener('click', clearCompleted);
    document.getElementById('btn-fullscreen').addEventListener('click', () => api.toggle_fullscreen());
    document.getElementById('btn-settings').addEventListener('click', openSettings);
    document.getElementById('btn-release').addEventListener('click', releaseTask);

    wireWindowDrag();
    wireSettings();
  }

  // ---------- Settings overlay ----------

  let gcalStatus = null;
  let gcalDetailOpen = false;

  async function openSettings() {
    const o = document.getElementById('settings-overlay');
    o.classList.remove('hidden');
    o.setAttribute('aria-hidden', 'false');
    await refreshGcalStatus({ autoExpand: true });
  }

  function closeSettings() {
    const o = document.getElementById('settings-overlay');
    o.classList.add('hidden');
    o.setAttribute('aria-hidden', 'true');
  }

  function wireSettings() {
    const overlay = document.getElementById('settings-overlay');
    document.getElementById('btn-settings-close').addEventListener('click', closeSettings);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSettings();
    });

    document.getElementById('btn-gcal-toggle').addEventListener('click', () => {
      gcalDetailOpen = !gcalDetailOpen;
      renderGcalSection();
    });
    document.getElementById('btn-gcal-open-console').addEventListener('click', () => {
      api.open_external_url('https://console.cloud.google.com/apis/credentials');
    });
    document.getElementById('btn-gcal-save-creds').addEventListener('click', saveGcalCreds);
    document.getElementById('btn-gcal-connect').addEventListener('click', connectGcal);
    document.getElementById('btn-gcal-disconnect').addEventListener('click', disconnectGcal);
    document.getElementById('btn-gcal-sync').addEventListener('click', syncGcalNow);
    document.getElementById('btn-gcal-refresh-calendars').addEventListener('click', loadGcalCalendars);
    document.getElementById('gcal-calendar').addEventListener('change', changeGcalCalendar);

    // Live-mirror credential inputs into save state for Enter key submit.
    ['gcal-client-id', 'gcal-client-secret'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); saveGcalCreds(); }
      });
    });
  }

  async function refreshGcalStatus(opts = {}) {
    try {
      gcalStatus = await api.get_gcal_status();
    } catch (err) {
      console.error('get_gcal_status failed', err);
      gcalStatus = { libraries_installed: false, library_error: String(err) };
    }
    if (opts.autoExpand && gcalStatus.connected) gcalDetailOpen = true;
    renderGcalSection();
    if (gcalStatus.connected) loadGcalCalendars();
  }

  function setInlineStatus(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'settings-inline-status' + (kind ? ' ' + kind : '');
  }

  function renderGcalSection() {
    const s = gcalStatus || {};
    const statusPill = document.getElementById('gcal-status');
    const toggleBtn = document.getElementById('btn-gcal-toggle');
    const detail = document.getElementById('gcal-detail');
    const credsBlock = document.getElementById('gcal-creds-block');
    const connectBlock = document.getElementById('gcal-connect-block');
    const syncBlock = document.getElementById('gcal-sync-block');
    const connectBtn = document.getElementById('btn-gcal-connect');

    // Status pill
    if (!s.libraries_installed) {
      statusPill.textContent = 'LIBS MISSING';
      statusPill.className = 'settings-status error';
    } else if (s.connected) {
      statusPill.textContent = 'CONNECTED';
      statusPill.className = 'settings-status connected';
    } else if (s.has_credentials) {
      statusPill.textContent = 'NOT AUTHORIZED';
      statusPill.className = 'settings-status not-connected';
    } else {
      statusPill.textContent = 'NOT CONNECTED';
      statusPill.className = 'settings-status not-connected';
    }

    toggleBtn.textContent = gcalDetailOpen ? 'Hide' : 'Configure';
    detail.classList.toggle('hidden', !gcalDetailOpen);

    if (!s.libraries_installed) {
      credsBlock.classList.add('hidden');
      connectBlock.classList.add('hidden');
      syncBlock.classList.add('hidden');
      const head = document.getElementById('gcal-detail');
      head.innerHTML = `<div class="settings-block-help error" style="color: var(--do)">
        Google Calendar libraries are not installed. Run:
        <code>pip install google-auth google-auth-oauthlib google-api-python-client</code>
        and restart the app. Error: ${s.library_error || ''}</div>`;
      return;
    }

    // Credentials block — hidden entirely when creds are baked into the app.
    if (s.credentials_bundled) {
      credsBlock.classList.add('hidden');
    } else {
      credsBlock.classList.remove('hidden');
      document.getElementById('gcal-client-id').value = '';
      document.getElementById('gcal-client-secret').value = '';
      document.getElementById('gcal-client-id').placeholder =
        s.has_credentials ? '••• saved (paste to replace) •••' : '123456789-xxxxxxxxxxxxxxxx.apps.googleusercontent.com';
      document.getElementById('gcal-client-secret').placeholder =
        s.has_credentials ? '••• saved (paste to replace) •••' : 'GOCSPX-...';
    }

    // Connect block — visible once creds saved, hidden if connected.
    if (s.has_credentials && !s.connected) {
      connectBlock.classList.remove('hidden');
      connectBtn.disabled = false;
    } else if (s.has_credentials && s.connected) {
      connectBlock.classList.add('hidden');
    } else {
      connectBlock.classList.remove('hidden');
      connectBtn.disabled = true;
    }

    // Sync block — visible once connected.
    if (s.connected) {
      syncBlock.classList.remove('hidden');
      document.getElementById('gcal-email').textContent = s.email || '—';
      const meta = document.getElementById('gcal-last-sync');
      meta.textContent = s.last_sync_at
        ? `Last sync: ${s.last_sync_at}`
        : 'Not synced yet.';

      // Reflect saved calendar choice in dropdown if loaded.
      const sel = document.getElementById('gcal-calendar');
      if (s.calendar_id && sel.querySelector(`option[value="${CSS.escape(s.calendar_id)}"]`)) {
        sel.value = s.calendar_id;
      }
    } else {
      syncBlock.classList.add('hidden');
    }
  }

  async function saveGcalCreds() {
    const id = document.getElementById('gcal-client-id').value;
    const secret = document.getElementById('gcal-client-secret').value;
    if (!id.trim() || !secret.trim()) {
      setInlineStatus('gcal-connect-status', 'Both client ID and secret are required.', 'error');
      return;
    }
    try {
      gcalStatus = await api.gcal_set_credentials(id, secret);
      setInlineStatus('gcal-connect-status', 'Credentials saved. Click Connect to authorize.', 'ok');
      renderGcalSection();
    } catch (err) {
      setInlineStatus('gcal-connect-status', String(err), 'error');
    }
  }

  async function connectGcal() {
    setInlineStatus('gcal-connect-status', 'Opening browser… complete the consent screen and return.', 'pending');
    const btn = document.getElementById('btn-gcal-connect');
    btn.disabled = true;
    try {
      gcalStatus = await api.gcal_connect();
      setInlineStatus('gcal-connect-status', 'Connected!', 'ok');
      renderGcalSection();
      await loadGcalCalendars();
    } catch (err) {
      setInlineStatus('gcal-connect-status', `Connect failed: ${err}`, 'error');
      btn.disabled = false;
    }
  }

  async function disconnectGcal() {
    try {
      gcalStatus = await api.gcal_disconnect();
      setInlineStatus('gcal-sync-status', 'Disconnected.', 'ok');
      renderGcalSection();
    } catch (err) {
      setInlineStatus('gcal-sync-status', String(err), 'error');
    }
  }

  async function loadGcalCalendars() {
    const sel = document.getElementById('gcal-calendar');
    sel.innerHTML = '<option value="">loading…</option>';
    try {
      const cals = await api.gcal_list_calendars();
      sel.innerHTML = '';
      cals.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = (c.primary ? '★ ' : '') + c.summary;
        opt.dataset.summary = c.summary;
        sel.appendChild(opt);
      });
      const current = gcalStatus && gcalStatus.calendar_id;
      if (current && sel.querySelector(`option[value="${CSS.escape(current)}"]`)) {
        sel.value = current;
      }
    } catch (err) {
      sel.innerHTML = `<option value="">${String(err).slice(0, 80)}</option>`;
    }
  }

  async function changeGcalCalendar() {
    const sel = document.getElementById('gcal-calendar');
    const id = sel.value;
    if (!id) return;
    const summary = sel.options[sel.selectedIndex]?.dataset.summary || id;
    try {
      gcalStatus = await api.gcal_set_calendar(id, summary);
      setInlineStatus('gcal-sync-status', `Target: ${summary}`, 'ok');
    } catch (err) {
      setInlineStatus('gcal-sync-status', String(err), 'error');
    }
  }

  async function syncGcalNow() {
    setInlineStatus('gcal-sync-status', 'Syncing…', 'pending');
    const btn = document.getElementById('btn-gcal-sync');
    btn.disabled = true;
    try {
      const r = await api.gcal_sync_now();
      const parts = [];
      if (r.created) parts.push(`+${r.created} created`);
      if (r.updated) parts.push(`${r.updated} updated`);
      if (r.deleted) parts.push(`-${r.deleted} deleted`);
      if (!parts.length) parts.push('nothing to sync');
      const summary = parts.join(' · ') + (r.errors ? ` · ${r.errors} errors` : '');
      setInlineStatus('gcal-sync-status', summary, r.errors ? 'error' : 'ok');
      gcalStatus = await api.get_gcal_status();
      renderGcalSection();
      if (r.error_messages && r.error_messages.length) {
        console.warn('gcal sync errors', r.error_messages);
      }
      // Refresh tasks so any new gcal_event_id flags are reflected if we ever surface them.
      tasks = await api.get_tasks();
      render();
    } catch (err) {
      setInlineStatus('gcal-sync-status', String(err), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Manual window drag with snap-on-release ----------

  function wireWindowDrag() {
    const handle = document.getElementById('titlebar-drag');
    const SNAP = 12; // px from screen edge that triggers snap

    let drag = null; // { startX, startY, geom, workArea, lastX, lastY, pending }

    handle.addEventListener('mousedown', async (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, textarea, a')) return;
      e.preventDefault();
      const [geom, workArea] = await Promise.all([
        api.get_window_geometry(),
        api.get_monitor_work_area(),
      ]);
      if (!geom) return;
      drag = {
        startX: e.screenX,
        startY: e.screenY,
        geom,
        workArea,
        lastX: e.screenX,
        lastY: e.screenY,
        pending: false,
      };
    });

    handle.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, textarea, a')) return;
      e.preventDefault();
      // Double-click toggles maximize via cycle: maximize, then on next dbl restore.
      // We don't track maximized state here; pywebview's maximize() / restore() are
      // idempotent enough for our purposes.
      api.maximize_window();
    });

    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      drag.lastX = e.screenX;
      drag.lastY = e.screenY;
      if (drag.pending) return;
      drag.pending = true;
      requestAnimationFrame(() => {
        if (!drag) return;
        drag.pending = false;
        const dx = drag.lastX - drag.startX;
        const dy = drag.lastY - drag.startY;
        api.move_window(drag.geom.x + dx, drag.geom.y + dy);
      });
    });

    window.addEventListener('mouseup', (e) => {
      if (!drag) return;
      const wa = drag.workArea;
      const sx = e.screenX, sy = e.screenY;
      drag = null;
      if (!wa) return;
      // Snap detection — Aero Snap-style.
      if (sy <= wa.y + SNAP) {
        api.maximize_window();
      } else if (sx <= wa.x + SNAP) {
        const halfW = Math.floor(wa.width / 2);
        api.set_window_geometry(wa.x, wa.y, halfW, wa.height);
      } else if (sx >= wa.x + wa.width - SNAP - 1) {
        const halfW = Math.floor(wa.width / 2);
        api.set_window_geometry(wa.x + wa.width - halfW, wa.y, halfW, wa.height);
      }
    });
  }

  function wireFilters() {
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const f = chip.dataset.filter;
        if (!FILTERS.includes(f)) return;
        activeFilter = f;
        document.querySelectorAll('.filter-chip').forEach(c => {
          c.classList.toggle('selected', c.dataset.filter === f);
        });
        render();
      });
    });
  }

  // ---------- Resize handles ----------

  function wireResize() {
    const MIN_W = 700;
    const MIN_H = 500;
    let active = null; // { edge, startX, startY, geom }

    document.querySelectorAll('.resize-handle').forEach(h => {
      h.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const geom = await api.get_window_geometry();
        if (!geom) return;
        active = {
          edge: h.dataset.edge,
          startX: e.screenX,
          startY: e.screenY,
          geom,
        };
        document.body.style.cursor = getComputedStyle(h).cursor;
      });
    });

    let pending = false;
    window.addEventListener('mousemove', (e) => {
      if (!active || pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (!active) return;
        const dx = e.screenX - active.startX;
        const dy = e.screenY - active.startY;
        const { edge, geom } = active;

        let { x, y, width, height } = geom;

        if (edge.includes('e')) width  = geom.width  + dx;
        if (edge.includes('s')) height = geom.height + dy;
        if (edge.includes('w')) {
          const newW = geom.width - dx;
          if (newW >= MIN_W) { width = newW; x = geom.x + dx; }
          else { width = MIN_W; x = geom.x + (geom.width - MIN_W); }
        }
        if (edge.includes('n')) {
          const newH = geom.height - dy;
          if (newH >= MIN_H) { height = newH; y = geom.y + dy; }
          else { height = MIN_H; y = geom.y + (geom.height - MIN_H); }
        }

        if (width  < MIN_W) width  = MIN_W;
        if (height < MIN_H) height = MIN_H;

        api.set_window_geometry(x, y, width, height);
      });
    });

    window.addEventListener('mouseup', () => {
      if (active) {
        active = null;
        document.body.style.cursor = '';
      }
    });
  }

  // ---------- Keyboard ----------

  function wireKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA';

      if (e.key === 'Escape') {
        const overlay = document.getElementById('settings-overlay');
        if (!overlay.classList.contains('hidden')) {
          closeSettings();
          return;
        }
        if (inField) {
          document.activeElement.blur();
          return;
        }
      }
      if (e.key === 'F11') {
        e.preventDefault();
        api.toggle_fullscreen();
        return;
      }
      // Pressing any printable key when nothing is focused jumps to the global input.
      if (!inField && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        const input = document.getElementById('global-input');
        if (input) input.focus();
      }
    });
  }

  // ---------- Boot ----------

  whenReady(async () => {
    api = window.pywebview.api;
    try {
      tasks = await api.get_tasks();
    } catch (err) {
      console.error('get_tasks failed', err);
      tasks = [];
    }
    wireInputColumn();
    wireQuadrantAdds();
    wireDropTargets();
    wireTitlebar();
    wireFilters();
    wireResize();
    wireKeys();
    await refreshAdoption();
    render();
    setInterval(tickTimers, 1000);
  });
})();

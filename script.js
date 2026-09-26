/*
 * CPU Scheduling Race Visualizer
 * Plain JavaScript, no libraries, no network calls.
 *
 *   1. Constants and copy
 *   2. Helpers
 *   3. Scheduling core (pure functions: fcfs, sjf, srtf, priorityNonPreemptive,
 *      priorityPreemptive, roundRobin, generateGanttData, calculateMetrics,
 *      runAll, compareResults, verifySimulation)
 *   4. Validation
 *   5. "Why did this happen?" explanations
 *   6. UI state and rendering (renderGanttChart and friends)
 *   7. Race animation
 *   8. Events and start-up
 */
'use strict';

/* ==========================================================================
   1. Constants and copy
   ========================================================================== */

const LIMITS = { maxProcesses: 15, maxValue: 999, maxIdLength: 8, maxPriority: 99 };
const EPS = 1e-9;
const MIN_PX_PER_UNIT = 26; // keeps Gantt blocks readable; wide charts scroll sideways
const GOLDEN_ANGLE = 137.508;

// Canonical order every algorithm-driven list follows, so lanes, cards and chips
// always line up the same way regardless of which subset is selected.
const ALGO_ORDER = ['fcfs', 'sjf', 'srtf', 'prio', 'prioP', 'rr'];
const ALGO_INFO = {
  fcfs: { name: 'FCFS', full: 'First Come, First Served' },
  sjf: { name: 'SJF', full: 'Shortest Job First' },
  srtf: { name: 'SRTF', full: 'Shortest Remaining Time First' },
  prio: { name: 'Priority', full: 'Priority Scheduling' },
  prioP: { name: 'Priority (P)', full: 'Priority Scheduling (Preemptive)' },
  rr: { name: 'Round Robin', full: 'Fair Time Sharing' },
};
// What the app runs the first time it loads: every implemented algorithm, so
// all six are visibly integrated (race lanes, comparison, tables, insights)
// without the person having to find and check any boxes first.
const DEFAULT_ALGOS = ALGO_ORDER;
const MIN_COMPARE = 2; // fewer than this and "compare" stops meaning anything

const TERMS = {
  arrival: 'The time a process enters the ready queue.',
  burst: 'The total CPU time a process needs to finish.',
  priority: 'A number used to rank processes. Lower is higher priority: 1 is the highest priority a process can have.',
  quantum: 'The longest a process may run in Round Robin before the next ready process gets a turn.',
  completion: 'The time at which a process finishes.',
  turnaround: 'Completion time minus arrival time: how long the process spent in the system.',
  waiting: 'Turnaround time minus burst time: time spent ready but not running.',
  response: 'First start time minus arrival time: how long until the process first gets the CPU.',
  cpu: 'Busy time divided by the time from the first arrival to the last completion.',
  switches:
    'Times the CPU moves from one process to a different one. Idle gaps are ignored, and this simulator does not charge time for a switch.',
  preemptive: 'Preemptive: a running process can be interrupted so another one can use the CPU.',
  nonpreemptive: 'Non-preemptive: once a process starts, it keeps the CPU until it finishes.',
};

// Comparison metrics shown on the dashboard and in the generated insights.
const METRICS = [
  { key: 'waiting', label: 'Average waiting time', term: 'waiting', unit: 'time units', get: (a) => a.avg.waiting },
  { key: 'turnaround', label: 'Average turnaround time', term: 'turnaround', unit: 'time units', get: (a) => a.avg.turnaround },
  { key: 'response', label: 'Average response time', term: 'response', unit: 'time units', get: (a) => a.avg.response },
  { key: 'cpu', label: 'CPU utilization', term: 'cpu', unit: '%', get: (a) => a.cpuUtilization },
  { key: 'switches', label: 'Context switches', term: 'switches', unit: 'switches', get: (a) => a.contextSwitches },
];
const METRIC_PHRASE = {
  waiting: 'average waiting time',
  turnaround: 'average turnaround time',
  response: 'average response time',
  cpu: 'CPU utilization',
  switches: 'number of context switches',
};

const SAMPLE_PROCESSES = [
  { id: 'P1', arrival: 0, burst: 8, priority: 3 },
  { id: 'P2', arrival: 1, burst: 4, priority: 1 },
  { id: 'P3', arrival: 2, burst: 9, priority: 5 },
  { id: 'P4', arrival: 3, burst: 5, priority: 2 },
  { id: 'P5', arrival: 6, burst: 2, priority: 4 },
];
const SAMPLE_QUANTUM = 3;

// Tiny shared workload used by the six algorithm-explainer cards. Arrivals are
// staggered on purpose so SRTF and Priority (Preemptive) actually get a chance
// to preempt a running process, instead of looking identical to their
// non-preemptive counterparts.
const DEMO_PROCESSES = [
  { id: 'A', arrival: 0, burst: 6, priority: 3 },
  { id: 'B', arrival: 2, burst: 3, priority: 1 },
  { id: 'C', arrival: 4, burst: 2, priority: 2 },
];
const DEMO_QUANTUM = 3;

/* ==========================================================================
   2. Helpers
   ========================================================================== */

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 2 decimals at most, no trailing zeros: 6.2, 5, 3.33
function fmt(n) {
  return String(Math.round(n * 100) / 100);
}

// Distinct hues for any number of processes (golden-angle spacing). Never tied to a process ID.
function hueFor(index) {
  return Math.round((index * GOLDEN_ANGLE + 250) % 360);
}

function hueMap(processes) {
  return new Map(processes.map((p) => [p.id, p.hue]));
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

function unitWord(value) {
  return Math.abs(value - 1) < EPS ? 'time unit' : 'time units';
}

function sameArray(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Bolds plain numbers in already-escaped explanation text ("P1" is left alone).
function emphasizeNumbers(html) {
  return html
    .split(/(\s+)/)
    .map((tok) => {
      const m = tok.match(/^(\(?)(\d+(?:\.\d+)?%?)([),.:;]*)$/);
      return m ? `${m[1]}<b class="num">${m[2]}</b>${m[3]}` : tok;
    })
    .join('');
}

// Splits generated explanation text into sentences (a period followed by a capital letter).
function splitSentences(text) {
  const parts = text.split(/\.\s+(?=[A-Z(])/);
  return parts.map((part, i) => (i < parts.length - 1 && !part.endsWith('.') ? `${part}.` : part));
}

/* ==========================================================================
   3. Scheduling core (pure, no DOM)
   Each algorithm returns raw "slices": [{ pid, start, end }] in execution order.
   generateGanttData() turns slices into Gantt segments (adds idle gaps and merges
   back-to-back slices of the same process), and calculateMetrics() reads only
   those segments, so the tables always agree with the chart.
   ========================================================================== */

// Copies processes and remembers input order, which is the final tie-breaker everywhere.
function prepare(processes) {
  return processes.map((p, i) => ({ id: p.id, arrival: p.arrival, burst: p.burst, priority: p.priority, hue: p.hue, order: i }));
}

const byArrival = (a, b) => a.arrival - b.arrival || a.order - b.order;

/** FCFS: non-preemptive, ordered by arrival time. */
function fcfs(processes) {
  const queue = prepare(processes).sort(byArrival);
  const slices = [];
  let time = queue.length ? queue[0].arrival : 0;
  for (const p of queue) {
    const start = Math.max(time, p.arrival); // CPU idles until the process arrives
    time = start + p.burst;
    slices.push({ pid: p.id, start, end: time });
  }
  return slices;
}

/** SJF (non-preemptive): among arrived processes pick the shortest burst.
 *  Ties: earlier arrival first, then input order. */
function sjf(processes) {
  const pending = prepare(processes);
  const slices = [];
  let time = pending.length ? Math.min(...pending.map((p) => p.arrival)) : 0;
  while (pending.length) {
    const ready = pending.filter((p) => p.arrival <= time);
    if (!ready.length) {
      time = Math.min(...pending.map((p) => p.arrival)); // idle until the next arrival
      continue;
    }
    ready.sort((a, b) => a.burst - b.burst || a.arrival - b.arrival || a.order - b.order);
    const p = ready[0];
    slices.push({ pid: p.id, start: time, end: time + p.burst });
    time += p.burst;
    pending.splice(pending.indexOf(p), 1);
  }
  return slices;
}

/** Priority (non-preemptive): among arrived processes pick the best (lowest number)
 *  priority. Same shape as sjf(), just a different comparator.
 *  Ties: earlier arrival first, then input order. */
function priorityNonPreemptive(processes) {
  const pending = prepare(processes);
  const slices = [];
  let time = pending.length ? Math.min(...pending.map((p) => p.arrival)) : 0;
  while (pending.length) {
    const ready = pending.filter((p) => p.arrival <= time);
    if (!ready.length) {
      time = Math.min(...pending.map((p) => p.arrival));
      continue;
    }
    ready.sort((a, b) => a.priority - b.priority || a.arrival - b.arrival || a.order - b.order);
    const p = ready[0];
    slices.push({ pid: p.id, start: time, end: time + p.burst });
    time += p.burst;
    pending.splice(pending.indexOf(p), 1);
  }
  return slices;
}

/** Shared engine for both preemptive algorithms (SRTF and Priority-Preemptive).
 *  At every decision point it runs whichever ready process `keyOf` ranks best
 *  (lowest value wins), for as long as that stays true: either until the process
 *  finishes, or until the next arrival, whichever comes first. Re-deciding at
 *  every arrival is exactly what makes this genuinely preemptive rather than a
 *  fixed schedule with preemption drawn on afterwards.
 *  Ties: earlier arrival first, then input order. */
function preemptiveBy(processes, keyOf) {
  const list = prepare(processes).sort(byArrival);
  const remaining = new Map(list.map((p) => [p.order, p.burst]));
  let time = list.length ? list[0].arrival : 0;
  const slices = [];
  let finished = 0;

  while (finished < list.length) {
    const ready = list.filter((p) => p.arrival <= time && remaining.get(p.order) > 0);
    if (!ready.length) {
      const future = list.filter((p) => p.arrival > time);
      time = Math.min(...future.map((p) => p.arrival)); // CPU idle: jump to the next arrival
      continue;
    }
    ready.sort((a, b) => keyOf(a, remaining) - keyOf(b, remaining) || a.arrival - b.arrival || a.order - b.order);
    const p = ready[0];
    const future = list.filter((x) => x.arrival > time);
    const nextArrival = future.length ? Math.min(...future.map((x) => x.arrival)) : Infinity;
    const finishTime = time + remaining.get(p.order);
    const runUntil = Math.min(nextArrival, finishTime);

    slices.push({ pid: p.id, start: time, end: runUntil });
    remaining.set(p.order, remaining.get(p.order) - (runUntil - time));
    time = runUntil;
    if (remaining.get(p.order) <= 0) finished += 1;
  }
  return slices;
}

/** SRTF: preemptive, always runs whoever has the least burst time left. */
function srtf(processes) {
  return preemptiveBy(processes, (p, remaining) => remaining.get(p.order));
}

/** Priority (preemptive): always runs whoever has the best (lowest number)
 *  priority; a process's priority does not change while it runs. */
function priorityPreemptive(processes) {
  return preemptiveBy(processes, (p) => p.priority);
}

/** Round Robin (preemptive) with a fixed time quantum.
 *  Convention: processes that arrive while a slice runs (or exactly when it ends)
 *  join the ready queue before the preempted process is put back at the tail. */
function roundRobin(processes, quantum) {
  const list = prepare(processes).sort(byArrival);
  const remaining = new Map(list.map((p) => [p.order, p.burst]));
  const ready = [];
  const slices = [];
  let next = 0; // index of the next process that has not arrived yet
  let time = list.length ? list[0].arrival : 0;
  let finished = 0;

  const admitArrivals = () => {
    while (next < list.length && list[next].arrival <= time) ready.push(list[next++]);
  };

  admitArrivals();
  while (finished < list.length) {
    if (ready.length === 0) {
      time = list[next].arrival; // CPU idle: jump to the next arrival
      admitArrivals();
      continue;
    }
    const p = ready.shift();
    const run = Math.min(quantum, remaining.get(p.order));
    slices.push({ pid: p.id, start: time, end: time + run });
    time += run;
    remaining.set(p.order, remaining.get(p.order) - run);
    admitArrivals(); // new arrivals first...
    if (remaining.get(p.order) > 0) ready.push(p); // ...then the preempted process
    else finished += 1;
  }
  return slices;
}

/** Slices -> Gantt segments. `pid: null` marks CPU idle time. */
function generateGanttData(slices, startTime) {
  const segments = [];
  let cursor = startTime;
  for (const s of slices) {
    if (s.start > cursor) segments.push({ pid: null, start: cursor, end: s.start });
    const last = segments[segments.length - 1];
    if (last && last.pid === s.pid && last.end === s.start) last.end = s.end;
    else segments.push({ pid: s.pid, start: s.start, end: s.end });
    cursor = s.end;
  }
  return segments;
}

/** Per-process and overall metrics, derived from the Gantt segments.
 *  Turnaround = completion - arrival, Waiting = turnaround - burst,
 *  Response = first start - arrival. Correct for preemptive schedules too:
 *  a process's first start may come long before its last (completing) slice. */
function calculateMetrics(processes, segments, startTime) {
  const firstStart = new Map();
  const lastEnd = new Map();
  let busy = 0;
  let switches = 0;
  let previous = null;

  for (const seg of segments) {
    if (seg.pid === null) continue;
    if (!firstStart.has(seg.pid)) firstStart.set(seg.pid, seg.start);
    lastEnd.set(seg.pid, seg.end);
    busy += seg.end - seg.start;
    if (previous !== null && previous !== seg.pid) switches += 1;
    previous = seg.pid;
  }

  const rows = processes.map((p) => {
    const completion = lastEnd.get(p.id);
    const start = firstStart.get(p.id);
    const turnaround = completion - p.arrival;
    return {
      id: p.id,
      arrival: p.arrival,
      burst: p.burst,
      priority: p.priority,
      start,
      completion,
      turnaround,
      waiting: turnaround - p.burst,
      response: start - p.arrival,
    };
  });

  const average = (key) => rows.reduce((sum, r) => sum + r[key], 0) / rows.length;
  const endTime = segments.length ? segments[segments.length - 1].end : startTime;
  const span = endTime - startTime;

  return {
    rows,
    avg: { waiting: average('waiting'), turnaround: average('turnaround'), response: average('response') },
    cpuUtilization: span > 0 ? (busy / span) * 100 : 0,
    contextSwitches: switches,
    busyTime: busy,
    idleTime: span - busy,
    startTime,
    endTime,
  };
}

// Every implemented algorithm, keyed the same way as ALGO_ORDER/ALGO_INFO.
// fcfs/sjf/srtf/prio/prioP ignore the quantum argument; only rr uses it.
const ALGO_RUN = {
  fcfs: (p) => fcfs(p),
  sjf: (p) => sjf(p),
  srtf: (p) => srtf(p),
  prio: (p) => priorityNonPreemptive(p),
  prioP: (p) => priorityPreemptive(p),
  rr: (p, quantum) => roundRobin(p, quantum),
};

/** Runs every algorithm in `selected` (default: all six) on the same workload. */
function runAll(processes, quantum, selected = DEFAULT_ALGOS) {
  const procs = prepare(processes);
  if (!procs.length) throw new Error('At least one process is required.');
  const keys = ALGO_ORDER.filter((k) => selected.includes(k));
  if (!keys.length) throw new Error('At least one algorithm must be selected.');
  const startTime = Math.min(...procs.map((p) => p.arrival));

  const algos = keys.map((key) => {
    const segments = generateGanttData(ALGO_RUN[key](procs, quantum), startTime);
    return { key, name: ALGO_INFO[key].name, segments, ...calculateMetrics(procs, segments, startTime) };
  });
  const endTime = Math.max(...algos.map((a) => a.endTime));
  return { processes: procs, quantum, startTime, endTime, algos };
}

/** For each metric: every algorithm's value plus lowest / highest flags for THIS workload.
 *  No overall winner is computed on purpose. Works for any number (>=1) of algorithms. */
function compareResults(sim) {
  return METRICS.map((m) => {
    const values = sim.algos.map((a) => ({ key: a.key, name: a.name, value: m.get(a) }));
    const nums = values.map((v) => v.value);
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    const allEqual = hi - lo < EPS;
    return {
      key: m.key,
      label: m.label,
      term: m.term,
      unit: m.unit,
      allEqual,
      scaleMax: m.key === 'cpu' ? 100 : hi,
      values: values.map((v) => ({
        ...v,
        isLowest: !allEqual && v.value - lo < EPS,
        isHighest: !allEqual && hi - v.value < EPS,
      })),
    };
  });
}

/** Sanity checks used by the tests and logged (never thrown) in the browser. Returns a list of problems.
 *  Fully generic over sim.algos, so it verifies every algorithm the same way. */
function verifySimulation(sim) {
  const problems = [];
  for (const algo of sim.algos) {
    let cursor = sim.startTime;
    const ran = new Map();
    for (const seg of algo.segments) {
      if (seg.start < cursor) problems.push(`${algo.name}: overlapping segments at ${seg.start}`);
      if (seg.end <= seg.start) problems.push(`${algo.name}: empty segment at ${seg.start}`);
      cursor = seg.end;
      if (seg.pid !== null) {
        const p = sim.processes.find((x) => x.id === seg.pid);
        if (seg.start < p.arrival) problems.push(`${algo.name}: ${seg.pid} ran before it arrived`);
        ran.set(seg.pid, (ran.get(seg.pid) || 0) + (seg.end - seg.start));
      }
    }
    for (const p of sim.processes) {
      if (ran.get(p.id) !== p.burst) problems.push(`${algo.name}: ${p.id} ran ${ran.get(p.id)} of ${p.burst}`);
    }
    for (const r of algo.rows) {
      if (r.waiting < 0 || r.response < 0) problems.push(`${algo.name}: negative time for ${r.id}`);
      if (r.turnaround !== r.completion - r.arrival) problems.push(`${algo.name}: turnaround mismatch for ${r.id}`);
      if (r.response > r.waiting + EPS) problems.push(`${algo.name}: response > waiting for ${r.id}`);
    }
  }
  return problems;
}

/* ==========================================================================
   4. Validation
   ========================================================================== */

function parseWhole(value) {
  const s = String(value).trim();
  if (!/^-?\d+$/.test(s)) return { ok: false };
  return { ok: true, value: Number(s) };
}

/** Validates one process. `ignoreId` is the process being edited (so it may keep its own ID). */
function validateProcessInput(input, existing, ignoreId = null) {
  const errors = {};
  const id = String(input.id).trim();

  if (!id) errors.id = 'Enter a process ID, for example P1.';
  else if (id.length > LIMITS.maxIdLength) errors.id = `Process ID can have at most ${LIMITS.maxIdLength} characters.`;
  else if (!/^[A-Za-z0-9_-]+$/.test(id)) errors.id = 'Use only letters, numbers, - or _ in a process ID.';
  else if (existing.some((p) => p.id.toLowerCase() === id.toLowerCase() && p.id !== ignoreId))
    errors.id = `"${id}" is already used. Choose a unique process ID.`;

  const arrival = parseWhole(input.arrival);
  if (!arrival.ok || arrival.value < 0) errors.arrival = 'Arrival time must be a whole number, 0 or more.';
  else if (arrival.value > LIMITS.maxValue) errors.arrival = `Arrival time can be at most ${LIMITS.maxValue}.`;

  const burst = parseWhole(input.burst);
  if (!burst.ok || burst.value <= 0) errors.burst = 'Burst time must be a whole number greater than 0.';
  else if (burst.value > LIMITS.maxValue) errors.burst = `Burst time can be at most ${LIMITS.maxValue}.`;

  const priority = parseWhole(input.priority);
  if (!priority.ok || priority.value < 1) errors.priority = 'Priority must be a whole number, 1 or more (1 is the highest priority).';
  else if (priority.value > LIMITS.maxPriority) errors.priority = `Priority can be at most ${LIMITS.maxPriority}.`;

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    values: { id, arrival: arrival.value, burst: burst.value, priority: priority.value },
  };
}

function validateQuantum(value) {
  const q = parseWhole(value);
  if (!q.ok || q.value <= 0) return { valid: false, error: 'Time quantum must be a whole number greater than 0.' };
  if (q.value > LIMITS.maxValue) return { valid: false, error: `Time quantum can be at most ${LIMITS.maxValue}.` };
  return { valid: true, value: q.value };
}

/* ==========================================================================
   5. "Why did this happen?" explanations
   Every sentence is read off the simulation's own numbers, so nothing here is
   hardcoded to a fixed set of algorithms: each helper only runs when its
   algorithm was actually selected, and cross-algorithm comparisons (e.g. "SJF
   vs FCFS") fall back to a standalone description when the other side of the
   comparison was not selected.
   ========================================================================== */

function processField(sim, id, key) {
  const p = sim.processes.find((x) => x.id === id);
  return p ? p[key] : undefined;
}

/** FCFS: which process waited longest, and which earlier arrivals caused it. */
function explainFcfs(algo) {
  const worst = algo.rows.reduce((a, b) => (b.waiting > a.waiting ? b : a), algo.rows[0]);
  if (worst.waiting <= EPS) {
    return { algo: 'fcfs', lead: 'FCFS', text: 'No process waited under FCFS: each one started the moment it arrived.' };
  }
  const blockers = algo.rows.filter((x) => x.id !== worst.id && x.start < worst.start && x.completion > worst.arrival);
  const longest = blockers.reduce((a, b) => (b.burst > a.burst ? b : a), blockers[0]);
  const text =
    blockers.length === 1
      ? `${worst.id} waited longest under FCFS (${worst.waiting} ${unitWord(worst.waiting)}) because ${longest.id} kept the CPU for ${longest.burst} ${unitWord(longest.burst)} before it could start.`
      : `${worst.id} waited longest under FCFS (${worst.waiting} ${unitWord(worst.waiting)}) because ${joinList(blockers.map((b) => b.id))} were ahead of it in arrival order. The longest of them, ${longest.id}, kept the CPU for ${longest.burst} ${unitWord(longest.burst)}.`;
  return { algo: 'fcfs', lead: 'FCFS', text };
}

/** Shared explainer for the two non-preemptive "greedy" algorithms (SJF and
 *  Priority): compares against FCFS when FCFS was also selected, otherwise
 *  just describes the run order this algorithm chose. */
function explainGreedyNonPreemptive(algo, fcfsAlgo, opts) {
  const order = algo.segments.filter((s) => s.pid !== null).map((s) => s.pid);
  if (!fcfsAlgo) {
    const desc = order.length <= 6 ? order.join(' \u2192 ') : `${order.length} processes`;
    return { algo: opts.key, lead: opts.label, text: `${opts.label} ran the processes in this order: ${desc}, choosing at each decision the ready process with ${opts.criterion}.` };
  }
  const fcfsOrder = fcfsAlgo.segments.filter((s) => s.pid !== null).map((s) => s.pid);
  if (sameArray(fcfsOrder, order)) {
    return {
      algo: opts.key,
      lead: `${opts.label} and FCFS`,
      text: `Both ran the processes in the same order (${fcfsOrder.join(' \u2192 ')}), so their waiting, turnaround and response times are identical. That happens when, at every decision, the process that arrived first also has ${opts.criterion}.`,
    };
  }
  const i = fcfsOrder.findIndex((id, k) => id !== order[k]);
  const early = order[i];
  const passed = fcfsOrder[i];
  let text = `${opts.label} started ${early} (${opts.fieldLabel} ${opts.fieldOf(early)}) before ${passed} (${opts.fieldLabel} ${opts.fieldOf(passed)}), even though ${passed} was ahead of it in arrival order.`;
  const diff = algo.avg.waiting - fcfsAlgo.avg.waiting;
  if (diff < -EPS)
    text += ` Choosing ${opts.criterion} lowered the average waiting time from ${fmt(fcfsAlgo.avg.waiting)} (FCFS) to ${fmt(algo.avg.waiting)} (${opts.label}).`;
  else if (diff > EPS)
    text += ` For this workload that did not lower the average waiting time: ${opts.label} averaged ${fmt(algo.avg.waiting)} against ${fmt(fcfsAlgo.avg.waiting)} for FCFS. Choosing ${opts.criterion} is a greedy rule, so it is not guaranteed to win when arrival times differ.`;
  else text += ` The average waiting time still came out the same (${fmt(fcfsAlgo.avg.waiting)}).`;
  return { algo: opts.key, lead: `${opts.label} vs FCFS`, text };
}

/** Finds every point where a process was interrupted before it finished:
 *  two adjacent non-idle segments with different process IDs, where the first
 *  one's process had not yet reached its completion time. */
function findPreemptions(algo) {
  const segs = algo.segments.filter((s) => s.pid !== null);
  const events = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const cur = segs[i];
    const next = segs[i + 1];
    if (cur.pid === next.pid) continue;
    const row = algo.rows.find((r) => r.id === cur.pid);
    if (row.completion !== cur.end) events.push({ time: cur.end, preempted: cur.pid, by: next.pid });
  }
  return events;
}

/** Shared explainer for the two preemptive algorithms (SRTF and Priority-Preemptive):
 *  names the first real preemption event, and compares against the matching
 *  non-preemptive algorithm's average waiting time when it was also selected. */
function explainPreemptive(algo, opts) {
  const events = findPreemptions(algo);
  let text;
  if (!events.length) {
    text = `No process was preempted under ${opts.label} for this workload: once a process had the best available choice, nothing arrived that could take over before it finished.`;
  } else {
    const e = events[0];
    text = `${e.preempted} was preempted at time ${e.time} because ${e.by} arrived with ${opts.reason}.`;
    if (events.length > 1) text += ` This happened ${events.length} times in total under ${opts.label}.`;
  }
  if (opts.compareAlgo) {
    const diff = algo.avg.waiting - opts.compareAlgo.avg.waiting;
    if (diff < -EPS)
      text += ` Reacting to new arrivals lowered the average waiting time from ${fmt(opts.compareAlgo.avg.waiting)} (${opts.compareLabel}) to ${fmt(algo.avg.waiting)} (${opts.label}).`;
    else if (diff > EPS)
      text += ` For this workload that did not lower the average waiting time: ${opts.label} averaged ${fmt(algo.avg.waiting)} against ${fmt(opts.compareAlgo.avg.waiting)} for ${opts.compareLabel}.`;
  }
  return { algo: opts.key, lead: opts.label, text };
}

/** Round Robin: how many processes got interrupted by the quantum, and how that
 *  compares with the other selected algorithms' response/turnaround times. */
function explainRR(sim, algo, fcfsAlgo, sjfAlgo) {
  const turns = new Map();
  algo.segments.forEach((seg) => seg.pid !== null && turns.set(seg.pid, (turns.get(seg.pid) || 0) + 1));
  const interrupted = [...turns].filter(([, count]) => count > 1).map(([id]) => id);
  const q = sim.quantum;
  let text;
  if (!interrupted.length) {
    const matchesFcfs = fcfsAlgo && JSON.stringify(algo.segments) === JSON.stringify(fcfsAlgo.segments);
    text = `With a time quantum of ${q}, no process was switched out before it finished${matchesFcfs ? ', so Round Robin produced the same schedule as FCFS' : ''}.`;
  } else {
    const who = interrupted.length <= 4 ? joinList(interrupted) : `${interrupted.length} processes`;
    const csNote = [];
    if (fcfsAlgo) csNote.push(`FCFS: ${fcfsAlgo.contextSwitches}`);
    if (sjfAlgo) csNote.push(`SJF: ${sjfAlgo.contextSwitches}`);
    text = `With a time quantum of ${q}, ${who} ${interrupted.length === 1 ? 'was' : 'were'} switched out before finishing, which gave Round Robin ${algo.contextSwitches} context switches${csNote.length ? ` (${csNote.join(', ')})` : ''}.`;
    const others = sim.algos.filter((a) => a.key !== 'rr');
    if (others.length) {
      const minResp = Math.min(...others.map((a) => a.avg.response));
      if (algo.avg.response < minResp - EPS)
        text += ` It also had the lowest average response time (${fmt(algo.avg.response)}) among the selected algorithms, because slicing the CPU let processes take their first turn sooner.`;
      const maxTat = Math.max(...others.map((a) => a.avg.turnaround));
      if (algo.avg.turnaround > maxTat + EPS)
        text += ` Its average turnaround time (${fmt(algo.avg.turnaround)}) was the highest among the selected algorithms, since interleaving delays the finish of longer processes.`;
    }
    text += ' This simulator counts context switches but does not add time for them.';
  }
  return { algo: 'rr', lead: 'Round Robin', text };
}

/** One card summarizing, metric by metric, which selected algorithm(s) were
 *  lowest and highest for this workload. Built directly from compareResults(),
 *  so it is correct for any subset of 2-6 algorithms and never declares an
 *  overall winner. */
function explainMetricComparisons(sim) {
  const rows = compareResults(sim);
  const sentences = rows.map((m) => {
    const unit = m.key === 'cpu' ? '%' : '';
    if (m.allEqual) return `${m.label} was the same for every selected algorithm (${fmt(m.values[0].value)}${unit}).`;
    const lowNames = joinList(m.values.filter((v) => v.isLowest).map((v) => v.name));
    const highNames = joinList(m.values.filter((v) => v.isHighest).map((v) => v.name));
    const lowVal = fmt(m.values.find((v) => v.isLowest).value);
    const highVal = fmt(m.values.find((v) => v.isHighest).value);
    return `${lowNames} had the lowest ${METRIC_PHRASE[m.key]} for this workload (${lowVal}${unit}), and ${highNames} had the highest (${highVal}${unit}).`;
  });
  return [{ algo: 'all', lead: 'Across the selected algorithms', text: sentences.join(' ') }];
}

/** Builds one explanation card per selected algorithm, plus a cross-algorithm
 *  summary when two or more were selected. */
function buildInsights(sim) {
  if (sim.processes.length === 1) {
    return [{
      algo: 'all',
      lead: 'One process',
      text: 'With a single process, every selected algorithm runs it the same way, so all of its metrics match. Add more processes to see them diverge.',
    }];
  }

  const byKey = Object.fromEntries(sim.algos.map((a) => [a.key, a]));
  const has = (k) => byKey[k];
  const items = [];

  if (has('fcfs')) items.push(explainFcfs(byKey.fcfs));
  if (has('sjf'))
    items.push(
      explainGreedyNonPreemptive(byKey.sjf, has('fcfs') ? byKey.fcfs : null, {
        key: 'sjf', label: 'SJF', fieldLabel: 'burst',
        fieldOf: (id) => processField(sim, id, 'burst'),
        criterion: 'a shorter burst time',
      })
    );
  if (has('prio'))
    items.push(
      explainGreedyNonPreemptive(byKey.prio, has('fcfs') ? byKey.fcfs : null, {
        key: 'prio', label: 'Priority', fieldLabel: 'priority',
        fieldOf: (id) => processField(sim, id, 'priority'),
        criterion: 'a better (lower) priority number',
      })
    );
  if (has('srtf'))
    items.push(
      explainPreemptive(byKey.srtf, {
        key: 'srtf', label: 'SRTF',
        reason: 'a shorter remaining burst time than the process that was running',
        compareAlgo: has('sjf') ? byKey.sjf : null, compareLabel: 'SJF',
      })
    );
  if (has('prioP'))
    items.push(
      explainPreemptive(byKey.prioP, {
        key: 'prioP', label: 'Priority (Preemptive)',
        reason: 'a better priority number than the process that was running',
        compareAlgo: has('prio') ? byKey.prio : null, compareLabel: 'Priority',
      })
    );
  if (has('rr')) items.push(explainRR(sim, byKey.rr, has('fcfs') ? byKey.fcfs : null, has('sjf') ? byKey.sjf : null));

  if (sim.algos.length >= 2) items.push(...explainMetricComparisons(sim));
  return items;
}

/* ==========================================================================
   6. UI state and rendering
   ========================================================================== */

const state = {
  processes: [], // { id, arrival, burst, priority, hue }
  quantum: SAMPLE_QUANTUM,
  selectedAlgos: new Set(DEFAULT_ALGOS),
  hueCounter: 0,
  sim: null,
  editingId: null,
  heroIntroPlayed: false,
  runToken: 0,
};
const dom = {};
const ui = { inner: null, lanes: [] };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function selectedAlgoList() {
  return ALGO_ORDER.filter((k) => state.selectedAlgos.has(k));
}

/* ----- icons (small inline SVGs) ----- */
const ICONS = {
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M12 2v2', 'M12 20v2', 'M4.93 4.93l1.41 1.41', 'M17.66 17.66l1.41 1.41', 'M2 12h2', 'M20 12h2', 'M6.34 17.66l-1.41 1.41', 'M19.07 4.93l-1.41 1.41'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  plus: ['M12 5v14', 'M5 12h14'],
  pencil: ['M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z', 'M15 5l4 4'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  shuffle: ['M16 3h5v5', 'M4 20 21 3', 'M21 16v5h-5', 'M15 15l6 6', 'M4 4l5 5'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  cpu: ['M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M9 9h6v6H9z', 'M9 2v2', 'M15 2v2', 'M9 20v2', 'M15 20v2', 'M2 9h2', 'M2 15h2', 'M20 9h2', 'M20 15h2'],
  'arrow-down': ['M12 5v14', 'm19 12-7 7-7-7'],
  'arrow-up': ['M12 19V5', 'm5 12 7-7 7 7'],
  bulb: ['M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5', 'M9 18h6', 'M10 22h4'],
  play: ['M7 4.5v15l12-7.5z'],
  pause: ['M8 5v14', 'M16 5v14'],
  rotate: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
};

function icon(name, size = 18) {
  const paths = (ICONS[name] || []).map((d) => `<path d="${d}"/>`).join('');
  return `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function hydrateIcons(root) {
  $$('[data-icon]', root).forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
}

/* ----- tooltip terms ----- */
function term(key, label) {
  return `<button type="button" class="term" data-tip="${esc(TERMS[key])}" aria-describedby="tooltip">${label}</button>`;
}

/* ----- small message helper ----- */
function showMsg(el, text, kind = 'error') {
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = false;
}
function clearMsg(el) {
  el.textContent = '';
  el.hidden = true;
}

/* ----- process input ----- */
function nextId() {
  let n = 1;
  const used = new Set(state.processes.map((p) => p.id.toLowerCase()));
  while (used.has(`p${n}`)) n += 1;
  return `P${n}`;
}

function setFieldError(input, message) {
  const err = $(`#err-${input.id}`);
  if (!err) return;
  if (message) {
    err.textContent = message;
    err.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', err.id);
  } else {
    err.textContent = '';
    err.hidden = true;
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }
}

function renderProcessTable() {
  const has = state.processes.length > 0;
  dom.rows.innerHTML = state.processes.map((p) => (state.editingId === p.id ? editRowHtml(p) : viewRowHtml(p))).join('');
  dom.tableWrap.hidden = !has;
  dom.processEmpty.hidden = has;
  dom.count.textContent = `${state.processes.length} of ${LIMITS.maxProcesses} processes`;
  hydrateIcons(dom.rows);
}

function viewRowHtml(p) {
  const id = esc(p.id);
  return `<tr>
    <th scope="row"><span class="swatch" style="--h:${p.hue}"></span>${id}</th>
    <td>${p.arrival}</td>
    <td>${p.burst}</td>
    <td>${p.priority}</td>
    <td class="row-actions">
      <button type="button" class="icon-btn" data-action="edit" data-id="${id}" aria-label="Edit ${id}"><span data-icon="pencil"></span></button>
      <button type="button" class="icon-btn icon-btn--danger" data-action="delete" data-id="${id}" aria-label="Delete ${id}"><span data-icon="trash"></span></button>
    </td>
  </tr>`;
}

function editRowHtml(p) {
  const id = esc(p.id);
  return `<tr class="is-editing">
    <th scope="row"><span class="swatch" style="--h:${p.hue}"></span><input class="cell-input" data-field="id" value="${id}" maxlength="${LIMITS.maxIdLength}" autocomplete="off" aria-label="Process ID"></th>
    <td><input class="cell-input" data-field="arrival" value="${p.arrival}" inputmode="numeric" autocomplete="off" aria-label="Arrival time for ${id}"></td>
    <td><input class="cell-input" data-field="burst" value="${p.burst}" inputmode="numeric" autocomplete="off" aria-label="Burst time for ${id}"></td>
    <td><input class="cell-input" data-field="priority" value="${p.priority}" inputmode="numeric" autocomplete="off" aria-label="Priority for ${id}"></td>
    <td class="row-actions">
      <button type="button" class="icon-btn icon-btn--ok" data-action="save" data-id="${id}" aria-label="Save ${id}"><span data-icon="check"></span></button>
      <button type="button" class="icon-btn" data-action="cancel" data-id="${id}" aria-label="Cancel editing ${id}"><span data-icon="x"></span></button>
    </td>
  </tr>`;
}

function onProcessesChanged() {
  renderProcessTable();
  if (document.activeElement !== dom.pid) dom.pid.value = nextId();
  renderHero();
  if (!state.processes.length) resetSimulation();
  else markStale();
}

function handleAdd(event) {
  event.preventDefault();
  clearMsg(dom.formMsg);
  if (state.editingId) return showMsg(dom.formMsg, 'Save or cancel the row you are editing first.');
  if (state.processes.length >= LIMITS.maxProcesses)
    return showMsg(dom.formMsg, `You can add up to ${LIMITS.maxProcesses} processes. Delete one to add another.`);

  const result = validateProcessInput(
    { id: dom.pid.value, arrival: dom.arrival.value, burst: dom.burst.value, priority: dom.priority.value },
    state.processes
  );
  setFieldError(dom.pid, result.errors.id);
  setFieldError(dom.arrival, result.errors.arrival);
  setFieldError(dom.burst, result.errors.burst);
  setFieldError(dom.priority, result.errors.priority);
  if (!result.valid) {
    const first = [dom.pid, dom.arrival, dom.burst, dom.priority].find((el) => el.getAttribute('aria-invalid') === 'true');
    if (first) first.focus();
    return undefined;
  }

  const { id, arrival, burst, priority } = result.values;
  state.processes.push({ id, arrival, burst, priority, hue: hueFor(state.hueCounter++) });
  dom.arrival.value = '';
  dom.burst.value = '';
  dom.priority.value = '';
  onProcessesChanged();
  dom.pid.value = nextId();
  dom.arrival.focus();
  showMsg(dom.formMsg, `${id} added.`, 'ok');
  return undefined;
}

function handleTableClick(event) {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  clearMsg(dom.tableMsg);

  if (btn.dataset.action === 'edit') {
    state.editingId = id;
    renderProcessTable();
    const first = $('tr.is-editing [data-field="id"]', dom.rows);
    if (first) {
      first.focus();
      first.select();
    }
  } else if (btn.dataset.action === 'cancel') {
    state.editingId = null;
    renderProcessTable();
    focusRowButton('edit', id);
  } else if (btn.dataset.action === 'save') {
    saveEdit(id);
  } else if (btn.dataset.action === 'delete') {
    state.processes = state.processes.filter((p) => p.id !== id);
    if (state.editingId === id) state.editingId = null;
    onProcessesChanged();
    showMsg(dom.tableMsg, `${id} deleted.`, 'ok');
    dom.pid.focus();
  }
}

function focusRowButton(action, id) {
  const btn = $$(`[data-action="${action}"]`, dom.rows).find((b) => b.dataset.id === id);
  if (btn) btn.focus();
}

function saveEdit(oldId) {
  const row = $('tr.is-editing', dom.rows);
  if (!row) return;
  const field = (name) => $(`[data-field="${name}"]`, row);
  const result = validateProcessInput(
    { id: field('id').value, arrival: field('arrival').value, burst: field('burst').value, priority: field('priority').value },
    state.processes,
    oldId
  );
  ['id', 'arrival', 'burst', 'priority'].forEach((name) => field(name).removeAttribute('aria-invalid'));
  if (!result.valid) {
    Object.keys(result.errors).forEach((name) => field(name).setAttribute('aria-invalid', 'true'));
    showMsg(dom.tableMsg, Object.values(result.errors)[0]);
    field(Object.keys(result.errors)[0]).focus();
    return;
  }
  const p = state.processes.find((x) => x.id === oldId);
  Object.assign(p, result.values);
  state.editingId = null;
  onProcessesChanged();
  focusRowButton('edit', p.id);
  showMsg(dom.tableMsg, `${p.id} updated.`, 'ok');
}

function handleTableKeydown(event) {
  if (!event.target.matches('.cell-input')) return;
  const id = state.editingId;
  if (event.key === 'Enter') {
    event.preventDefault();
    saveEdit(id);
  } else if (event.key === 'Escape') {
    state.editingId = null;
    renderProcessTable();
    focusRowButton('edit', id);
  }
}

function loadSample() {
  state.editingId = null;
  state.hueCounter = 0;
  state.processes = SAMPLE_PROCESSES.map((p) => ({ ...p, hue: hueFor(state.hueCounter++) }));
  dom.quantum.value = SAMPLE_QUANTUM;
  state.quantum = SAMPLE_QUANTUM;
  setQuantumError(null);
}

function loadRandom() {
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const count = rand(4, 7);
  state.editingId = null;
  state.hueCounter = 0;
  state.processes = Array.from({ length: count }, (_, i) => ({
    id: `P${i + 1}`,
    arrival: rand(0, 10),
    burst: rand(1, 9),
    priority: rand(1, 5), // a small range so priority ties show up naturally
    hue: hueFor(state.hueCounter++),
  }));
}

function clearAll() {
  state.editingId = null;
  state.processes = [];
}

function setQuantumError(message) {
  if (message) {
    showMsg(dom.quantumMsg, message);
    dom.quantum.setAttribute('aria-invalid', 'true');
  } else {
    clearMsg(dom.quantumMsg);
    dom.quantum.removeAttribute('aria-invalid');
  }
}

function handleQuantumInput() {
  const result = validateQuantum(dom.quantum.value);
  if (!result.valid) return setQuantumError(result.error);
  setQuantumError(null);
  if (result.value !== state.quantum) {
    state.quantum = result.value;
    renderHero();
    if (state.sim) markStale();
  }
  return undefined;
}

/* ----- algorithm selection ----- */
function renderAlgoSummary() {
  const list = selectedAlgoList();
  dom.algoSummary.textContent = list.length
    ? `Comparing: ${list.map((k) => ALGO_INFO[k].name).join(', ')}.`
    : 'No algorithms selected.';
}

function handleAlgoToggle(event) {
  const key = event.target.value;
  if (event.target.checked) state.selectedAlgos.add(key);
  else state.selectedAlgos.delete(key);
  clearMsg(dom.algoMsg);
  renderAlgoSummary();
  renderHero();
  if (state.sim) markStale();
}

/* ----- algorithm cards (tiny example charts, shared across all six) ----- */
function renderAlgoCards() {
  const demo = DEMO_PROCESSES.map((p, i) => ({ ...p, hue: hueFor(i) }));
  const sim = runAll(demo, DEMO_QUANTUM, ALGO_ORDER);
  const hues = hueMap(demo);
  sim.algos.forEach((algo) => {
    const target = $(`[data-mini="${algo.key}"]`);
    if (target) renderGanttChart(target, algo, { startTime: sim.startTime, endTime: sim.endTime, hues, size: 'mini', axis: true });
    const meta = $(`[data-mini-meta="${algo.key}"]`);
    if (meta) {
      const order = algo.segments.map((seg) => seg.pid).join(' \u2192 ');
      meta.innerHTML = `<p class="mini-order"><span>Runs</span>${order}</p>
        <dl class="mini-stats">
          <div><dt>${term('waiting', 'Avg waiting')}</dt><dd>${fmt(algo.avg.waiting)}</dd></div>
          <div><dt>${term('response', 'Avg response')}</dt><dd>${fmt(algo.avg.response)}</dd></div>
        </dl>`;
    }
  });
}

/* ----- Gantt chart ----- */
/**
 * Draws one algorithm's Gantt chart into `container`.
 * opts: { startTime, endTime, hues: Map(pid -> hue), size: 'full' | 'compact' | 'mini', axis?: boolean }
 * Colors come from each process's own hue, so they are identical in every lane.
 */
function renderGanttChart(container, algo, opts) {
  const size = opts.size || 'full';
  const span = Math.max(opts.endTime - opts.startTime, 1);
  const pos = (t) => ((t - opts.startTime) / span) * 100;

  const blocks = algo.segments
    .map((seg) => {
      const left = pos(seg.start);
      const width = pos(seg.end) - left;
      const geometry = `left:${left}%;width:${width}%`;
      if (seg.pid === null) {
        return `<div class="block block--idle" style="${geometry}" role="img" aria-label="CPU idle from ${seg.start} to ${seg.end}" title="CPU idle: ${seg.start} to ${seg.end}"><span>idle</span></div>`;
      }
      const id = esc(seg.pid);
      return `<div class="block" style="${geometry};--h:${opts.hues.get(seg.pid)}" role="img" aria-label="${id} runs from ${seg.start} to ${seg.end}" title="${id}: ${seg.start} to ${seg.end}"><span>${id}</span></div>`;
    })
    .join('');

  let axis = '';
  let extras = '';
  let switchMarks = '';
  if (size === 'full' || opts.axis) {
    const times = [...new Set(algo.segments.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
    axis = `<div class="gantt-axis" aria-hidden="true">${times.map((t) => `<span class="tick" style="left:${pos(t)}%">${t}</span>`).join('')}</div>`;
  }
  if (size === 'full') {
    extras = '<div class="gantt-cover"></div><div class="gantt-playhead"></div>';
    const nonIdle = algo.segments.filter((s) => s.pid !== null);
    for (let i = 0; i < nonIdle.length - 1; i++) {
      if (nonIdle[i].pid === nonIdle[i + 1].pid) continue;
      switchMarks += `<span class="switch-mark" style="left:${pos(nonIdle[i].end)}%" title="Context switch at ${nonIdle[i].end}" aria-hidden="true"></span>`;
    }
  }

  const minWidth = size === 'full' ? `--plot-min:${Math.ceil(span * MIN_PX_PER_UNIT)}px` : '';
  container.innerHTML = `<div class="gantt gantt--${size}" style="${minWidth}"><div class="gantt-plot">${blocks}${extras}${switchMarks}</div>${axis}</div>`;
}

/* ----- hero preview (same renderer, compact) ----- */
function renderHero() {
  if (!state.processes.length) {
    dom.heroLanes.innerHTML = '<p class="preview-empty">Add a few processes to preview the schedules here.</p>';
    dom.heroCaption.textContent = '';
    return;
  }
  const selected = selectedAlgoList();
  if (selected.length < MIN_COMPARE) {
    dom.heroLanes.innerHTML = `<p class="preview-empty">Select at least ${MIN_COMPARE} algorithms below to preview a comparison here.</p>`;
    dom.heroCaption.textContent = '';
    return;
  }
  const sim = runAll(state.processes, state.quantum, selected);
  const hues = hueMap(state.processes);
  dom.heroLanes.innerHTML = sim.algos
    .map(
      (a) => `<div class="preview-row">
        <span class="preview-label"><i class="dot" style="background:var(--c-${a.key})"></i>${a.name}</span>
        <div data-preview="${a.key}"></div>
      </div>`
    )
    .join('');
  sim.algos.forEach((a) => {
    renderGanttChart($(`[data-preview="${a.key}"]`, dom.heroLanes), a, { startTime: sim.startTime, endTime: sim.endTime, hues, size: 'compact' });
  });
  const n = state.processes.length;
  dom.heroCaption.textContent = `${n} ${n === 1 ? 'process' : 'processes'}, one workload, ${sim.algos.length} different schedules.`;
  if (!state.heroIntroPlayed) {
    dom.heroLanes.classList.add('is-intro'); // the page's one entrance animation
    state.heroIntroPlayed = true;
    setTimeout(() => dom.heroLanes.classList.remove('is-intro'), 1600); // so later re-renders don't replay it
  }
}

/* ----- race lanes ----- */
function renderRace(sim) {
  const hues = hueMap(sim.processes);
  const n = sim.processes.length;
  dom.raceLanes.innerHTML = `<div class="race-inner" data-state="paused">${sim.algos
    .map(
      (a) => `<section class="lane" aria-label="${a.name} schedule">
        <div class="lane-head">
          <span class="dot dot--lg" style="background:var(--c-${a.key})"></span>
          <h3>${a.name}</h3>
          ${a.key === 'rr' ? `<span class="chip">Quantum ${sim.quantum}</span>` : ''}
          <span class="chip chip--now" data-role="now" data-kind="ready"><i class="swatch"></i><span data-role="now-text"></span></span>
          <span class="chip chip--accent" data-role="done">0 of ${n} finished</span>
          <span class="chip" data-role="switches">0 switches so far</span>
        </div>
        <div class="lane-queue">
          <span class="lane-queue-label">Waiting</span>
          <div class="queue-chips" data-role="queue"><span class="queue-empty">None</span></div>
        </div>
        <div data-role="chart"></div>
      </section>`
    )
    .join('')}</div>`;

  ui.inner = dom.raceLanes.firstElementChild;
  ui.lanes = sim.algos.map((algo, i) => {
    const lane = ui.inner.children[i];
    renderGanttChart($('[data-role="chart"]', lane), algo, { startTime: sim.startTime, endTime: sim.endTime, hues, size: 'full' });
    const blocks = $$('.block', lane);
    // One lookup per process: the index of the segment where it actually finishes,
    // used to place the persistent "done" checkmark regardless of scrub direction.
    const finalSegIdx = new Map(algo.rows.map((r) => [r.id, algo.segments.findIndex((s) => s.pid === r.id && s.end === r.completion)]));
    return {
      algo, hues, finalSegIdx,
      now: $('[data-role="now"]', lane), nowText: $('[data-role="now-text"]', lane),
      done: $('[data-role="done"]', lane), switches: $('[data-role="switches"]', lane),
      queue: $('[data-role="queue"]', lane),
      blocks,
      playhead: $('.gantt-playhead', lane),
      activeIdx: -2,
      last: {},
    };
  });
}

/* ----- comparison dashboard ----- */
function renderComparison(sim) {
  const metrics = compareResults(sim);
  dom.compareRoot.innerHTML = metrics
    .map((m) => {
      const isPercent = m.key === 'cpu';
      const show = (value) => `${fmt(value)}${isPercent ? '%' : ''}`;
      const unitLabel = { waiting: 'in time units', turnaround: 'in time units', response: 'in time units', cpu: 'percent of time busy', switches: 'count' }[m.key];

      const rows = m.values
        .map((v) => {
          const width = m.scaleMax > 0 ? Math.min(100, (v.value / m.scaleMax) * 100) : 0;
          const mark = v.isLowest
            ? `<span class="mark mark--low">${icon('arrow-down', 12)}<span class="sr-only">Lowest for this workload</span></span>`
            : v.isHighest
              ? `<span class="mark mark--high">${icon('arrow-up', 12)}<span class="sr-only">Highest for this workload</span></span>`
              : '';
          return `<li class="bar-row${v.isLowest ? ' is-low' : ''}${v.isHighest ? ' is-high' : ''}">
            <span class="bar-name"><i class="dot" style="background:var(--c-${v.key})"></i>${v.name}</span>
            <span class="bar-value">${mark}${show(v.value)}</span>
            <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="--w:${width}%;background:var(--c-${v.key})"></div></div>
          </li>`;
        })
        .join('');

      // Plain-language read-out of the same numbers. Ties are named together; no overall winner exists.
      const namesOf = (flag) => joinList(m.values.filter((v) => v[flag]).map((v) => v.name));
      const valueOf = (flag) => show(m.values.find((v) => v[flag]).value);
      const summary = m.allEqual
        ? `<li class="sum sum--same"><span class="sum-label">Same for all</span><span class="sum-value"><strong>${show(m.values[0].value)}</strong></span></li>`
        : `<li class="sum sum--low"><span class="sum-label">${icon('arrow-down', 14)}Lowest</span><span class="sum-value"><strong>${namesOf('isLowest')}</strong> ${valueOf('isLowest')}</span></li>
           <li class="sum sum--high"><span class="sum-label">${icon('arrow-up', 14)}Highest</span><span class="sum-value"><strong>${namesOf('isHighest')}</strong> ${valueOf('isHighest')}</span></li>`;

      return `<article class="metric">
        <div class="metric-head">
          <h3>${term(m.term, m.label)}</h3>
          <span class="metric-unit">${unitLabel}</span>
        </div>
        <ul class="bars">${rows}</ul>
        <ul class="metric-summary" aria-label="${m.allEqual ? 'Result' : 'Lowest and highest'} for this workload">
          ${m.allEqual ? '' : '<li class="sum-title" aria-hidden="true">For this workload</li>'}${summary}
        </ul>
      </article>`;
    })
    .join('');

  // Let the bars grow once, after they are in the DOM.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => $$('.bars', dom.compareRoot).forEach((b) => b.classList.add('is-in')))
  );
}

/* ----- detailed metric tables ----- */
function renderMetricTables(sim) {
  const hues = hueMap(sim.processes);
  dom.metricsRoot.innerHTML = sim.algos
    .map((a) => {
      const body = a.rows
        .map(
          (r) => `<tr>
            <th scope="row"><span class="swatch" style="--h:${hues.get(r.id)}"></span>${esc(r.id)}</th>
            <td>${r.arrival}</td><td>${r.burst}</td><td>${r.completion}</td><td>${r.turnaround}</td><td>${r.waiting}</td><td>${r.response}</td>
          </tr>`
        )
        .join('');
      return `<div class="table-block">
        <div class="table-head">
          <h3><i class="dot dot--lg" style="background:var(--c-${a.key})"></i>${a.name}</h3>
          <span class="chip">${term('cpu', 'CPU utilization')} ${fmt(a.cpuUtilization)}%</span>
          <span class="chip">${term('switches', 'Context switches')} ${a.contextSwitches}</span>
        </div>
        <div class="table-scroll" tabindex="0" role="region" aria-label="${a.name} results table">
          <table class="data-table">
            <caption class="sr-only">${a.name}: per-process results</caption>
            <thead><tr>
              <th scope="col">Process</th>
              <th scope="col">${term('arrival', 'Arrival')}</th>
              <th scope="col">${term('burst', 'Burst')}</th>
              <th scope="col">${term('completion', 'Completion')}</th>
              <th scope="col">${term('turnaround', 'Turnaround')}</th>
              <th scope="col">${term('waiting', 'Waiting')}</th>
              <th scope="col">${term('response', 'Response')}</th>
            </tr></thead>
            <tbody>${body}</tbody>
            <tfoot><tr>
              <th scope="row" colspan="4">Average</th>
              <td>${fmt(a.avg.turnaround)}</td><td>${fmt(a.avg.waiting)}</td><td>${fmt(a.avg.response)}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>`;
    })
    .join('');
}

/* ----- explanations ----- */
function renderInsights(sim) {
  const n = sim.processes.length;
  const span = sim.endTime - sim.startTime;
  const usesRR = sim.algos.some((a) => a.key === 'rr');
  dom.insightsContext.innerHTML = `${icon('bulb', 20)}<span>Based on ${n} ${n === 1 ? 'process' : 'processes'}, ${sim.algos.length} algorithm${sim.algos.length === 1 ? '' : 's'}${usesRR ? `, a time quantum of ${sim.quantum} (Round Robin)` : ''} and a ${span}-unit timeline.</span>`;
  dom.insightsRoot.innerHTML = buildInsights(sim)
    .map(
      (item) => `<li class="insight" data-algo="${item.algo}">
        <span class="insight-badge"><i class="dot"></i>${esc(item.lead)}</span>
        ${splitSentences(item.text).map((sentence) => `<p>${emphasizeNumbers(esc(sentence))}</p>`).join('')}
      </li>`
    )
    .join('');
}

/* ----- results lifecycle ----- */
function renderResults() {
  const sim = state.sim;
  renderRace(sim);
  renderComparison(sim);
  renderMetricTables(sim);
  renderInsights(sim);
  hydrateIcons(document);

  dom.raceEmpty.hidden = true;
  dom.raceStage.hidden = false;
  dom.resultsAfter.hidden = false;
  dom.scrubber.min = sim.startTime;
  dom.scrubber.max = sim.endTime;
}

function markStale() {
  if (!state.sim) return;
  pausePlayback();
  document.body.dataset.stale = 'true';
  dom.staleNote.hidden = false;
}

function resetSimulation() {
  state.runToken += 1;
  pausePlayback();
  state.sim = null;
  ui.inner = null;
  ui.lanes = [];
  delete document.body.dataset.stale;
  dom.staleNote.hidden = true;
  dom.raceLanes.innerHTML = '';
  dom.raceStage.hidden = true;
  dom.raceEmpty.hidden = false;
  dom.resultsAfter.hidden = true;
  clearMsg(dom.raceMsg);
  updatePlayUi();
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Smoothly scrolls the race section into view and resolves once the page has stopped moving. */
function scrollToRace() {
  return new Promise((resolve) => {
    const reduced = prefersReducedMotion();
    const top = Math.max(0, dom.raceTitle.getBoundingClientRect().top + window.scrollY - 16);
    window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
    dom.raceTitle.focus({ preventScroll: true });
    if (reduced) return resolve();

    const started = performance.now();
    let last = window.scrollY;
    let still = 0;
    const check = () => {
      const y = window.scrollY;
      still = Math.abs(y - last) < 0.5 ? still + 1 : 0;
      last = y;
      if (Math.abs(y - top) < 2 || still >= 8 || performance.now() - started > 1600) resolve();
      else requestAnimationFrame(check);
    };
    return requestAnimationFrame(check);
  });
}

async function runRace({ scroll = false } = {}) {
  clearMsg(dom.raceMsg);
  clearMsg(dom.formMsg);
  clearMsg(dom.algoMsg);

  if (state.editingId) {
    const target = scroll ? dom.formMsg : dom.raceMsg;
    showMsg(target, 'Save or cancel the row you are editing, then run the race.');
    return;
  }
  if (!state.processes.length) {
    showMsg(dom.formMsg, 'Add at least one process to run the race.');
    dom.inputTitle.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    dom.pid.focus({ preventScroll: true });
    return;
  }
  const selected = selectedAlgoList();
  if (selected.length < MIN_COMPARE) {
    showMsg(dom.algoMsg, `Select at least ${MIN_COMPARE} algorithms to compare.`);
    dom.algoToggles.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    return;
  }
  const q = validateQuantum(dom.quantum.value);
  if (!q.valid) {
    setQuantumError(q.error);
    dom.quantum.focus();
    dom.quantum.scrollIntoView({ behavior: 'auto', block: 'center' });
    return;
  }

  pausePlayback();
  state.quantum = q.value;
  state.sim = runAll(state.processes, state.quantum, selected);
  const token = (state.runToken += 1);
  const problems = verifySimulation(state.sim);
  if (problems.length) console.warn('Simulation self-check found problems:', problems);

  delete document.body.dataset.stale;
  dom.staleNote.hidden = true;
  renderResults();
  updatePlayUi();

  if (prefersReducedMotion()) {
    setClock(state.sim.endTime);
    showMsg(dom.raceMsg, 'Reduced motion is on, so the charts are shown finished. Press Play Race to animate them.', 'info');
    if (scroll) await scrollToRace();
    return;
  }

  setClock(state.sim.startTime); // lanes wait, empty, while the page scrolls
  if (scroll) {
    await scrollToRace();
    await wait(250); // a beat so the empty lanes register before the race starts
  }
  // If the user edited, reset or re-ran meanwhile, this run is no longer current.
  if (token !== state.runToken || document.body.dataset.stale || player.playing) return;
  startPlayback();
}

/* ==========================================================================
   7. Race animation
   One clock drives every lane: a cover slides right to reveal the blocks,
   and the lane chips show what is running, who is waiting, how many have
   finished and how many context switches have happened so far. Every value is
   recomputed straight from the clock each frame, so scrubbing backward is just
   as correct as playing forward.
   ========================================================================== */

const player = { clock: 0, playing: false, speed: 1, raf: 0, last: 0 };

function announce(text) {
  dom.status.textContent = text;
}

function setClock(clock) {
  const sim = state.sim;
  if (!sim || !ui.inner) return;
  player.clock = Math.min(Math.max(clock, sim.startTime), sim.endTime);
  const span = sim.endTime - sim.startTime;
  const progress = span > 0 ? (player.clock - sim.startTime) / span : 1;
  ui.inner.style.setProperty('--p', progress);

  const finished = player.clock >= sim.endTime;
  ui.inner.dataset.state = finished ? 'done' : player.playing ? 'playing' : 'paused';

  ui.lanes.forEach((lane) => {
    // Which segment holds the CPU right now? It gets the active outline, and the lane's
    // playhead and status chip take that process's color.
    const idx = finished ? -1 : lane.algo.segments.findIndex((s) => player.clock >= s.start && player.clock < s.end);
    if (idx !== lane.activeIdx) {
      if (lane.activeIdx >= 0) lane.blocks[lane.activeIdx].classList.remove('is-active');
      if (idx >= 0) lane.blocks[idx].classList.add('is-active');
      lane.activeIdx = idx;

      const seg = idx >= 0 ? lane.algo.segments[idx] : null;
      const running = Boolean(seg && seg.pid !== null);
      if (running) {
        const hue = lane.hues.get(seg.pid);
        lane.now.style.setProperty('--h', hue);
        lane.playhead.style.setProperty('--h', hue);
      } else {
        lane.now.style.removeProperty('--h');
        lane.playhead.style.removeProperty('--h');
      }
      lane.now.dataset.kind = running ? 'run' : seg ? 'idle' : finished ? 'done' : 'ready';
      lane.nowText.textContent = running ? `Running ${seg.pid}` : seg ? 'CPU idle' : finished ? 'Finished' : 'Ready';
    }

    const runningPid = lane.activeIdx >= 0 ? lane.algo.segments[lane.activeIdx].pid : null;
    const doneRows = lane.algo.rows.filter((r) => r.completion <= player.clock);
    const doneText = `${doneRows.length} of ${lane.algo.rows.length} finished`;
    if (lane.last.done !== doneText) lane.done.textContent = lane.last.done = doneText;

    // Persistent "done" checkmark, kept in sync every frame so it also disappears
    // correctly if the person scrubs the timeline backward.
    const doneIds = new Set(doneRows.map((r) => r.id));
    lane.finalSegIdx.forEach((segIdx, pid) => {
      if (segIdx < 0) return;
      const el = lane.blocks[segIdx];
      const shouldBeDone = doneIds.has(pid);
      if (shouldBeDone !== el.classList.contains('is-complete')) {
        el.classList.toggle('is-complete', shouldBeDone);
        if (shouldBeDone) {
          el.classList.add('just-completed');
          setTimeout(() => el.classList.remove('just-completed'), 650);
        }
      }
    });

    const readyIds = lane.algo.rows
      .filter((r) => r.arrival <= player.clock && r.completion > player.clock && r.id !== runningPid)
      .map((r) => r.id);
    const readyKey = readyIds.join(',');
    if (lane.last.ready !== readyKey) {
      lane.last.ready = readyKey;
      lane.queue.innerHTML = readyIds.length
        ? readyIds.map((id) => `<span class="queue-chip" style="--h:${lane.hues.get(id)}">${esc(id)}</span>`).join('')
        : '<span class="queue-empty">None</span>';
    }

    let switchesSoFar = 0;
    let prevPid = null;
    for (const seg of lane.algo.segments) {
      if (seg.end > player.clock) break;
      if (seg.pid !== null) {
        if (prevPid !== null && prevPid !== seg.pid) switchesSoFar += 1;
        prevPid = seg.pid;
      }
    }
    const switchText = `${switchesSoFar} ${switchesSoFar === 1 ? 'switch' : 'switches'} so far`;
    if (lane.last.switches !== switchText) lane.switches.textContent = lane.last.switches = switchText;
  });

  dom.scrubber.value = player.clock;
  dom.clock.textContent = `t = ${fmt(Math.round(player.clock * 10) / 10)} of ${sim.endTime}`;
}

function frame(now) {
  if (!player.playing) return;
  const sim = state.sim;
  const dt = Math.min(Math.max((now - player.last) / 1000, 0), 0.1); // clamp so a background tab does not jump
  player.last = now;
  const span = sim.endTime - sim.startTime;
  const unitsPerSecond = Math.min(12, Math.max(2, span / 8)) * player.speed; // about 8 seconds at 1x
  setClock(player.clock + dt * unitsPerSecond);

  if (player.clock >= sim.endTime) {
    player.playing = false;
    setClock(sim.endTime);
    updatePlayUi();
    announce(`Race finished at time ${sim.endTime}.`);
  } else {
    player.raf = requestAnimationFrame(frame);
  }
}

function startPlayback() {
  const sim = state.sim;
  if (!sim) return;
  if (player.clock >= sim.endTime) setClock(sim.startTime);
  player.playing = true;
  player.last = performance.now();
  cancelAnimationFrame(player.raf);
  player.raf = requestAnimationFrame(frame);
  setClock(player.clock);
  updatePlayUi();
  announce('Race started.');
}

function pausePlayback() {
  if (!player.playing) return;
  player.playing = false;
  cancelAnimationFrame(player.raf);
  if (state.sim) {
    setClock(player.clock);
    announce(`Race paused at time ${fmt(Math.round(player.clock * 10) / 10)}.`);
  }
  updatePlayUi();
}

function restartPlayback() {
  if (!state.sim) return;
  player.playing = false;
  cancelAnimationFrame(player.raf);
  setClock(state.sim.startTime);
  startPlayback();
}

function updatePlayUi() {
  const has = Boolean(state.sim);
  dom.playBtn.disabled = !has;
  dom.restartBtn.disabled = !has;
  dom.resetBtn.disabled = !has;
  dom.scrubber.disabled = !has;
  dom.playBtn.innerHTML = player.playing ? `${icon('pause')}Pause` : `${icon('play')}Play Race`;
}

/* ==========================================================================
   8. Tooltips, theme, events, start-up
   ========================================================================== */

function initTooltips() {
  const tip = dom.tooltip;
  const show = (target) => {
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const rect = target.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left + rect.width / 2 - box.width / 2, 8), window.innerWidth - box.width - 8);
    let top = rect.top - box.height - 8;
    if (top < 8) top = rect.bottom + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => {
    tip.hidden = true;
  };
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t && !t.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  window.addEventListener('scroll', hide, { passive: true });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  dom.themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  dom.themeBtn.innerHTML = icon(dark ? 'sun' : 'moon');
  try {
    localStorage.setItem('csrv-theme', theme);
  } catch (err) {
    /* storage can be unavailable (private mode); the theme still works for this visit */
  }
}

function cacheDom() {
  const ids = {
    themeBtn: 'theme-toggle', heroRun: 'hero-run', heroLanes: 'hero-lanes', heroCaption: 'hero-caption',
    inputTitle: 'input-title', form: 'process-form', pid: 'pid', arrival: 'arrival', burst: 'burst', priority: 'priority',
    formMsg: 'form-msg', quantum: 'quantum', quantumMsg: 'err-quantum',
    tableWrap: 'table-wrap', rows: 'process-rows', processEmpty: 'process-empty', count: 'process-count', tableMsg: 'table-msg',
    sampleBtn: 'sample-btn', randomBtn: 'random-btn', clearBtn: 'clear-btn',
    algoToggles: 'algo-toggles', algoMsg: 'algo-msg', algoSummary: 'algo-summary',
    raceTitle: 'race-title', runBtn: 'run-btn', playBtn: 'play-btn', restartBtn: 'restart-btn', resetBtn: 'reset-btn',
    raceMsg: 'race-msg', staleNote: 'stale-note', raceEmpty: 'race-empty', raceStage: 'race-stage', raceLanes: 'race-lanes',
    scrubber: 'scrubber', clock: 'clock', status: 'race-status',
    resultsAfter: 'results-after', compareRoot: 'compare-root', metricsRoot: 'metrics-root',
    insightsRoot: 'insights-root', insightsContext: 'insights-context',
    tooltip: 'tooltip',
  };
  Object.entries(ids).forEach(([key, id]) => {
    dom[key] = document.getElementById(id);
  });
}

function bindEvents() {
  dom.themeBtn.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

  dom.form.addEventListener('submit', handleAdd);
  [dom.pid, dom.arrival, dom.burst, dom.priority].forEach((input) =>
    input.addEventListener('input', () => {
      setFieldError(input, null);
      clearMsg(dom.formMsg);
    })
  );
  dom.rows.addEventListener('click', handleTableClick);
  dom.rows.addEventListener('keydown', handleTableKeydown);
  dom.quantum.addEventListener('input', handleQuantumInput);
  $$('input[name="algo"]').forEach((cb) => cb.addEventListener('change', handleAlgoToggle));

  dom.sampleBtn.addEventListener('click', () => {
    loadSample();
    onProcessesChanged();
    showMsg(dom.tableMsg, 'Sample data loaded.', 'ok');
  });
  dom.randomBtn.addEventListener('click', () => {
    loadRandom();
    onProcessesChanged();
    showMsg(dom.tableMsg, 'Random processes generated.', 'ok');
  });
  dom.clearBtn.addEventListener('click', () => {
    clearAll();
    onProcessesChanged();
    showMsg(dom.tableMsg, 'All processes removed.', 'ok');
  });

  dom.heroRun.addEventListener('click', () => runRace({ scroll: true }));
  dom.runBtn.addEventListener('click', () => runRace());
  dom.playBtn.addEventListener('click', () => (player.playing ? pausePlayback() : startPlayback()));
  dom.restartBtn.addEventListener('click', restartPlayback);
  dom.resetBtn.addEventListener('click', () => {
    resetSimulation();
    dom.runBtn.focus();
  });
  $$('input[name="speed"]').forEach((radio) =>
    radio.addEventListener('change', () => {
      player.speed = Number(radio.value);
    })
  );
  dom.scrubber.addEventListener('input', () => {
    // Read the dragged-to value before pausing: pausePlayback() itself calls
    // setClock() with the OLD clock, which would otherwise snap the slider
    // back and overwrite the very value this event is reporting.
    const target = Number(dom.scrubber.value);
    pausePlayback();
    setClock(target);
  });
}

function initApp() {
  cacheDom();
  hydrateIcons(document);
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  initTooltips();
  bindEvents();
  renderAlgoCards();
  renderAlgoSummary();

  loadSample();
  renderProcessTable();
  dom.pid.value = nextId();
  renderHero();
  resetSimulation();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
  else initApp();
}

// Lets the scheduling logic be tested in Node without a browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fcfs, sjf, srtf, priorityNonPreemptive, priorityPreemptive, roundRobin, preemptiveBy,
    generateGanttData, calculateMetrics, runAll, compareResults, verifySimulation, buildInsights,
    findPreemptions, validateProcessInput, validateQuantum, hueFor, fmt, ALGO_ORDER, ALGO_INFO, DEFAULT_ALGOS,
  };
}

# CPU Scheduling Race Visualizer

**An Operating Systems CPU Scheduling Simulator and Visual Analyzer.**

Compare • Visualize • Understand CPU Scheduling

This is not just a website that draws bars — it is a small simulation engine for six
CPU scheduling algorithms, with a visual layer built specifically to make the
*mechanics* of each algorithm (arrival, dispatch, preemption, completion) legible
at a glance, and a compare mode that runs any subset of those algorithms on one
shared workload so the trade-offs between them become concrete numbers instead of
textbook claims.

---

## 1. Problem statement

Scheduling algorithms are usually taught as separate, static examples: one Gantt
chart for FCFS, another for SJF, a third for Round Robin, each with its own set of
processes. That makes it hard to see the thing that actually matters for
understanding trade-offs: **what happens when the same workload is run through
different algorithms.** A process that waits a long time under FCFS might not
under SJF; a quantum that's too small might multiply context switches under Round
Robin without helping anyone. This project exists to make that comparison direct,
correct, and explorable, instead of theoretical.

## 2. Objectives

- Implement a set of classic CPU scheduling algorithms with textbook-correct,
  independently verified logic (see [Testing](#8-testing)).
- Visualize each algorithm's execution as it actually happens — arrivals, the
  ready queue, the running process, preemptions and completions — not just a
  static finished chart.
- Let a person run **any 2 to 6 of the six algorithms** on the same set of
  processes and compare their metrics side by side, without ever declaring a
  single "best" algorithm (the right answer always depends on the workload and
  what the person scheduling cares about).
- Generate explanations of *why* a particular result happened, computed from the
  actual simulation output rather than written as generic, hardcoded text.
- Keep the whole thing dependency-free, fast, and inspectable: open `index.html`
  and it runs, with the entire scheduling engine readable in one file.

## 3. Features

- **Six scheduling algorithms** (see [section 5](#5-algorithms-implemented)),
  each mathematically verified against an independent simulation.
- **Compare mode**: choose any 2–6 algorithms and run them on one shared
  workload. Lanes, the metrics dashboard, the detailed tables and the generated
  insights all adapt automatically to whichever subset is selected.
- **Live race visualization** per algorithm lane:
  - the currently running process, clearly outlined and named ("Running P3")
  - the ready queue of waiting processes, updated every instant
  - a running count of finished processes and context switches so far
  - small markers on the timeline flagging every context switch
  - a checkmark on each process's final Gantt block once it completes
  - Play / Pause / Restart, adjustable speed, and a scrubbable timeline that
    stays correct scrubbing forward *or* backward
- **Performance comparison dashboard**: per-metric tiles (average waiting,
  turnaround and response time, CPU utilization, context switches) with bars,
  exact values, and explicit "Lowest for this workload" / "Highest for this
  workload" tags — never an overall "winner".
- **Detailed per-process metrics tables** for every selected algorithm.
- **"Why did this happen?"**: a set of explanation cards generated from the
  actual simulation result (see [section 6](#6-how-explanations-are-generated)).
- **Six algorithm-explainer cards** with a live mini Gantt chart, a plain-English
  description, preemptive/non-preemptive type, selection rule, and an
  expandable Advantages / Limitations / Best-use-case panel for each algorithm.
- Editable process list (add, edit, delete, random generation, sample data),
  each process with arrival time, burst time and a priority.
- Light and dark themes, responsive layout, reduced-motion support.

## 4. Technologies used

- **HTML5**, **CSS3** (custom properties, no framework), **vanilla JavaScript**
  (ES2020+, no build step, no bundler).
- No backend, no database, no external API calls, no network requests of any
  kind at runtime. Everything computes in the browser.
- Optional web fonts (Google Fonts) with a system-font fallback if they can't
  load — the app works fully offline either way.

## 5. Algorithms implemented

| Algorithm | Type | Selects by |
|---|---|---|
| **FCFS** — First Come, First Served | Non-preemptive | Arrival time |
| **SJF** — Shortest Job First | Non-preemptive | Shortest burst time among ready processes |
| **SRTF** — Shortest Remaining Time First | Preemptive | Shortest *remaining* burst time, re-checked on every arrival |
| **Priority** | Non-preemptive | Lowest priority number among ready processes |
| **Priority (Preemptive)** | Preemptive | Lowest priority number, re-checked on every arrival |
| **Round Robin** | Preemptive | Turn order in the ready queue, capped at one time quantum per turn |

**Priority convention** (shown throughout the UI): a **lower number means a
higher priority**. Priority 1 is the highest priority a process can have.

**Tie-breaking**, used consistently by every algorithm: whichever process
arrived earliest wins; if arrival times also tie, the process added first (its
input order) wins. In Round Robin, a process that arrives at the exact instant
another process's quantum ends joins the ready queue *before* that preempted
process is re-queued.

### How the preemptive algorithms actually decide

SRTF and Priority (Preemptive) share one engine (`preemptiveBy` in
`script.js`), parameterized only by the comparison key (remaining burst time,
or priority). At every decision point it runs whichever ready process ranks
best, for as long as that stays true — until the process finishes, or until the
next arrival, whichever comes first — and then re-decides. That re-decision on
every arrival is what makes preemption genuine rather than a fixed schedule
with interruptions drawn on afterwards.

## 6. How explanations are generated

Nothing under "Why did this happen?" is a fixed template filled with numbers.
Each card is built by reading the actual simulation result:

- **FCFS**: finds the process with the largest waiting time and the specific
  earlier-arriving processes that caused it, by checking which processes' Gantt
  segments overlap that process's wait window.
- **SJF / Priority**: finds the first point where the algorithm's run order
  diverges from FCFS's, names the two processes involved and their burst or
  priority values, and states whether that lowered the average waiting time
  *for this workload specifically* (it's a greedy rule — the explanation says
  so explicitly when it doesn't help).
- **SRTF / Priority (Preemptive)**: scans the Gantt segments for genuine
  preemption events (a process interrupted before its completion time) and
  narrates the first one with real process IDs and the real time it happened.
- **Round Robin**: counts how many processes were actually split across more
  than one Gantt segment (i.e. really interrupted by the quantum) and compares
  its response/turnaround time against whichever other algorithms are selected.
- **Cross-algorithm summary**: for every metric, states which selected
  algorithm(s) were lowest and highest *for this workload*, built directly from
  the same numbers shown on the comparison dashboard.

Every one of these functions degrades gracefully: if, say, FCFS isn't in the
current comparison, the SJF explanation just describes SJF's own run order
instead of comparing against a baseline that isn't there. Nothing is
hardcoded to a fixed set of three algorithms — see `buildInsights()` in
`script.js`.

## 7. Architecture / project structure

```
cpu-scheduling-race/
├── index.html   Page structure and copy only — no scheduling logic
├── style.css    All styling: design tokens, layout, light/dark themes
├── script.js    Everything else, organized in 8 numbered sections:
│                  1. Constants and copy
│                  2. Helpers
│                  3. Scheduling core   <- the algorithms live here, and only here
│                  4. Validation
│                  5. "Why did this happen?" explanations
│                  6. UI state and rendering
│                  7. Race animation
│                  8. Tooltips, theme, events, start-up
└── README.md
```

Scheduling logic is deliberately kept separate from UI logic: every algorithm
(`fcfs`, `sjf`, `srtf`, `priorityNonPreemptive`, `priorityPreemptive`,
`roundRobin`) is a **pure function** — input processes in, an ordered list of
execution slices out, no DOM access, no globals. `generateGanttData()` turns
those slices into chart segments (adding idle gaps), and `calculateMetrics()`
derives every number shown anywhere in the app *only* from those segments. That
is what guarantees the Gantt charts, the tables, the comparison dashboard and
the generated insights can never disagree with each other: they are all reading
the same computed segments, not recomputing anything independently.

`runAll(processes, quantum, selectedAlgorithms)` runs whichever algorithms are
selected (2 to 6, `fcfs`/`sjf`/`rr` by default) and returns one `sim` object
that the entire UI renders from. Adding a seventh algorithm in the future means
adding one pure function plus one entry in `ALGO_RUN`/`ALGO_INFO` — the UI,
comparison dashboard and insight generation are already written generically
over "however many algorithms are currently selected."

## 8. Testing

Every algorithm was checked against an **independent, unit-time-stepped oracle
simulation** (a second, much simpler implementation that advances one time unit
at a time) across:

- All of the required edge cases: identical arrival times, different arrival
  times, identical burst times, idle CPU gaps, several processes arriving
  simultaneously, a single process, priority ties, preemption exactly at an
  arrival instant, a time quantum of 1, and a time quantum larger than every
  burst time.
- 800+ randomly generated workloads across all six algorithms.
- A full internal self-check (`verifySimulation()`) that runs on every
  simulation in the live app and logs (never throws) if a Gantt chart ever
  overlaps, skips time, runs a process before it arrives, or produces a
  negative waiting/response time.

In the browser, every metric shown in the UI (completion, turnaround, waiting,
response, CPU utilization, context switches) was independently recomputed from
the rendered Gantt blocks' `aria-label`s and DOM structure, and checked against
the tables, the comparison tiles and the lowest/highest tags, for all ten edge
cases above across all six algorithms.

## 9. How to run

No install, no build, no server.

1. Download / clone this folder.
2. Open `index.html` in any modern browser (Chrome, Firefox, Edge, Safari).

That's it. If you're offline, the two Google Fonts fail to load silently and
the page falls back to your system's fonts — nothing else is affected.

## 10. Example usage

1. Press **Load sample data** (or just use it — it's loaded by default) to get
   five processes with varied arrival times, burst times and priorities.
2. Under **Algorithms to compare**, check a few more boxes — try adding SRTF
   and Priority (Preemptive) to the default FCFS / SJF / Round Robin selection.
3. Press **Run Race**. The page scrolls down and animates every selected
   algorithm's schedule at once, each with its own live ready queue.
4. Scroll to **Performance comparison** to see, metric by metric, which
   algorithm was lowest and highest *for that specific workload*.
5. Scroll to **Why did this happen?** for a plain-English account of what drove
   those numbers — try changing the priority of one process or the Round Robin
   quantum and re-running to see the explanations change with the data.

## 11. Metrics and formulas

| Metric | Formula |
|---|---|
| Completion time | The time a process's last CPU slice ends |
| Turnaround time | Completion time − arrival time |
| Waiting time | Turnaround time − burst time |
| Response time | First start time − arrival time (the first time the process ever gets the CPU, even under a preemptive algorithm where it may run again later) |
| CPU utilization | Busy time ÷ (last completion − first arrival), as a percentage |
| Context switches | Number of times the CPU moves from one process to a *different* process. The very first dispatch isn't counted, idle gaps are ignored, and this simulator does not add time for the switch itself |

All averages (waiting, turnaround, response) are the mean across every process
in the current workload, per algorithm.

## 12. Screenshots

### Hero — all six algorithms previewed live
![Hero section](screenshots/hero.png)

### The race — six lanes, live ready queue, context switches
![Live race in action](screenshots/race.png)
### Performance comparison — lowest/highest per metric, no overall winner
![Performance comparison](screenshots/compare.png)

### "Why did this happen?" — explanations generated from the actual run
![Explainability section](screenshots/insights.png)
## 13. Future scope

- **Aging / dynamic priority**: raise a waiting process's effective priority
  over time to bound worst-case starvation under Priority scheduling.
- **Multilevel queue / multilevel feedback queue** scheduling, building on the
  same segment-based rendering pipeline.
- **I/O bursts**: alternate CPU and I/O phases per process instead of a single
  burst time, to model blocking behavior.
- **Real (rather than simulated) context-switch cost**: an optional fixed time
  penalty charged on every switch, to make the Round Robin quantum trade-off
  even more concrete.
- **Shareable workloads**: encode the current process list, quantum and
  algorithm selection into a URL so a specific comparison can be linked.

---

Built with HTML, CSS and vanilla JavaScript. Everything runs in your browser;
nothing is sent anywhere.

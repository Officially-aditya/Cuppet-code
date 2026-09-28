# cuppet-harness-comparison

- Status: **failed**
- Benchmark version: `issue-4.1`
- Repository SHA: `840ed751b61c04afc881a393b7836d4d2c932f61`
- Task set: `issue-4-core@2026-09-05` (12 tasks)
- Manifest SHA-256: `d4c3ae89f9e9443292594469d0013f0debf5cd589b142dc571d180789a99eb59`
- Repetitions: 1
- Controller: local/deterministic-node-controller (issue-4.1)

## Headline metrics

| Metric | cuppet |
|---|---:|
| Successful tasks | 11/12 |
| Success rate (95% CI) | 91.7% (64.6%–98.5%) |
| First-attempt success | 91.7% |
| Acceptance checks | 14/15 |
| Model tokens/task (median) | 10,107 |
| Model tokens/successful task | 13,654 |
| Uncached input/task (median) | 7,730 |
| Cached input/task (median) | 220,416 |
| Output tokens/task (median) | 1,102 |
| Tool calls/task (median) | 5 |
| Retries | 0 |
| Compactions | 0 |
| Regressions | 0 |
| Effective cost/task (median) | unavailable |

## Uncertainty

- **cuppet**: model tokens/task 10107 (95% mean CI 6755–18278); successful-task tokens 6767 (95% mean CI 5719–18045); wall time 42831 (95% mean CI 36322–88398).

## Parity and controller notes

- **cuppet**: Cuppet derivative OpenCode 1.18.4; runtime version captured by arm result; config SHA-256 `6aac7f4a5512346b6555790cd3a30aeac5662919aefe5ce233fef25c1c2d4dfc`.
- The controller freezes the repository SHA, task prompts, model settings, harness metadata, environment allowlist, and verifier commands before the first arm runs.
- The controller only runs deterministic verification commands; it does not rewrite prompts, coach harnesses, or make subjective correctness judgments.
- Failed tasks retain all telemetry emitted before failure. A null cost means the harness did not expose provider-adjusted pricing.
- In the default Issue #4 mixed topology, persistent Cuppet/OpenCode sequences reuse one native session; Codex and Claude Code persistent-family entries run sequential native CLI turns because their resume/session telemetry is not yet reliable enough to claim a single persistent session.
- Marathon topology: one workspace and one native session per supported arm/repeat; deterministic verification runs after every task without resetting the evolving workspace.

## Long-horizon sequence

| Arm | Sequence tasks | Total uncached input | Total cached input | Final-task cache share | Early uncached median | Late uncached median | Early cache share | Late cache share |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| cuppet | 12 × 1 | 122,484 | 2,835,968 | 96.8% | 11,929 | 6,171 | 94.6% | 97.9% |

Per-task cache share and marginal uncached input remain available in the JSON report under `longHorizon[].tasks`.

## Per-task results

- Repeat 1, **cuppet**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 40003; cached input 236032; uncached input 35682; tools 32.
- Repeat 1, **cuppet**, `quiz-game-greenfield`: success; acceptance 100.0%; model tokens 16731; cached input 210432; uncached input 11929; tools 11.
- Repeat 1, **cuppet**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 13446; cached input 182784; uncached input 9288; tools 9.
- Repeat 1, **cuppet**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 14629; cached input 178176; uncached input 11469; tools 9.
- Repeat 1, **cuppet**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 13715; cached input 216064; uncached input 11860; tools 9.
- Repeat 1, **cuppet**, `switch-a-auth`: success; acceptance 100.0%; model tokens 6286; cached input 242688; uncached input 5725; tools 3.
- Repeat 1, **cuppet**, `switch-a-followup`: success; acceptance 100.0%; model tokens 4735; cached input 189952; uncached input 4279; tools 2.
- Repeat 1, **cuppet**, `switch-b-auth`: success; acceptance 100.0%; model tokens 4449; cached input 266240; uncached input 3856; tools 3.
- Repeat 1, **cuppet**, `switch-b-followup`: success; acceptance 100.0%; model tokens 5470; cached input 206336; uncached input 5067; tools 2.
- Repeat 1, **cuppet**, `switch-c`: success; acceptance 100.0%; model tokens 6767; cached input 286720; uncached input 6171; tools 3.
- Repeat 1, **cuppet**, `switch-a-return`: success; acceptance 100.0%; model tokens 4468; cached input 224768; uncached input 4173; tools 2.
- Repeat 1, **cuppet**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 19498; cached input 395776; uncached input 12985; tools 7; node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: operations-dashboard is missing dashboard
    at verifyWebProject (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:83:50)
    at async <anonymous> (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:7:1) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '  <title>northstar operations</title>\n' +
    '  <link rel="stylesheet" href="styles.css">\n' +
    '</head>\n' +
    '<body>\n' +
    '  <div class="app-shell">\n' +
    '    <aside class="sidebar">\n' +
    '      <div class="brand"><span class="brand-mark">n</span><span>northstar</span></div>\n' +
    '      <p class="side-label">operations</p>\n' +
    '      <nav aria-label="primary navigation">\n' +
    '        <a class="nav-item active" href="#overview" aria-current="page"><span aria-hidden="true">▦</span> overview</a>\n' +
    '        <a class="nav-item" href="#work-orders"><span aria-hidden="true">◫</span> work orders</a>\n' +
    '        <a class="nav-item" href="#team"><span aria-hidden="true">♙</span> team</a>\n' +
    '      </nav>\n' +
    '      <div class="sidebar-footer"><span class="status-dot"></span><span>all systems operational</span></div>\n' +
    '    </aside>\n' +
    '    <main class="main" id="overview">\n' +
    '      <header class="topbar"><div><p class="eyebrow">monday · 08:42 local</p><h1>good morning, casey.</h1></div><button class="icon-button" type="button" aria-label="open notifications">♧<span class="notification-dot"></span></button></header>\n' +
    '      <section class="metrics" aria-label="operations metrics">\n' +
    '        <article class="metric-card"><span class="metric-icon blue">↗</span><p>open work orders</p><strong id="open-metric">0</strong><small class="positive">↑ 8.2% <span>vs last week</span></small></article>\n' +
    '        <article class="metric-card"><span class="metric-icon orange">◷</span><p>due today</p><strong id="due-metric">0</strong><small class="neutral">across all teams</small></article>\n' +
    '        <article class="metric-card"><span class="metric-icon green">✓</span><p>on-time rate</p><strong>94.6%</strong><small class="positive">↑ 2.4% <span>vs last week</span></small></article>\n' +
    '        <article class="metric-card"><span class="metric-icon purple">⚡</span><p>avg. response</p><strong>18m</strong><small class="positive">↓ 4m <span>vs last week</span></small></article>\n' +
    '      </section>\n' +
    '      <section class="workspace" id="work-orders" aria-labelledby="orders-title">\n' +
    '        <div class="orders-panel">\n' +
    '          <div class="section-heading"><div><p class="eyebrow">live queue</p><h2 id="orders-title">work orders</h2></div><span id="results-count" class="result-count"></span></div>\n' +
    '          <div class="toolbar"><label class="search"><span aria-hidden="true">⌕</span><span class="visually-hidden">search work orders</span><input id="search-input" type="search" placeholder="search orders or owners"></label><label class="select-label"><span class="visually-hidden">filter by status</span><select id="status-filter"><option value="all">all statuses</option><option value="in-progress">in progress</option><option value="queued">queued</option><option value="blocked">blocked</option><option value="complete">complete</option></select></label><label class="select-label"><span class="visually-hidden">filter by priority</span><select id="priority-filter"><option value="all">all priorities</option><option value="urgent">urgent</option><option value="high">high</option><option value="normal">normal</option></select></label></div>\n' +
    '          <div class="table-wrap"><table><caption class="visually-hidden">current work orders</caption><thead><tr><th scope="col">order</th><th scope="col">owner</th><th scope="col">priority</th><th scope="col">status</th><th scope="col">due</th></tr></thead><tbody id="orders-body"></tbody></table><div id="empty-state" class="empty-state" hidden><span aria-hidden="true">⌁</span><h3>no work orders found</h3><p>try clearing a filter or searching for another order.</p><button id="clear-filters" class="text-button" type="button">clear all filters</button></div></div>\n' +
    '        </div>\n' +
    '        <aside id="details-panel" class="details-panel" aria-labelledby="details-title"><div class="details-placeholder"><span aria-hidden="true">◌</span><h2 id="details-title">select a work order</h2><p>choose an order from the queue to see its details here.</p></div></aside>\n' +
    '      </section>\n' +
    '    </main>\n' +
    '  </div>\n' +
    '  <script src="app.js"></script>\n' +
    '</body>\n' +
    '</html>\n' +
    '\n' +
    ':root { --ink: #1e2d3b; --muted: #7f8c96; --line: #e6ebee; --paper: #f7f9fa; --white: #fff; --navy: #152b3d; --blue: #4e7fe8; --green: #21866b; --orange: #dd8841; --red: #cc5c55; }\n' +
    '* { box-sizing: border-box; }\n' +
    'body { margin: 0; min-width: 320px; color: var(--ink); background: var(--paper); font: 14px/1.5 arial, sans-serif; }\n' +
    '.app-shell { display: flex; min-height: 100vh; }\n' +
    '.sidebar { display: flex; width: 230px; flex-direction: column; padding: 28px 16px; background: var(--navy); color: #c4d0d8; }\n' +
    '.brand { display: flex; align-items: center; gap: 10px; padding: 0 13px 54px; color: white; font: 700 1.2rem georgia, serif; }\n' +
    '.brand-mark { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 8px; background: #92ceb9; color: var(--navy); font: 700 1.15rem arial, sans-serif; }\n' +
    '.side-label, .eyebrow { margin: 0; color: #8799a7; font-size: .68rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }\n' +
    '.side-label { padding: 0 13px 12px; }\n' +
    '.nav-item { display: flex; align-items: center; gap: 13px; margin: 3px 0; padding: 12px 13px; border-radius: 8px; color: #a9bbc6; text-decoration: none; }\n' +
    '.nav-item:hover, .nav-item.active { background: #294456; color: white; }\n' +
    '.nav-item span { color: #8dcab5; font-size: 1.1rem; }\n' +
    '.sidebar-footer { display: flex; align-items: center; gap: 9px; margin-top: auto; padding: 17px 8px 0; border-top: 1px solid #304656; color: #91a4af; font-size: .75rem; }\n' +
    '.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #6ec9a5; box-shadow: 0 0 0 4px rgba(110, 201, 165, .15); }\n' +
    '.main { width: min(100%, 1450px); margin: auto; padding: 44px clamp(24px, 5vw, 72px); }\n' +
    '.topbar, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }\n' +
    'h1, h2, h3 { margin: 0; font-family: georgia, serif; font-weight: 400; letter-spacing: -.03em; }\n' +
    'h1 { margin-top: 8px; font-size: clamp(2rem, 4vw, 3rem); }\n' +
    'h2 { font-size: 1.75rem; }\n' +
    '.icon-button { position: relative; width: 40px; height: 40px; border: 1px solid var(--line); border-radius: 50%; background: var(--white); color: var(--muted); cursor: pointer; font-size: 1.15rem; }\n' +
    '.notification-dot { position: absolute; top: 8px; right: 8px; width: 6px; height: 6px; border: 1px solid white; border-radius: 50%; background: var(--orange); }\n' +
    '.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 42px 0 44px; }\n' +
    '.metric-card { position: relative; min-height: 142px; padding: 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--white); box-shadow: 0 7px 20px rgba(34, 61, 77, .035); }\n' +
    '.metric-card p { margin: 3px 0 8px; color: var(--muted); font-size: .8rem; font-weight: 700; }\n' +
    '.metric-card strong { display: block; font: 2rem georgia, serif; }\n' +
    '.metric-card small { font-size: .72rem; font-weight: 700; }.metric-card small span { color: var(--muted); font-weight: 400; }.positive { color: var(--green); }.neutral { color: var(--muted); }\n' +
    '.metric-icon { display: grid; width: 29px; height: 29px; place-items: center; border-radius: 8px; font-weight: 700; }.blue { background: #e9f0ff; color: var(--blue); }.orange { background: #fff0e4; color: var(--orange); }.green { background: #e4f4ee; color: var(--green); }.purple { background: #eeeaff; color: #8069d1; }\n' +
    '.workspace { display: grid; grid-template-columns: minmax(0, 1fr) 305px; gap: 22px; }\n' +
    '.orders-panel, .details-panel { border: 1px solid var(--line); border-radius: 12px; background: var(--white); }\n' +
    '.orders-panel { min-width: 0; padding: 25px; }.result-count { color: var(--muted); font-size: .8rem; }\n' +
    '.toolbar { display: flex; gap: 9px; margin: 25px 0 19px; }.search, select { border: 1px solid var(--line); border-radius: 7px; background: var(--white); color: var(--ink); font: inherit; }.search { display: flex; align-items: center; flex: 1; gap: 8px; padding: 9px 12px; color: var(--muted); }.search input { width: 100%; border: 0; outline: 0; font: inherit; }.select-label select { min-width: 126px; padding: 9px 26px 9px 10px; }\n' +
    '.table-wrap { overflow-x: auto; }table { width: 100%; min-width: 610px; border-collapse: collapse; }th { color: var(--muted); font-size: .68rem; letter-spacing: .09em; text-align: left; text-transform: uppercase; }th, td { padding: 14px 10px; border-top: 1px solid var(--line); }td { font-size: .84rem; }tbody tr { cursor: pointer; }tbody tr:hover, tbody tr.selected { background: #f5f9fa; }tbody tr:focus { outline: 3px solid #9bcbbe; outline-offset: -3px; }\n' +
    ".order-title { color: var(--ink); font-weight: 700; }.order-id { display: block; color: var(--muted); font-size: .72rem; }.owner { display: flex; align-items: center; gap: 8px; }.avatar { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 50%; background: #e3edf1; color: #426171; font-size: .65rem; font-weight: 700; }.pill { display: inline-block; padding: 4px 8px; border-radius: 99px; font-size: .68rem; font-weight: 700; }.pill.urgent { background: #ffebea; color: var(--red); }.pill.high { background: #fff0e2; color: #b96726; }.pill.normal { background: #edf1f2; color: #71818a; }.status { color: var(--muted); font-size: .77rem; }.status::before { display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentcolor; content: ''; }.status.in-progress { color: var(--blue); }.status.queued { color: var(--orange); }.status.blocked { color: var(--red); }.status.complete { color: var(--green); }\n" +
    '.details-panel { min-height: 380px; }.details-placeholder { padding: 90px 30px; color: var(--muted); text-align: center; }.details-placeholder > span { display: block; margin-bottom: 18px; color: #b7c4ca; font-size: 2.8rem; }.details-placeholder h2 { color: var(--ink); font-size: 1.3rem; }.details-placeholder p { font-size: .82rem; }.details-content { padding: 26px; }.detail-top { display: flex; align-items: fle'... 7647 more characters,
  expected: /dashboard/,
  operator: 'match',
  diff: 'simple'
}

Node.js v22.21.0.

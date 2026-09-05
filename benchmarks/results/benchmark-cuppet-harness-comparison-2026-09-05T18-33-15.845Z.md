# cuppet-harness-comparison

- Status: **failed**
- Benchmark version: `issue-4.1`
- Repository SHA: `840ed751b61c04afc881a393b7836d4d2c932f61`
- Task set: `issue-4-core@2026-09-05` (12 tasks)
- Manifest SHA-256: `b4bd21380e71429180b1f28ddaa06598ecd34ae30e341a930d293550c036eee9`
- Repetitions: 3
- Controller: local/deterministic-node-controller (issue-4.1)

## Headline metrics

| Metric | cuppet | opencode | codex |
|---|---:|---:|---:|
| Successful tasks | 32/36 | 33/36 | 32/36 |
| Success rate (95% CI) | 88.9% (74.7%–95.6%) | 91.7% (78.2%–97.1%) | 88.9% (74.7%–95.6%) |
| First-attempt success | 88.9% | 91.7% | 88.9% |
| Acceptance checks | 41/45 | 42/45 | 41/45 |
| Model tokens/task (median) | 13,665 | 4,931 | 26,258 |
| Model tokens/successful task | 21,370 | 19,803 | 32,151 |
| Uncached input/task (median) | 12,134 | 4,381 | 21,965 |
| Cached input/task (median) | 185,600 | 167,936 | 151,808 |
| Output tokens/task (median) | 949 | 680 | 1,988 |
| Tool calls/task (median) | 7 | 4 | 6 |
| Retries | 0 | 0 | 0 |
| Compactions | 0 | 0 | 0 |
| Regressions | 0 | 0 | 0 |
| Effective cost/task (median) | unavailable | unavailable | unavailable |

## Uncertainty

- **cuppet**: model tokens/task 13665 (95% mean CI 14423–23569); successful-task tokens 11998 (95% mean CI 12700–22248); wall time 50704 (95% mean CI 57453–95318).
- **opencode**: model tokens/task 4931 (95% mean CI 11891–24414); successful-task tokens 4822 (95% mean CI 10638–22411); wall time 59216 (95% mean CI 56655–159704).
- **codex**: model tokens/task 26258 (95% mean CI 24299–32859); successful-task tokens 25935 (95% mean CI 24519–33264); wall time 79296 (95% mean CI 81449–120495).

## Parity and controller notes

- **cuppet**: Cuppet derivative OpenCode 1.18.4; runtime version captured by arm result; config SHA-256 `6aac7f4a5512346b6555790cd3a30aeac5662919aefe5ce233fef25c1c2d4dfc`.
- **opencode**: OpenCode 1.18.4 kernel; runtime version captured by arm result; config SHA-256 `3f8f6d149fd6434f482cf7bd7e1bb273966ede3d26247659f382c417b1ef275f`.
- **codex**: Codex native exec CLI; version captured by arm result; config SHA-256 `6bc2b3c40846f07c4e1660ef8811682fcdfdfef6d2f7743e7a24273ec15852d8`.
- The controller freezes the repository SHA, task prompts, model settings, harness metadata, environment allowlist, and verifier commands before the first arm runs.
- The controller only runs deterministic verification commands; it does not rewrite prompts, coach harnesses, or make subjective correctness judgments.
- Failed tasks retain all telemetry emitted before failure. A null cost means the harness did not expose provider-adjusted pricing.
- Persistent Cuppet/OpenCode sequences reuse one native session; Codex and Claude Code persistent-family entries currently run sequential native CLI turns because their resume/session telemetry is not yet reliable enough to claim a single persistent session.

## Per-task results

- Repeat 1, **opencode**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 47905; cached input 269312; uncached input 43163; tools 33.
- Repeat 1, **codex**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 39452; cached input 317696; uncached input 34351; tools 11.
- Repeat 1, **cuppet**, `task-tracker-cross-file`: failed; acceptance 75.0%; model tokens 21612; cached input 22528; uncached input 20649; tools 16; node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: legacy dueDate/due-date tokens remain

true !== false

    at verifyTaskTracker (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:33:10)
    at async <anonymous> (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:7:1) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: true,
  expected: false,
  operator: 'strictEqual',
  diff: 'simple'
}

Node.js v22.21.0.
- Repeat 1, **cuppet**, `quiz-game-greenfield`: success; acceptance 100.0%; model tokens 34548; cached input 185856; uncached input 28791; tools 18.
- Repeat 1, **opencode**, `quiz-game-greenfield`: success; acceptance 100.0%; model tokens 33992; cached input 134144; uncached input 29467; tools 14.
- Repeat 1, **codex**, `quiz-game-greenfield`: success; acceptance 100.0%; model tokens 58509; cached input 243200; uncached input 52092; tools 8.
- Repeat 1, **opencode**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 28757; cached input 133632; uncached input 24570; tools 12.
- Repeat 1, **opencode**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 21592; cached input 269824; uncached input 16201; tools 15.
- Repeat 1, **opencode**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 14565; cached input 289280; uncached input 12492; tools 14.
- Repeat 1, **opencode**, `switch-a-auth`: success; acceptance 100.0%; model tokens 4289; cached input 176640; uncached input 3668; tools 4.
- Repeat 1, **opencode**, `switch-a-followup`: success; acceptance 100.0%; model tokens 2394; cached input 109056; uncached input 1910; tools 2.
- Repeat 1, **opencode**, `switch-b-auth`: success; acceptance 100.0%; model tokens 2825; cached input 148480; uncached input 2313; tools 3.
- Repeat 1, **opencode**, `switch-b-followup`: success; acceptance 100.0%; model tokens 2854; cached input 113152; uncached input 2407; tools 2.
- Repeat 1, **opencode**, `switch-c`: success; acceptance 100.0%; model tokens 3836; cached input 153600; uncached input 3240; tools 3.
- Repeat 1, **opencode**, `switch-a-return`: success; acceptance 100.0%; model tokens 2778; cached input 118272; uncached input 2407; tools 2.
- Repeat 1, **codex**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 48414; cached input 177920; uncached input 41550; tools 7.
- Repeat 1, **codex**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 38604; cached input 266496; uncached input 29716; tools 9.
- Repeat 1, **codex**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 42047; cached input 258560; uncached input 33301; tools 6.
- Repeat 1, **codex**, `switch-a-auth`: success; acceptance 100.0%; model tokens 16332; cached input 104960; uncached input 14806; tools 4.
- Repeat 1, **codex**, `switch-a-followup`: success; acceptance 100.0%; model tokens 26719; cached input 77568; uncached input 25108; tools 3.
- Repeat 1, **codex**, `switch-b-auth`: success; acceptance 100.0%; model tokens 17365; cached input 85760; uncached input 15588; tools 3.
- Repeat 1, **codex**, `switch-b-followup`: success; acceptance 100.0%; model tokens 33967; cached input 119040; uncached input 31816; tools 5.
- Repeat 1, **codex**, `switch-c`: success; acceptance 100.0%; model tokens 23953; cached input 155904; uncached input 22271; tools 5.
- Repeat 1, **codex**, `switch-a-return`: success; acceptance 100.0%; model tokens 32526; cached input 137216; uncached input 30747; tools 6.
- Repeat 1, **cuppet**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 23957; cached input 162304; uncached input 19801; tools 15.
- Repeat 1, **cuppet**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 15740; cached input 162816; uncached input 12564; tools 11.
- Repeat 1, **cuppet**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 14088; cached input 198144; uncached input 11816; tools 12.
- Repeat 1, **cuppet**, `switch-a-auth`: success; acceptance 100.0%; model tokens 7443; cached input 166400; uncached input 6676; tools 5.
- Repeat 1, **cuppet**, `switch-a-followup`: success; acceptance 100.0%; model tokens 5712; cached input 146432; uncached input 5054; tools 4.
- Repeat 1, **cuppet**, `switch-b-auth`: success; acceptance 100.0%; model tokens 5976; cached input 200192; uncached input 5143; tools 5.
- Repeat 1, **cuppet**, `switch-b-followup`: success; acceptance 100.0%; model tokens 6193; cached input 173056; uncached input 5591; tools 4.
- Repeat 1, **cuppet**, `switch-c`: success; acceptance 100.0%; model tokens 6475; cached input 185344; uncached input 5753; tools 3.
- Repeat 1, **cuppet**, `switch-a-return`: success; acceptance 100.0%; model tokens 6550; cached input 198656; uncached input 6138; tools 3.
- Repeat 1, **cuppet**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 29818; cached input 42496; uncached input 23181; tools 7; node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: operations-dashboard references a remote URL

true !== false

    at verifyWebProject (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:86:10)
    at async <anonymous> (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:7:1) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: true,
  expected: false,
  operator: 'strictEqual',
  diff: 'simple'
}

Node.js v22.21.0.
- Repeat 1, **opencode**, `long-tool-use-dashboard`: success; acceptance 100.0%; model tokens 65925; cached input 353792; uncached input 54516; tools 22.
- Repeat 1, **codex**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 42040; cached input 337664; uncached input 33671; tools 10; node:internal/modules/run_main:123
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
    '  <meta charset="utf-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    '  <title>fieldnote · operations</title>\n' +
    '  <link rel="stylesheet" href="styles.css" />\n' +
    '</head>\n' +
    '<body>\n' +
    '  <div class="app-shell">\n' +
    '    <aside class="sidebar" aria-label="primary navigation">\n' +
    '      <div class="brand"><span class="brand-mark">f</span><span>fieldnote</span></div>\n' +
    '      <div class="workspace-label">workspace</div>\n' +
    '      <button class="workspace-switcher" type="button"><span class="avatar blue">op</span><span><strong>operations</strong><small>local workspace</small></span><span class="chevron">⌄</span></button>\n' +
    '      <nav class="nav-links">\n' +
    '        <a class="nav-item active" href="#records"><span>▦</span> overview</a>\n' +
    '        <a class="nav-item" href="#records"><span>◫</span> all records <b>12</b></a>\n' +
    '        <a class="nav-item" href="#activity"><span>◷</span> activity</a>\n' +
    '      </nav>\n' +
    '      <div class="sidebar-bottom">\n' +
    '        <a class="nav-item" href="#help"><span>?</span> help center</a>\n' +
    '        <div class="user-card"><span class="avatar orange">am</span><span><strong>alex morgan</strong><small>administrator</small></span><span>•••</span></div>\n' +
    '      </div>\n' +
    '    </aside>\n' +
    '\n' +
    '    <main class="main-content">\n' +
    '      <header class="topbar"><button class="mobile-menu" aria-label="open navigation">☰</button><div class="breadcrumbs"><span>operations</span><span>/</span><strong>overview</strong></div><div class="top-actions"><button class="icon-button" aria-label="notifications">♧</button><button class="avatar small blue" aria-label="account">am</button></div></header>\n' +
    '      <section class="page-wrap">\n' +
    '        <div class="page-heading"><div><p class="eyebrow">monday, september 08, 2025</p><h1>good morning, alex <span class="wave">✦</span></h1><p class="subheading">here’s what needs your attention today.</p></div><button class="primary-button" id="new-record">＋ new record</button></div>\n' +
    '\n' +
    '        <section class="metric-grid" aria-label="workspace metrics">\n' +
    '          <article class="metric-card"><div class="metric-top"><span>open records</span><span class="metric-icon indigo">↗</span></div><strong>12</strong><p><span class="trend up">↑ 8.2%</span> <span>vs last week</span></p></article>\n' +
    '          <article class="metric-card"><div class="metric-top"><span>in progress</span><span class="metric-icon amber">◒</span></div><strong>07</strong><p><span class="trend up">↑ 3.1%</span> <span>vs last week</span></p></article>\n' +
    '          <article class="metric-card"><div class="metric-top"><span>due this week</span><span class="metric-icon rose">◷</span></div><strong>04</strong><p><span class="trend down">↓ 12.5%</span> <span>vs last week</span></p></article>\n' +
    '          <article class="metric-card"><div class="metric-top"><span>completed</span><span class="metric-icon green">✓</span></div><strong>28</strong><p><span class="trend up">↑ 18.4%</span> <span>vs last week</span></p></article>\n' +
    '        </section>\n' +
    '\n' +
    '        <section class="records-section" id="records"><div class="section-heading"><div><h2>recent records</h2><p>keep an eye on active work across your workspace.</p></div><button class="text-button" id="view-all">view all records <span>→</span></button></div>\n' +
    '          <div class="toolbar"><label class="search-box"><span>⌕</span><input id="search" type="search" placeholder="search records..." /></label><div class="filters"><label><span class="sr-only">filter by status</span><select id="status-filter"><option value="all">all statuses</option><option value="in-progress">in progress</option><option value="review">in review</option><option value="blocked">blocked</option><option value="done">completed</option></select></label><label><span class="sr-only">filter by priority</span><select id="priority-filter"><option value="all">all priorities</option><option value="high">high priority</option><option value="medium">medium priority</option><option value="low">low priority</option></select></label></div></div>\n' +
    '          <div class="table-card"><table><thead><tr><th>record</th><th>owner</th><th>status</th><th>priority</th><th>due date</th><th></th></tr></thead><tbody id="records-body"></tbody></table><div class="empty-state" id="empty-state" hidden><div class="empty-icon">⌕</div><h3>no records found</h3><p>try adjusting your search or filters.</p><button class="secondary-button" id="clear-filters">clear filters</button></div></div>\n' +
    '        </section>\n' +
    '        <section class="lower-grid" id="activity"><article class="activity-card"><div class="section-heading"><div><h2>activity</h2><p>latest updates from your team.</p></div><button class="icon-button" aria-label="more activity options">•••</button></div><div class="activity-list"><div class="activity-item"><span class="avatar purple">jr</span><p><strong>jordan reed</strong> moved <b>q3 vendor audit</b> to in review<small>12 minutes ago</small></p></div><div class="activity-item"><span class="avatar teal">sk</span><p><strong>sam kim</strong> completed <b>inventory count · east</b><small>48 minutes ago</small></p></div><div class="activity-item"><span class="avatar orange">am</span><p><strong>you</strong> created <b>safety walkthrough</b><small>2 hours ago</small></p></div></div></article><article class="details-card" id="details"><div class="details-placeholder"><div class="detail-symbol">↗</div><h2>select a record</h2><p>choose a record from the table to see its details here.</p></div><div class="details-content" hidden></div></article></section>\n' +
    '      </section>\n' +
    '    </main>\n' +
    '  </div>\n' +
    '  <script src="app.js"></script>\n' +
    '</body>\n' +
    '</html>\n' +
    '\n' +
    ':root{--ink:#192033;--muted:#788196;--line:#e7eaf0;--paper:#fff;--canvas:#f7f8fb;--indigo:#5b5ce2;--green:#23936b;--amber:#b87817;--rose:#c75168}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--canvas);font:14px/1.45 inter,ui-sans-serif,system-ui,-apple-system,sans-serif}.app-shell{display:flex;min-height:100vh}.sidebar{width:246px;background:#fff;border-right:1px solid var(--line);padding:25px 16px 18px;display:flex;flex-direction:column;flex-shrink:0}.brand{display:flex;gap:10px;align-items:center;font-size:18px;font-weight:750;letter-spacing:-.4px;padding:0 10px 36px}.brand-mark{display:grid;place-items:center;width:28px;height:28px;background:#20243a;color:#fff;border-radius:8px;font-weight:800}.workspace-label,.eyebrow{color:#9aa1b1;text-transform:uppercase;letter-spacing:.1em;font-size:10px;font-weight:750}.workspace-label{padding:0 10px 8px}.workspace-switcher{display:flex;align-items:center;gap:9px;width:100%;padding:10px;border:1px solid var(--line);background:#fff;border-radius:9px;text-align:left;color:var(--ink);font-size:12px}.workspace-switcher strong,.user-card strong{display:block}.workspace-switcher small,.user-card small{display:block;color:var(--muted);font-size:11px}.chevron{margin-left:auto;color:var(--muted)}.avatar{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;color:#fff;font-size:10px;font-weight:750;flex-shrink:0}.avatar.blue{background:#5c64b6}.avatar.orange{background:#db8e4c}.avatar.purple{background:#8866ba}.avatar.teal{background:#46a7a0}.nav-links{display:grid;gap:4px;margin-top:28px}.nav-item{display:flex;align-items:center;gap:12px;padding:10px 12px;color:#788196;text-decoration:none;border-radius:8px;font-weight:600}.nav-item span{font-size:18px;width:18px;text-align:center}.nav-item.active,.nav-item:hover{background:#f0f0ff;color:#5253ce}.nav-item b{margin-left:auto;font-size:11px;color:#a2a8b6}.sidebar-bottom{margin-top:auto}.user-card{display:flex;align-items:center;gap:9px;border-top:1px solid var(--line);padding:18px 8px 0;font-size:12px}.user-card>span:last-child{margin-left:auto;color:#a2a8b6}.main-content{min-width:0;flex:1}.topbar{height:70px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 clamp(24px,4vw,56px)}.breadcrumbs{display:flex;gap:12px;color:#9aa1b1;font-size:12px}.breadcrumbs strong{color:var(--ink)}.top-actions{margin-left:auto;display:flex;align-items:center;gap:18px}.icon-button{border:0;background:transparent;color:#7d8496;font-size:16px;cursor:pointer}.avatar.small{width:31px;height:31px}.mobile-menu{display:none}.page-wrap{max-width:1290px;margin:auto;padding:40px clamp(24px,4vw,56px)}.page-heading,.section-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}.page-heading{margin-bottom:32px}.eyebrow{margin:0 0 8px}.page-heading h1{margin:0;font-size:29px;letter-spacing:-1px}.wave{color:#edb553;font-size:22px}.subheading,.section-heading p{color:var(--muted);margin:6px 0 0}.primary-button,.secondary-button{border:0;border-radius:8px;padding:10px 15px;font-weight:700;cursor:pointer}.primary-button{background:var(--indigo);color:#fff;box-shadow:0 4px 10px #5b5ce233}.secondary-button{background:#f0f0ff;color:#5455d4}.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:42px}.metric-card,.activity-card,.details-card,.table-card{background:var(--paper);border:1px solid var(--line);border-radius:11px}.metric-card{padding:18px 20px}.metric-top{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.metric-card>strong{display:block;font-size:28px;margin:12px 0 2px;letter-spacing:-1px}.metric-card p{margin:0;color:#a1a7b5;font-size:11px}.trend{font-weight:750}.up{color:var(--green)}.down{color:var(--rose)}.metric-icon{display:grid;place-items:center;width:27px;height:27px;border-radius:7px}.indigo{background:#eeeeff;color:var(--indigo)}.amber{background:#fff6e4;color:var(--amber)}.rose{background:#fff0f2;color:var(--rose)}.green{background:#eaf8f2;color:var(--green)}h2{margin:0;font-size:16px;letter-spacing:-.2px}.section-heading{margin-bottom:17px}.text-button{border:0;background:none;color:var(--indigo);font-weight:700;cursor:pointer}.toolbar{display:flex;justify-content:space-between;gap:14px;margin-bottom:12px}.search-box{display:flex;align-items:center;gap:8px;background:#fff;border:1px soli'... 8073 more characters,
  expected: /dashboard/,
  operator: 'match',
  diff: 'simple'
}

Node.js v22.21.0.
- Repeat 2, **cuppet**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 40101; cached input 267264; uncached input 35762; tools 31.
- Repeat 2, **opencode**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 39785; cached input 289792; uncached input 35325; tools 33.
- Repeat 2, **codex**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 39690; cached input 289280; uncached input 35116; tools 8.
- Repeat 2, **opencode**, `quiz-game-greenfield`: success; acceptance 100.0%; model tokens 51853; cached input 133632; uncached input 45925; tools 18.
- Repeat 2, **codex**, `quiz-game-greenfield`: success; acceptance 100.0%; model tokens 32702; cached input 146944; uncached input 26894; tools 5.
- Repeat 2, **cuppet**, `quiz-game-greenfield`: success; acceptance 100.0%; model tokens 36919; cached input 196096; uncached input 30832; tools 19.
- Repeat 2, **cuppet**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 47151; cached input 123392; uncached input 41788; tools 13.
- Repeat 2, **cuppet**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 24074; cached input 103936; uncached input 20423; tools 8.
- Repeat 2, **cuppet**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 29521; cached input 288256; uncached input 25799; tools 14.
- Repeat 2, **cuppet**, `switch-a-auth`: success; acceptance 100.0%; model tokens 13241; cached input 190976; uncached input 12360; tools 6.
- Repeat 2, **cuppet**, `switch-a-followup`: success; acceptance 100.0%; model tokens 9093; cached input 167936; uncached input 8478; tools 4.
- Repeat 2, **cuppet**, `switch-b-auth`: success; acceptance 100.0%; model tokens 10105; cached input 228864; uncached input 9110; tools 5.
- Repeat 2, **cuppet**, `switch-b-followup`: success; acceptance 100.0%; model tokens 11201; cached input 195584; uncached input 10542; tools 5.
- Repeat 2, **cuppet**, `switch-c`: success; acceptance 100.0%; model tokens 12795; cached input 263680; uncached input 11908; tools 5.
- Repeat 2, **cuppet**, `switch-a-return`: success; acceptance 100.0%; model tokens 10989; cached input 226304; uncached input 10440; tools 5.
- Repeat 2, **opencode**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 29778; cached input 152576; uncached input 25424; tools 13.
- Repeat 2, **opencode**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 20339; cached input 146432; uncached input 13490; tools 10.
- Repeat 2, **opencode**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 15339; cached input 235008; uncached input 12664; tools 13.
- Repeat 2, **opencode**, `switch-a-auth`: success; acceptance 100.0%; model tokens 4213; cached input 192000; uncached input 3564; tools 4.
- Repeat 2, **opencode**, `switch-a-followup`: success; acceptance 100.0%; model tokens 4536; cached input 156672; uncached input 3979; tools 3.
- Repeat 2, **opencode**, `switch-b-auth`: success; acceptance 100.0%; model tokens 3358; cached input 202240; uncached input 2670; tools 4.
- Repeat 2, **opencode**, `switch-b-followup`: success; acceptance 100.0%; model tokens 5039; cached input 163840; uncached input 4505; tools 3.
- Repeat 2, **opencode**, `switch-c`: success; acceptance 100.0%; model tokens 4758; cached input 210432; uncached input 4085; tools 4.
- Repeat 2, **opencode**, `switch-a-return`: success; acceptance 100.0%; model tokens 4638; cached input 172032; uncached input 4257; tools 3.
- Repeat 2, **codex**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 45541; cached input 147712; uncached input 41328; tools 5.
- Repeat 2, **codex**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 25151; cached input 209664; uncached input 18209; tools 6.
- Repeat 2, **codex**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 31640; cached input 203776; uncached input 28017; tools 6.
- Repeat 2, **codex**, `switch-a-auth`: success; acceptance 100.0%; model tokens 13704; cached input 108032; uncached input 11916; tools 4.
- Repeat 2, **codex**, `switch-a-followup`: success; acceptance 100.0%; model tokens 18998; cached input 128256; uncached input 16670; tools 5.
- Repeat 2, **codex**, `switch-b-auth`: success; acceptance 100.0%; model tokens 21565; cached input 108288; uncached input 19636; tools 3.
- Repeat 2, **codex**, `switch-b-followup`: success; acceptance 100.0%; model tokens 20954; cached input 172800; uncached input 18819; tools 7.
- Repeat 2, **codex**, `switch-c`: success; acceptance 100.0%; model tokens 7568; cached input 115200; uncached input 6006; tools 4.
- Repeat 2, **codex**, `switch-a-return`: success; acceptance 100.0%; model tokens 27575; cached input 215552; uncached input 25719; tools 8.
- Repeat 2, **opencode**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 67039; cached input 260096; uncached input 58571; tools 22; node:internal/modules/run_main:123
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
    '  <meta name="description" content="a local-first operations control room.">\n' +
    '  <title>northstar / operations</title>\n' +
    '  <link rel="stylesheet" href="styles.css">\n' +
    '</head>\n' +
    '<body>\n' +
    '  <div class="app-shell">\n' +
    '    <aside class="sidebar" id="sidebar">\n' +
    '      <div class="brand"><span class="brand-mark">n</span><span>northstar</span></div>\n' +
    '      <p class="workspace-label">workspace</p>\n' +
    '      <div class="workspace-switcher"><span class="workspace-dot"></span><span>field operations</span><span class="chevron">⌄</span></div>\n' +
    '      <nav aria-label="primary navigation">\n' +
    '        <a class="nav-link active" href="#overview"><span class="nav-icon">▦</span>overview</a>\n' +
    '        <a class="nav-link" href="#records"><span class="nav-icon">≡</span>all records <span class="nav-count">12</span></a>\n' +
    '        <a class="nav-link" href="#attention"><span class="nav-icon">△</span>needs attention <span class="nav-count alert-count">4</span></a>\n' +
    '        <a class="nav-link" href="#activity"><span class="nav-icon">↗</span>activity</a>\n' +
    '      </nav>\n' +
    '      <div class="sidebar-bottom"><div class="local-badge"><span></span>local workspace</div><p>data stays in this browser.<br>no account required.</p></div>\n' +
    '    </aside>\n' +
    '    <main class="main-content" id="overview">\n' +
    '      <header class="topbar"><button class="icon-button menu-button" id="menubutton" aria-label="open navigation">☰</button><div class="breadcrumb"><span>operations</span><b>/</b><strong>overview</strong></div><div class="topbar-actions"><span class="sync-label"><i></i>saved locally</span><button class="icon-button" aria-label="notifications">♢</button><button class="avatar" aria-label="open profile">jd</button></div></header>\n' +
    '      <div class="page-wrap">\n' +
    '        <section class="page-heading"><div><p class="eyebrow">monday, 14 october 2024 <span class="line"></span> 09:41 local</p><h1>good morning, jordan.</h1><p class="lede">here is the pulse of your operation. stay close to what needs you.</p></div><button class="primary-button" id="addrecordbutton"><span>＋</span> add record</button></section>\n' +
    '        <section class="metric-grid" aria-label="operational metrics">\n' +
    '          <article class="metric-card"><div class="metric-top"><span>open items</span><span class="metric-icon">◌</span></div><strong>12</strong><div class="metric-foot"><span class="trend up">↗ 8.4%</span><span>vs last week</span></div></article>\n' +
    '          <article class="metric-card accent"><div class="metric-top"><span>needs attention</span><span class="metric-icon">△</span></div><strong>4</strong><div class="metric-foot"><span class="trend down">↘ 12.5%</span><span>vs last week</span></div></article>\n' +
    '          <article class="metric-card"><div class="metric-top"><span>on track</span><span class="metric-icon">✓</span></div><strong>67%</strong><div class="metric-foot"><span class="trend up">↗ 4.2%</span><span>vs last week</span></div></article>\n' +
    '          <article class="metric-card"><div class="metric-top"><span>avg. resolution</span><span class="metric-icon">◷</span></div><strong>2.4 <small>days</small></strong><div class="metric-foot"><span class="trend up">↗ 0.6d</span><span>faster than avg.</span></div></article>\n' +
    '        </section>\n' +
    '        <section class="records-section" id="records">\n' +
    '          <div class="section-heading"><div><p class="eyebrow">live register</p><h2>operational records <span class="record-total">12 total</span></h2></div><button class="text-button" id="clearfilters">clear filters <span>↗</span></button></div>\n' +
    '          <div class="toolbar"><label class="search-box"><span>⌕</span><input id="searchinput" type="search" placeholder="search records..." aria-label="search records"></label><div class="filter-group"><label for="statusfilter">status</label><select id="statusfilter"><option value="all">all statuses</option><option value="active">active</option><option value="review">in review</option><option value="blocked">blocked</option><option value="done">complete</option></select><label for="priorityfilter">priority</label><select id="priorityfilter"><option value="all">all priorities</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option></select></div></div>\n' +
    '          <div class="table-card"><div class="table-scroll"><table><thead><tr><th>record</th><th>owner</th><th>status</th><th>priority</th><th>updated</th><th><span class="sr-only">open</span></th></tr></thead><tbody id="recordsbody"></tbody></table></div><div class="empty-state" id="emptystate" hidden><div class="empty-mark">⌕</div><h3>no records found</h3><p>try a different search or clear the filters to see more of your register.</p><button class="secondary-button" id="emptyreset">reset view</button></div><div class="table-footer"><span id="resultsummary">showing 8 of 12 records</span><div class="pagination"><button class="page-button" disabled aria-label="previous page">←</button><span>1 / 2</span><button class="page-button" aria-label="next page">→</button></div></div></div>\n' +
    '        </section>\n' +
    '        <aside class="details-panel" id="detailspanel" aria-live="polite"><div class="details-placeholder"><span class="detail-icon">⌁</span><div><p class="eyebrow">record inspector</p><h2>select a record</h2><p>choose an item from the register to see its context, owner, and next steps.</p></div></div></aside>\n' +
    '        <footer><span>northstar operations <b>•</b> v1.4.2</span><span>all systems nominal <i class="pulse"></i></span></footer>\n' +
    '      </div>\n' +
    '    </main>\n' +
    '  </div>\n' +
    '  <script src="app.js"></script>\n' +
    '</body>\n' +
    '</html>\n' +
    '\n' +
    ":root{--ink:#202523;--muted:#77807c;--line:#dde2de;--paper:#f4f6f2;--card:#fff;--navy:#183b45;--lime:#c8e86a;--red:#c94d43;--amber:#c1872e}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:manrope,arial,sans-serif}button,input,select{font:inherit}button,a,select,input{outline-color:#4d731b}.app-shell{display:flex;min-height:100vh}.sidebar{width:240px;background:var(--navy);color:#e5eeea;padding:25px 16px;display:flex;flex-direction:column;flex-shrink:0}.brand{font-weight:800;font-size:19px;letter-spacing:-.04em;padding:0 11px 47px}.brand-mark{display:inline-grid;place-items:center;background:var(--lime);color:var(--navy);width:26px;height:26px;border-radius:7px;margin-right:8px}.workspace-label,.eyebrow{font:500 10px 'dm mono',monospace;letter-spacing:.14em;color:#91aaa8}.workspace-label{padding:0 12px;margin:0 0 9px}.workspace-switcher{height:42px;border:1px solid #3b5b62;border-radius:7px;padding:0 11px;display:flex;align-items:center;gap:9px;font-size:12px;margin-bottom:31px}.workspace-dot{width:7px;height:7px;border-radius:50%;background:var(--lime)}.chevron{margin-left:auto;color:#94aaa7;font-size:16px}.nav-link{display:flex;align-items:center;gap:11px;padding:12px;border-radius:6px;color:#9bb0ad;text-decoration:none;font-size:12px;margin:2px 0}.nav-link.active,.nav-link:hover{background:#2b5259;color:#fff}.nav-icon{font-size:17px;width:18px;text-align:center}.nav-count{margin-left:auto;font:11px 'dm mono';color:#94aaa7}.alert-count{color:var(--lime)}.sidebar-bottom{margin-top:auto;padding:19px 12px 0;border-top:1px solid #31545a}.local-badge{font-size:11px;color:#d6e1dd}.local-badge span{display:inline-block;width:6px;height:6px;background:var(--lime);border-radius:50%;margin-right:7px}.sidebar-bottom p{color:#77918f;font-size:10px;line-height:1.6;margin:9px 0}.main-content{flex:1;min-width:0}.topbar{height:75px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 48px;gap:20px}.breadcrumb{font-size:12px;color:var(--muted)}.breadcrumb b{font-weight:400;margin:0 10px;color:#c4cbc7}.breadcrumb strong{color:var(--ink)}.topbar-actions{margin-left:auto;display:flex;align-items:center;gap:21px}.sync-label{font:10px 'dm mono';color:#78837f}.sync-label i,.pulse{display:inline-block;width:6px;height:6px;border-radius:50%;background:#8dc449;margin-right:6px}.icon-button,.avatar{border:0;background:transparent;color:#71807b;cursor:pointer}.avatar{background:#dfead7;color:#4e663e;border-radius:50%;width:30px;height:30px;font-size:10px;font-weight:700}.menu-button{display:none}.page-wrap{max-width:1400px;margin:0 auto;padding:47px 48px 25px}.page-heading{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:38px}.eyebrow{margin:0;color:#8a9690}.line{display:inline-block;width:22px;border-top:1px solid #b3bdb8;vertical-align:middle;margin:0 10px}.page-heading h1{font-size:30px;letter-spacing:-.06em;margin:13px 0 7px}.lede{color:var(--muted);font-size:13px;margin:0}.primary-button,.secondary-button{border:0;border-radius:5px;cursor:pointer;font-weight:700}.primary-button{background:var(--navy);color:#fff;padding:12px 17px;font-size:12px}.primary-button span{color:var(--lime);font-size:18px;vertical-align:-1px;margin-right:7px}.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin-bottom:49px}.metric-card{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:17px 19px 15px;min-height:135px}.metric-card.accent{border-top:2px solid var(--red)}.metric-top,.metric-foot{display:flex;justify-content:space-between;align-items:center}.metric-top{color:#6c7772;font-size:11px}.metric-icon{color:#8b9b96;font-size:17px}.metric-card strong{display:block;font:500 35px 'dm mono';letter-spacing:-.08em;margin:13px 0 12px}.metric-card small{font:12px manrope;color:#78827e;letter-spacing:0}.metric-foot{font:10px 'dm mono';color:#98a19c}.trend{font-weight:500}.up{color:#789e3c}.down{color:var(--red)}.section-heading{display:flex;justify-content:space-between;align-items:end;margin-bottom:18px}.section-heading h2{margin:10px 0 0;font-size:19px;letter-spacing:-.04em}.record-total{font:10px 'dm mono';color:#89938e;margin-left:9px;letter-spacing:0}.text-button{border:0;background:none;color:#67813c;font-size:11px;cursor:pointer;padding:8p"... 9108 more characters,
  expected: /dashboard/,
  operator: 'match',
  diff: 'simple'
}

Node.js v22.21.0.
- Repeat 2, **codex**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 36465; cached input 212992; uncached input 27665; tools 6; node:internal/modules/run_main:123
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
    '    <aside class="sidebar" aria-label="primary navigation">\n' +
    '      <div class="brand"><span class="brand-mark">n</span><span>northstar</span></div>\n' +
    '      <div class="workspace-switcher"><span class="workspace-dot"></span><span>acme operations</span><span class="chevron">⌄</span></div>\n' +
    '      <p class="nav-label">workspace</p>\n' +
    '      <nav class="nav-links">\n' +
    '        <a class="nav-link active" href="#overview"><span>▦</span> overview</a>\n' +
    '        <a class="nav-link" href="#records"><span>▤</span> all records <b>24</b></a>\n' +
    '        <a class="nav-link" href="#alerts"><span>♢</span> alerts <b class="alert-count">3</b></a>\n' +
    '        <a class="nav-link" href="#reports"><span>◒</span> reports</a>\n' +
    '      </nav>\n' +
    '      <p class="nav-label">manage</p>\n' +
    '      <nav class="nav-links">\n' +
    '        <a class="nav-link" href="#team"><span>♧</span> team</a>\n' +
    '        <a class="nav-link" href="#settings"><span>⚙</span> settings</a>\n' +
    '      </nav>\n' +
    '      <div class="sidebar-footer"><div class="avatar">jd</div><div><strong>jordan davis</strong><small>admin</small></div><span class="more">•••</span></div>\n' +
    '    </aside>\n' +
    '\n' +
    '    <main class="main-content" id="overview">\n' +
    '      <header class="topbar"><div class="breadcrumb">workspace <span>/</span> <strong>overview</strong></div><div class="top-actions"><button class="icon-button" aria-label="notifications">♧<i></i></button><div class="avatar small">jd</div></div></header>\n' +
    '      <section class="page-heading"><div><p class="eyebrow">monday, september 08, 2026</p><h1>good morning, jordan <span>✦</span></h1><p class="muted">here’s what’s happening across your operations today.</p></div><button class="primary-button" id="exportbutton">↥ export report</button></section>\n' +
    '      <section class="metrics" aria-label="key metrics">\n' +
    '        <article class="metric-card"><div class="metric-top"><span>open records</span><span class="metric-icon purple">▤</span></div><strong>24</strong><p class="trend up">↗ 12.5% <em>vs last week</em></p><div class="spark purple-spark"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></article>\n' +
    '        <article class="metric-card"><div class="metric-top"><span>in progress</span><span class="metric-icon blue">◔</span></div><strong>08</strong><p class="trend up">↗ 4.2% <em>vs last week</em></p><div class="spark blue-spark"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></article>\n' +
    '        <article class="metric-card"><div class="metric-top"><span>at risk</span><span class="metric-icon orange">△</span></div><strong>03</strong><p class="trend down">↘ 2.1% <em>vs last week</em></p><div class="spark orange-spark"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></article>\n' +
    '        <article class="metric-card"><div class="metric-top"><span>completed this month</span><span class="metric-icon green">✓</span></div><strong>42</strong><p class="trend up">↗ 18.7% <em>vs last week</em></p><div class="spark green-spark"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></article>\n' +
    '      </section>\n' +
    '      <section class="records-section" id="records"><div class="section-heading"><div><h2>recent records</h2><p class="muted">track and manage your active operational work.</p></div><button class="outline-button" id="newrecordbutton">＋ new record</button></div>\n' +
    '        <div class="toolbar"><label class="search"><span>⌕</span><input id="searchinput" type="search" placeholder="search records..." aria-label="search records"></label><select id="statusfilter" aria-label="filter by status"><option value="all">all statuses</option><option value="in-progress">in progress</option><option value="at-risk">at risk</option><option value="completed">completed</option><option value="on-hold">on hold</option></select><select id="priorityfilter" aria-label="filter by priority"><option value="all">all priorities</option><option value="high">high priority</option><option value="medium">medium priority</option><option value="low">low priority</option></select><button class="filter-button" id="clearfilters">clear filters</button></div>\n' +
    '        <div class="table-wrap"><table><thead><tr><th>record</th><th>owner</th><th>status</th><th>priority</th><th>due date</th><th></th></tr></thead><tbody id="recordsbody"></tbody></table><div class="empty-state" id="emptystate" hidden><div class="empty-icon">⌕</div><h3>no records found</h3><p>try adjusting your search or clearing the filters.</p><button class="outline-button" id="emptyclear">clear filters</button></div></div>\n' +
    '      </section>\n' +
    '    </main>\n' +
    '    <aside class="details-panel" aria-label="record details"><div class="panel-head"><div><p class="eyebrow">selected record</p><h2 id="detailtitle">inventory reconciliation</h2></div><button class="close-button" id="closedetails" aria-label="close details">×</button></div><div class="detail-status" id="detailstatus">● in progress</div><div class="detail-block"><span class="detail-label">description</span><p id="detaildescription">reconcile the latest warehouse counts with the inventory system and flag any variance over 2%.</p></div><div class="detail-grid"><div><span class="detail-label">owner</span><p id="detailowner">maya chen</p></div><div><span class="detail-label">due date</span><p id="detaildue">sep 12, 2026</p></div></div><div class="progress-heading"><span>progress</span><strong id="detailprogresslabel">68%</strong></div><div class="progress"><span id="detailprogress" style="width:68%"></span></div><div class="activity"><span class="detail-label">recent activity</span><p><b class="activity-dot"></b><span><strong>maya chen</strong> updated the record<small>today, 9:42 am</small></span></p><p><b class="activity-dot muted-dot"></b><span><strong>jordan davis</strong> added a comment<small>yesterday, 4:18 pm</small></span></p></div><button class="primary-button full" id="openrecord">open full record →</button></aside>\n' +
    '  </div>\n' +
    '  <div class="toast" id="toast" role="status" aria-live="polite"></div>\n' +
    '  <script src="app.js"></script>\n' +
    '</body>\n' +
    '</html>\n' +
    '\n' +
    ':root{--ink:#20202b;--muted:#7f7f91;--line:#e9e8ef;--purple:#6f58d9;--bg:#fbfbfd;--sidebar:#fff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px inter,ui-sans-serif,system-ui,-apple-system,sans-serif}.app-shell{display:grid;grid-template-columns:220px minmax(560px,1fr) 292px;min-height:100vh}.sidebar{background:var(--sidebar);border-right:1px solid var(--line);padding:28px 15px 20px;display:flex;flex-direction:column}.brand{font-size:21px;font-weight:750;letter-spacing:-.7px;padding:0 12px 30px;display:flex;align-items:center;gap:9px}.brand-mark{background:#6f58d9;color:#fff;border-radius:7px;width:26px;height:26px;text-align:center;padding-top:3px}.workspace-switcher{border:1px solid var(--line);border-radius:8px;padding:11px 10px;display:flex;gap:8px;align-items:center;font-size:12px;font-weight:650}.workspace-dot{width:8px;height:8px;border-radius:50%;background:#4cbd8b}.chevron{margin-left:auto;color:var(--muted)}.nav-label,.eyebrow{font-size:10px;letter-spacing:1px;color:#aaaabd;font-weight:750}.nav-label{margin:31px 12px 9px}.nav-links{display:grid;gap:4px}.nav-link{color:#777788;text-decoration:none;padding:10px 12px;border-radius:7px;display:flex;gap:12px;align-items:center}.nav-link span{font-size:18px;width:17px;color:#a1a0ae}.nav-link.active{background:#f1effd;color:var(--purple);font-weight:700}.nav-link.active span{color:var(--purple)}.nav-link b{margin-left:auto;font-size:11px;color:#a4a3b4}.alert-count{color:#e78355!important}.sidebar-footer{border-top:1px solid var(--line);margin-top:auto;padding:20px 8px 0;display:flex;align-items:center;gap:9px}.avatar{background:#eadff5;color:#8057a4;border-radius:50%;width:31px;height:31px;display:grid;place-items:center;font-size:10px;font-weight:750}.avatar.small{width:28px;height:28px}.sidebar-footer small{display:block;color:#aaaab8;font-size:11px;margin-top:2px}.more{margin-left:auto;color:#aaa}.main-content{padding:0 34px 50px;min-width:0}.topbar{height:76px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}.breadcrumb{color:#a3a2b0;font-size:12px}.breadcrumb span{padding:0 8px}.breadcrumb strong{color:#565566}.top-actions{display:flex;align-items:center;gap:20px}.icon-button,.close-button{border:0;background:transparent;color:#9291a2;font-size:19px;position:relative;cursor:pointer}.icon-button i{position:absolute;width:5px;height:5px;background:#e78355;border-radius:50%;top:2px;right:0}.page-heading{display:flex;justify-content:space-between;align-items:end;padding:40px 0 29px}.page-heading h1{font-size:27px;letter-spacing:-1px;margin:9px 0 7px}.page-heading h1 span{color:#f0ac59;font-size:20px}.eyebrow{margin:0}.muted{color:var(--muted);margin:0}.primary-button,.outline-button,.filter-button{border-radius:7px;padding:10px 14px;font:600 12px inherit;cursor:pointer}.primary-button{color:#fff;background:var(--purple);border:1px solid var(--purple);box-shadow:0 2px 5px #7562d333}.outline-button{background:#fff;border:1px solid #dedde7;color:#4f4e5e}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:13px}.metric-card{background:#fff;border:1px solid var(--line);border-radius:9px;padding:17px 17px 14px;min-width:0}.metric-top{display:flex;justify-content:space-between;color:#797888;font-size:12px}.metric-card>strong{font-size:28px;letter-spacing:-1px;display:block;margin-top:14px}.metric-icon{width:25px;height:25px;display:grid;place-items:center;border-radius:6px;font-size:12px}.purple{background:#f0edff;color:var(--purple)}.blue{background:#e9f5ff;color:#4a9ee7}.orange{background:#fff1e8;color:#e6864e}.green{bac'... 8894 more characters,
  expected: /dashboard/,
  operator: 'match',
  diff: 'simple'
}

Node.js v22.21.0.
- Repeat 2, **cuppet**, `long-tool-use-dashboard`: success; acceptance 100.0%; model tokens 52979; cached input 133632; uncached input 41630; tools 14.
- Repeat 3, **opencode**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 39590; cached input 349696; uncached input 34865; tools 35.
- Repeat 3, **codex**, `task-tracker-cross-file`: failed; acceptance 75.0%; model tokens 25796; cached input 371712; uncached input 21539; tools 8; /Users/addy/Downloads/cuppet/.benchmarks/cuppet-harness-comparison-g9s0rN/workspaces/repeat-3-task-tracker-cross-file-codex/games/task-tracker/src/core/taskFactory.ts:6
  if (!result.valid) throw new Error(result.errors.join('; '))
                           ^

Error: priority must be low, normal, or high
    at Module.buildTask (/Users/addy/Downloads/cuppet/.benchmarks/cuppet-harness-comparison-g9s0rN/workspaces/repeat-3-task-tracker-cross-file-codex/games/task-tracker/src/core/taskFactory.ts:6:28)
    at verifyTaskTracker (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:50:25)
    at async <anonymous> (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:7:1)

Node.js v22.21.0.
- Repeat 3, **cuppet**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 40250; cached input 260096; uncached input 35395; tools 32.
- Repeat 3, **cuppet**, `quiz-game-greenfield`: failed; acceptance 0.0%; model tokens 27837; cached input 105472; uncached input 23031; tools 13; node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: quiz-game has too few local records
    at verifyWebProject (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:85:10)
    at async <anonymous> (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:7:1) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '==',
  diff: 'simple'
}

Node.js v22.21.0.
- Repeat 3, **opencode**, `quiz-game-greenfield`: failed; acceptance 0.0%; model tokens 41138; cached input 130048; uncached input 35361; tools 16; node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: quiz-game has too few local records
    at verifyWebProject (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:85:10)
    at async <anonymous> (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:7:1) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '==',
  diff: 'simple'
}

Node.js v22.21.0.
- Repeat 3, **codex**, `quiz-game-greenfield`: success; acceptance 100.0%; model tokens 30151; cached input 257792; uncached input 21659; tools 7.
- Repeat 3, **opencode**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 25621; cached input 139264; uncached input 21025; tools 13.
- Repeat 3, **opencode**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 26562; cached input 351744; uncached input 19755; tools 17.
- Repeat 3, **opencode**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 14914; cached input 250368; uncached input 12698; tools 13.
- Repeat 3, **opencode**, `switch-a-auth`: success; acceptance 100.0%; model tokens 4822; cached input 202240; uncached input 4159; tools 4.
- Repeat 3, **opencode**, `switch-a-followup`: success; acceptance 100.0%; model tokens 2766; cached input 124416; uncached input 2243; tools 2.
- Repeat 3, **opencode**, `switch-b-auth`: success; acceptance 100.0%; model tokens 3597; cached input 212480; uncached input 2927; tools 4.
- Repeat 3, **opencode**, `switch-b-followup`: success; acceptance 100.0%; model tokens 4112; cached input 128512; uncached input 3634; tools 2.
- Repeat 3, **opencode**, `switch-c`: success; acceptance 100.0%; model tokens 4518; cached input 220672; uncached input 3831; tools 4.
- Repeat 3, **opencode**, `switch-a-return`: success; acceptance 100.0%; model tokens 3462; cached input 134656; uncached input 3162; tools 2.
- Repeat 3, **codex**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 25051; cached input 110336; uncached input 21316; tools 3.
- Repeat 3, **codex**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 45991; cached input 115968; uncached input 42006; tools 6.
- Repeat 3, **codex**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 50218; cached input 344320; uncached input 44811; tools 9.
- Repeat 3, **codex**, `switch-a-auth`: success; acceptance 100.0%; model tokens 17046; cached input 104960; uncached input 15479; tools 4.
- Repeat 3, **codex**, `switch-a-followup`: success; acceptance 100.0%; model tokens 23068; cached input 145408; uncached input 21032; tools 6.
- Repeat 3, **codex**, `switch-b-auth`: success; acceptance 100.0%; model tokens 21727; cached input 161792; uncached input 19383; tools 6.
- Repeat 3, **codex**, `switch-b-followup`: success; acceptance 100.0%; model tokens 21834; cached input 156672; uncached input 19850; tools 6.
- Repeat 3, **codex**, `switch-c`: success; acceptance 100.0%; model tokens 6886; cached input 94976; uncached input 5341; tools 3.
- Repeat 3, **codex**, `switch-a-return`: success; acceptance 100.0%; model tokens 19590; cached input 129280; uncached input 17932; tools 5.
- Repeat 3, **cuppet**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 24900; cached input 115200; uncached input 21109; tools 11.
- Repeat 3, **cuppet**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 16938; cached input 165888; uncached input 12979; tools 12.
- Repeat 3, **cuppet**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 14340; cached input 237568; uncached input 12471; tools 13.
- Repeat 3, **cuppet**, `switch-a-auth`: success; acceptance 100.0%; model tokens 6313; cached input 173568; uncached input 5570; tools 5.
- Repeat 3, **cuppet**, `switch-a-followup`: success; acceptance 100.0%; model tokens 5924; cached input 150528; uncached input 5316; tools 4.
- Repeat 3, **cuppet**, `switch-b-auth`: success; acceptance 100.0%; model tokens 6529; cached input 204288; uncached input 5710; tools 5.
- Repeat 3, **cuppet**, `switch-b-followup`: success; acceptance 100.0%; model tokens 6379; cached input 222720; uncached input 5689; tools 5.
- Repeat 3, **cuppet**, `switch-c`: success; acceptance 100.0%; model tokens 7226; cached input 239104; uncached input 6392; tools 5.
- Repeat 3, **cuppet**, `switch-a-return`: success; acceptance 100.0%; model tokens 5530; cached input 206848; uncached input 5032; tools 4.
- Repeat 3, **cuppet**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 45406; cached input 95232; uncached input 38548; tools 11; node:internal/modules/run_main:123
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
    '  <title>fieldnote operations</title>\n' +
    '  <link rel="stylesheet" href="styles.css">\n' +
    '</head>\n' +
    '<body>\n' +
    '  <div class="app-shell">\n' +
    '    <aside class="sidebar" aria-label="primary navigation">\n' +
    '      <div class="brand"><span class="brand-mark">fn</span><span>fieldnote<span class="brand-dot">.</span></span></div>\n' +
    '      <div class="workspace-label">workspace</div>\n' +
    '      <div class="workspace-switcher"><span class="workspace-icon">⌘</span><span>northstar ops</span><span class="chevron">⌄</span></div>\n' +
    '      <nav>\n' +
    '        <a class="nav-link active" href="#overview"><span>◈</span>overview</a>\n' +
    '        <a class="nav-link" href="#records"><span>▦</span>records <b>8</b></a>\n' +
    '        <a class="nav-link" href="#activity"><span>◷</span>activity</a>\n' +
    '        <a class="nav-link" href="#team"><span>♧</span>team</a>\n' +
    '      </nav>\n' +
    '      <div class="sidebar-bottom">\n' +
    '        <a class="nav-link" href="#settings"><span>⚙</span>settings</a>\n' +
    '        <div class="user-card"><span class="avatar">km</span><span><strong>kai monroe</strong><small>operations lead</small></span><span class="more">•••</span></div>\n' +
    '      </div>\n' +
    '    </aside>\n' +
    '    <main class="main-content" id="overview">\n' +
    '      <header class="topbar"><button class="mobile-menu" aria-label="toggle navigation">☰</button><div class="breadcrumbs">operations <span>/</span> overview</div><div class="top-actions"><span class="sync-dot"></span><span class="sync-text">all systems operational</span><button class="icon-button" aria-label="notifications">♢<i></i></button><button class="help-button">?</button></div></header>\n' +
    '      <section class="page-heading"><div><p class="eyebrow">monday, 14 october 2024</p><h1>good morning, kai <span>✦</span></h1><p class="subheading">here’s the latest across your local operations.</p></div><button class="primary-button" id="newrecord">＋ new record</button></section>\n' +
    '      <section class="metrics" aria-label="key metrics">\n' +
    '        <article class="metric-card"><div class="metric-label">open records <span class="metric-icon blue">◌</span></div><div class="metric-value">08</div><div class="metric-trend up">↑ 12.5% <small>vs last week</small></div></article>\n' +
    '        <article class="metric-card"><div class="metric-label">in progress <span class="metric-icon amber">◒</span></div><div class="metric-value">03</div><div class="metric-trend neutral">— <small>same as last week</small></div></article>\n' +
    '        <article class="metric-card"><div class="metric-label">completed <span class="metric-icon green">✓</span></div><div class="metric-value">24</div><div class="metric-trend up">↑ 8.3% <small>vs last week</small></div></article>\n' +
    '        <article class="metric-card"><div class="metric-label">avg. resolution <span class="metric-icon violet">◷</span></div><div class="metric-value">2.4<span class="unit">d</span></div><div class="metric-trend up">↓ 0.6d <small>vs last week</small></div></article>\n' +
    '      </section>\n' +
    '      <section class="records-panel" id="records">\n' +
    '        <div class="panel-heading"><div><h2>operations records</h2><p>track and manage local work across your team.</p></div><button class="secondary-button" id="exportbtn">⇩ export</button></div>\n' +
    '        <div class="toolbar"><label class="search"><span>⌕</span><input id="searchinput" type="search" placeholder="search records..." aria-label="search records"></label><div class="filters"><select id="statusfilter" aria-label="filter by status"><option value="all">all statuses</option><option value="in-progress">in progress</option><option value="blocked">blocked</option><option value="complete">complete</option></select><select id="priorityfilter" aria-label="filter by priority"><option value="all">all priorities</option><option value="high">high priority</option><option value="medium">medium priority</option><option value="low">low priority</option></select></div></div>\n' +
    '        <div class="table-wrap"><table><thead><tr><th>record <span>↕</span></th><th>owner</th><th>status</th><th>priority</th><th>updated <span>↕</span></th><th><span class="sr-only">actions</span></th></tr></thead><tbody id="recordsbody"></tbody></table><div class="empty-state" id="emptystate" hidden><div class="empty-icon">⌕</div><h3>no records found</h3><p>try changing your search or filters.</p><button class="secondary-button" id="clearfilters">clear filters</button></div></div>\n' +
    '        <div class="table-footer"><span id="recordcount">showing 8 of 8 records</span><div class="pagination"><button disabled aria-label="previous page">‹</button><button class="current">1</button><button disabled aria-label="next page">›</button></div></div>\n' +
    '      </section>\n' +
    '      <footer><span>fieldnote operations</span><span>local workspace · last synced just now</span></footer>\n' +
    '    </main>\n' +
    '    <aside class="details-panel" id="detailspanel" aria-label="record details"><button class="close-details" id="closedetails" aria-label="close details">×</button><div id="detailscontent"></div></aside>\n' +
    '  </div>\n' +
    '  <script src="app.js"></script>\n' +
    '</body>\n' +
    '</html>\n' +
    '\n' +
    ':root{--ink:#17212b;--muted:#74808c;--line:#e5e9ed;--paper:#fff;--wash:#f6f8fa;--blue:#3d6df2;--navy:#1d2a3a;--green:#258b68;--amber:#b7791f;--red:#c0524f;--purple:#7657c8}*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:14px/1.45 inter,ui-sans-serif,system-ui,-apple-system,blinkmacsystemfont,"segoe ui",sans-serif}.app-shell{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}.sidebar{background:#202d3d;color:#c8d1dc;padding:28px 16px 18px;display:flex;flex-direction:column}.brand{color:#fff;font-size:18px;font-weight:700;letter-spacing:-.5px;display:flex;align-items:center;gap:9px;padding:0 12px 44px}.brand-mark{background:#5d7df1;color:white;border-radius:7px;font-size:11px;padding:6px 5px;letter-spacing:0}.brand-dot{color:#7b9aff}.workspace-label,.eyebrow,.metric-label,th{font-size:10px;font-weight:700;letter-spacing:.1em}.workspace-label{color:#8291a2;padding:0 12px 8px}.workspace-switcher{background:#2c3b4e;border:1px solid #3a4b60;border-radius:7px;color:#eef2f8;padding:10px 11px;display:flex;gap:9px;align-items:center;font-size:12px}.workspace-icon{color:#90abff}.chevron{margin-left:auto;color:#9ba8b7}nav{margin-top:26px}.nav-link{color:#aebac8;text-decoration:none;padding:11px 12px;border-radius:6px;display:flex;align-items:center;gap:12px;margin:3px 0}.nav-link span{width:16px;text-align:center;color:#9baabd;font-size:16px}.nav-link b{margin-left:auto;background:#394b60;color:#d5deea;border-radius:10px;padding:1px 7px;font-size:10px}.nav-link.active,.nav-link:hover{background:#304259;color:white}.nav-link.active span{color:#89a2ff}.sidebar-bottom{margin-top:auto}.user-card{border-top:1px solid #344456;padding:18px 8px 0;display:flex;align-items:center;gap:9px;font-size:11px}.avatar{background:#dfb69c;color:#53372d;border-radius:50%;display:grid;place-items:center;width:30px;height:30px;font-size:10px;font-weight:700}.user-card strong,.user-card small{display:block}.user-card strong{font-size:11px;color:#f1f4f8}.user-card small{color:#8998a9;font-size:10px}.more{margin-left:auto;color:#8190a2}.main-content{min-width:0;padding:0 42px 28px}.topbar{height:76px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}.breadcrumbs{font-size:12px;color:#8a95a0}.breadcrumbs span{padding:0 8px;color:#c0c6cc}.top-actions{display:flex;gap:10px;align-items:center;font-size:12px}.sync-dot{width:7px;height:7px;border-radius:50%;background:#43b887}.sync-text{color:#64736e}.icon-button,.help-button,.mobile-menu{border:0;background:transparent;color:#71808b;position:relative;font-size:21px}.icon-button i{position:absolute;width:5px;height:5px;border-radius:50%;background:#e07868;top:0;right:2px}.help-button{border:1px solid #cbd3d9;border-radius:50%;font-size:12px;width:19px;height:19px}.mobile-menu{display:none}.page-heading{display:flex;justify-content:space-between;align-items:end;padding:37px 0 27px}.eyebrow{color:#89949f;margin:0 0 8px}.page-heading h1{font-size:27px;letter-spacing:-.04em;margin:0 0 5px}.page-heading h1 span{color:#eead4a;font-size:20px}.subheading{margin:0;color:#77838e}.primary-button,.secondary-button{border-radius:6px;padding:10px 14px;font-weight:650;cursor:pointer}.primary-button{background:var(--blue);border:1px solid var(--blue);color:white}.secondary-button{background:white;border:1px solid #d9e0e6;color:#44515d}.primary-button:hover{background:#2e5de4}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.metric-card,.records-panel{background:var(--paper);border:1px solid var(--line);border-radius:8px}.metric-card{padding:18px 19px}.metric-label{color:#89949f;display:flex;justify-content:space-between;align-items:center}.metric-icon{font-size:17px}.blue{color:#5777e9}.amber{color:#dc9b42}.green{color:#39a37e}.violet{color:#9175df}.metric-value{font-size:29px;font-weight:700;letter-spacing:-.05em;margin:11px 0 6px}.unit{font-size:17px;margin-left:2px;color:#596672}.metric-trend{font-size:11px}.metric-trend small{color:#a0a9b1}.up{color:#29936d}.neutral{color:#9da6ae}.records-panel{margin-top:24px}.panel-heading{padding:21px 22px 17px;display:flex;justify-content:space-between;align-items:center}.panel-heading h2{font-size:16px;margin:0 0 4px}.panel-heading p{color:#87929c;margin:0;font-size:12px}.toolbar{background:#fbfcfd;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px 22px;display:flex;justify-content:space-between;gap:14px}.search{background:white;border:1px solid #dce2e7;border-radius:5px;display:flex;align-items:center;padding:0 10px;width:270px;color:#9aa4ad}.search input{border:0;outline:0;padding:8px;width:100%;font:inherit;color:var(--ink)}.filters{display:flex;gap:8px}.filters select{border:1px solid #dce2e7;border-radius:5px;background:white;padding:8px 26px 8px 10px;color:#5e6973;font:12px inherit}table{border-collapse:collapse'... 9210 more characters,
  expected: /dashboard/,
  operator: 'match',
  diff: 'simple'
}

Node.js v22.21.0.
- Repeat 3, **opencode**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 0; cached input 0; uncached input 0; tools 0; harness result unavailable: ENOENT: no such file or directory, open '/Users/addy/Downloads/cuppet/.benchmarks/cuppet-harness-comparison-g9s0rN/results/repeat-3-long-tool-use-dashboard-opencode.json'.
- Repeat 3, **codex**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 0; cached input 0; uncached input 0; tools 0; codex exited with code 1.

# cuppet-harness-comparison

- Status: **failed**
- Benchmark version: `issue-4.1`
- Repository SHA: `840ed751b61c04afc881a393b7836d4d2c932f61`
- Task set: `issue-4-core@2026-09-05` (12 tasks)
- Manifest SHA-256: `2b2093997c9620c52be3d44674013656f370b8d75bc10ade2642cc6077da6a41`
- Repetitions: 1
- Controller: local/deterministic-node-controller (issue-4.1)

## Headline metrics

| Metric | cuppet |
|---|---:|
| Successful tasks | 11/12 |
| Success rate (95% CI) | 91.7% (64.6%–98.5%) |
| First-attempt success | 91.7% |
| Acceptance checks | 14/15 |
| Model tokens/task (median) | 10,616 |
| Model tokens/successful task | 15,243 |
| Uncached input/task (median) | 8,628 |
| Cached input/task (median) | 317,184 |
| Output tokens/task (median) | 1,608 |
| Tool calls/task (median) | 7 |
| Retries | 0 |
| Compactions | 0 |
| Regressions | 0 |
| Effective cost/task (median) | unavailable |

## Uncertainty

- **cuppet**: model tokens/task 10616 (95% mean CI 8166–19780); successful-task tokens 7926 (95% mean CI 7103–19489); wall time 64864 (95% mean CI 44864–96768).

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
| cuppet | 12 × 1 | 138,867 | 4,168,192 | 97.7% | 13,245 | 6,078 | 95.7% | 98.3% |

Per-task cache share and marginal uncached input remain available in the JSON report under `longHorizon[].tasks`.

## Per-task results

- Repeat 1, **cuppet**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 41015; cached input 272384; uncached input 36385; tools 33.
- Repeat 1, **cuppet**, `quiz-game-greenfield`: success; acceptance 100.0%; model tokens 18111; cached input 291328; uncached input 13245; tools 12.
- Repeat 1, **cuppet**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 13305; cached input 272896; uncached input 9995; tools 8.
- Repeat 1, **cuppet**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 19200; cached input 326144; uncached input 14963; tools 11.
- Repeat 1, **cuppet**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 14852; cached input 397824; uncached input 12220; tools 11.
- Repeat 1, **cuppet**, `switch-a-auth`: success; acceptance 100.0%; model tokens 7926; cached input 313856; uncached input 7261; tools 5.
- Repeat 1, **cuppet**, `switch-a-followup`: success; acceptance 100.0%; model tokens 6003; cached input 264192; uncached input 5447; tools 4.
- Repeat 1, **cuppet**, `switch-b-auth`: success; acceptance 100.0%; model tokens 6433; cached input 347648; uncached input 5713; tools 5.
- Repeat 1, **cuppet**, `switch-b-followup`: success; acceptance 100.0%; model tokens 6699; cached input 290816; uncached input 6095; tools 4.
- Repeat 1, **cuppet**, `switch-c`: success; acceptance 100.0%; model tokens 6857; cached input 382464; uncached input 6078; tools 5.
- Repeat 1, **cuppet**, `switch-a-return`: success; acceptance 100.0%; model tokens 5857; cached input 320512; uncached input 5380; tools 4.
- Repeat 1, **cuppet**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 21418; cached input 688128; uncached input 16085; tools 10; node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: operations-dashboard is missing dashboard
    at verifyWebProject (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:83:50)
    at async <anonymous> (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:7:1) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>fieldwork operations</title><link rel="stylesheet" href="styles.css"></head>\n' +
    '<body>\n' +
    '<div class="layout">\n' +
    '  <aside class="sidebar" aria-label="primary navigation">\n' +
    '    <a class="logo" href="./"><span>f</span> fieldwork</a>\n' +
    '    <nav><a class="nav-link active" href="#overview" aria-current="page">overview</a><a class="nav-link" href="#records">records</a><a class="nav-link" href="#activity">activity</a></nav>\n' +
    '    <div class="sidebar-note"><span class="pulse" aria-hidden="true"></span><p>all systems<br><strong>operational</strong></p></div>\n' +
    '  </aside>\n' +
    '  <main class="main" id="overview">\n' +
    '    <header class="topbar"><div><p class="kicker">monday, october 14, 2024</p><h1>operations overview</h1></div><div class="profile" aria-label="signed in as alex morgan"><span class="avatar">am</span><span class="profile-name">alex morgan</span></div></header>\n' +
    '    <section class="metrics" aria-label="key metrics"><article class="metric"><p>active records</p><strong id="active-metric">0</strong><span class="trend up">+12.5% <small>vs last week</small></span></article><article class="metric"><p>in progress</p><strong id="progress-metric">0</strong><span class="trend neutral">on track <small>this week</small></span></article><article class="metric"><p>high priority</p><strong id="priority-metric">0</strong><span class="trend alert">needs attention</span></article><article class="metric"><p>avg. resolution</p><strong>2.4<span class="unit">d</span></strong><span class="trend up">-8.2% <small>vs last month</small></span></article></section>\n' +
    '    <section class="workspace" id="records" aria-labelledby="records-title">\n' +
    '      <div class="section-head"><div><p class="kicker">live queue</p><h2 id="records-title">operational records</h2></div><span id="result-count" class="result-count" aria-live="polite"></span></div>\n' +
    '      <div class="toolbar"><label class="search-wrap" for="search"><span aria-hidden="true">search</span><input id="search" type="search" placeholder="search records..." autocomplete="off"></label><label class="select-wrap" for="status-filter">status<select id="status-filter"><option value="all">all statuses</option><option value="active">active</option><option value="review">in review</option><option value="blocked">blocked</option><option value="complete">complete</option></select></label><label class="select-wrap" for="priority-filter">priority<select id="priority-filter"><option value="all">all priorities</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option></select></label></div>\n' +
    '      <div class="table-frame"><table><caption class="visually-hidden">operational records</caption><thead><tr><th scope="col">record</th><th scope="col">owner</th><th scope="col">status</th><th scope="col">priority</th><th scope="col">updated</th></tr></thead><tbody id="record-table"></tbody></table><div id="empty-state" class="empty-state" hidden><strong>no records found</strong><p>try adjusting your search or filters.</p><button id="clear-button" type="button">clear filters</button></div></div>\n' +
    '    </section>\n' +
    '    <aside class="details" id="details-panel" aria-labelledby="details-title"><div><p class="kicker">selected record</p><h2 id="details-title">select a record</h2><p id="details-copy">choose a row from the queue to see its operational details.</p></div><dl id="detail-list" hidden></dl></aside>\n' +
    '    <footer id="activity"><span>fieldwork ops / local preview</span><span>last synced just now</span></footer>\n' +
    '  </main>\n' +
    '</div><script src="app.js"></script>\n' +
    '</body></html>\n' +
    '\n' +
    ':root{--ink:#17242b;--muted:#718087;--line:#dde5e4;--paper:#fff;--bg:#f4f7f5;--teal:#087f78;--gold:#c9822e;--red:#c9584e}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--bg);font:14px/1.5 system-ui,-apple-system,sans-serif}.layout{display:flex;min-height:100vh}.sidebar{width:235px;flex:none;padding:30px 22px;display:flex;flex-direction:column;background:#17363b;color:#dcebea}.logo{display:flex;align-items:center;gap:10px;color:white;text-decoration:none;font:700 1.15rem georgia,serif;letter-spacing:.02em}.logo span{display:grid;place-items:center;width:31px;height:31px;border-radius:9px;background:#35a49a;color:#17363b;font:700 1.2rem georgia,serif}.sidebar nav{display:grid;gap:8px;margin-top:68px}.nav-link{padding:11px 13px;border-radius:8px;color:#9eb9b7;text-decoration:none}.nav-link:hover,.nav-link.active{color:white;background:#275056}.nav-link:focus-visible,.logo:focus-visible{outline:3px solid #80d0c7;outline-offset:3px}.sidebar-note{display:flex;gap:10px;align-items:center;margin-top:auto;padding:13px;color:#9eb9b7;border-top:1px solid #31565a;font-size:.78rem}.sidebar-note p{margin:0}.sidebar-note strong{color:white}.pulse{width:8px;height:8px;border-radius:50%;background:#65c68b;box-shadow:0 0 0 4px #65c68b22}.main{width:min(100%,1240px);padding:43px 5vw 28px}.topbar{display:flex;justify-content:space-between;align-items:center}.kicker{margin:0 0 6px;color:var(--teal);font-size:.7rem;font-weight:800;letter-spacing:.15em;text-transform:uppercase}h1,h2{margin:0;font:700 2rem/1.1 georgia,serif;letter-spacing:-.04em}.profile{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:.85rem}.avatar{display:grid;place-items:center;width:35px;height:35px;border-radius:50%;color:#fff;background:var(--teal);font-size:.72rem;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin:38px 0}.metric{padding:19px 20px;border:1px solid var(--line);border-radius:11px;background:var(--paper)}.metric p{margin:0 0 12px;color:var(--muted);font-size:.78rem}.metric strong{display:block;margin-bottom:9px;font:700 2rem/1 georgia,serif}.unit{font-size:1rem;color:var(--muted)}.trend{font-size:.72rem;font-weight:750}.trend small{color:var(--muted);font-weight:400}.up{color:var(--teal)}.neutral{color:var(--gold)}.alert{color:var(--red)}.workspace,.details{border:1px solid var(--line);border-radius:13px;background:var(--paper)}.workspace{padding:25px}.section-head{display:flex;align-items:end;justify-content:space-between}.section-head h2{font-size:1.45rem}.result-count{color:var(--muted);font-size:.8rem}.toolbar{display:flex;gap:12px;margin:24px 0 15px}.search-wrap{position:relative;flex:1}.search-wrap>span{position:absolute;left:14px;top:11px;color:var(--muted);font-size:.78rem}.search-wrap input{padding-left:65px}.select-wrap{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.8rem}.search-wrap input,.select-wrap select{height:39px;border:1px solid var(--line);border-radius:7px;color:var(--ink);background:#fff;font:inherit}.search-wrap input{width:100%;padding-right:12px}.select-wrap select{padding:0 28px 0 10px}.search-wrap input:focus-visible,.select-wrap select:focus-visible,.button:focus-visible{outline:3px solid #9ddbd4;outline-offset:2px}.table-frame{overflow-x:auto}.table-frame table{width:100%;border-collapse:collapse;min-width:650px}th{padding:10px 12px;color:var(--muted);font-size:.68rem;font-weight:700;letter-spacing:.08em;text-align:left;text-transform:uppercase;background:#fafcfb}td{padding:15px 12px;border-top:1px solid var(--line);white-space:nowrap}tbody tr{cursor:pointer}tbody tr:hover,tbody tr.selected{background:#f0f8f6}tbody tr:focus{outline:2px solid var(--teal);outline-offset:-2px}.record-name{font-weight:700}.record-id{display:block;color:var(--muted);font-size:.73rem}.owner{display:flex;align-items:center;gap:8px}.owner-dot{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;color:var(--teal);background:#dcefeb;font-size:.6rem;font-weight:800}.badge{display:inline-block;padding:4px 8px;border-radius:99px;font-size:.7rem;font-weight:750}.status-active{color:#087f78;background:#dff3ee}.status-review{color:#90611c;background:#fbedd3}.status-blocked{color:#a2423a;background:#fbe3df}.status-complete{color:#62717a;background:#e8edef}.priority-high{color:#b14d43}.priority-medium{color:#a16b1e}.priority-low{color:#687980}.details{display:flex;justify-content:space-between;gap:30px;margin-top:18px;padding:22px 25px}.details h2{font-size:1.2rem;margin-bottom:7px}.details p:not(.kicker){margin:0;color:var(--muted)}dl{display:grid;grid-template-columns:repeat(2,125px);gap:8px 20px;margin:0}dt{color:var(--muted);font-size:.7rem}dd{margin:0;font-weight:700}footer{display:flex;justify-content:space-between;padding:30px 2px 0;color:var(--muted);font-size:.72rem}.empty-state{padding:48px;text-align:center;color:var(--muted)}.empty-state strong{display:block;color:var(--ink);font:700 1.2rem georgia,serif}.empty-state p{margin:7px 0 16px}.button{padding:8px 14px;border:1px solid var(--line);border-radius:6px;color:var(--teal);background:white;cursor:pointer;font:inherit;font-weight:700}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:850px){.sidebar{width:190px}.main{padding:30px 24px}.metrics{grid-template-columns:repeat(2,1fr)}}@media(max-width:600px){.layout{display:block}.sidebar{width:100%;padding:16px 18px}.sidebar nav{display:flex;gap:4px;margin:18px 0 0}.nav-link{padding:7px 10px}.sidebar-note{display:none}.main{padding:28px 12px}.topbar{align-items:start}.profile-name{display:none}.metrics{gap:8px;margin:28px 0}.metric{padding:14px}.metric strong{font-size:1.55rem}.toolbar{display:grid;grid-template-columns:1fr 1fr}.search-wrap{grid-column:1/-1}.select-wrap{display:grid;gap:4px}.details{display:block}.details dl{margin-top:18px}footer{display:block}footer span{display:block;margin-top:5px}}\n' +
    '\n' +
    'const records = [\n' +
    "  { id:'ops-1048', name:'warehouse inventory audit', owner:'mk', status:'active', priority:'high', updated:'12 min ago', detail:'cycle count and discrepancy review for the north warehouse.', due:'oct 16', team:'logistics' },\n" +
    "  { id:'ops-1047', name:'vendor access review', own"... 4491 more characters,
  expected: /dashboard/,
  operator: 'match',
  diff: 'simple'
}

Node.js v22.21.0.

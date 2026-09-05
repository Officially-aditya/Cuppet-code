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
| Model tokens/task (median) | 13,665 | 9,802 | 26,258 |
| Model tokens/successful task | 21,370 | 21,421 | 32,151 |
| Uncached input/task (median) | 12,134 | 8,499 | 21,965 |
| Cached input/task (median) | 185,600 | 174,336 | 151,808 |
| Output tokens/task (median) | 949 | 1,269 | 1,988 |
| Tool calls/task (median) | 7 | 7 | 6 |
| Retries | 0 | 0 | 0 |
| Compactions | 0 | 0 | 0 |
| Regressions | 0 | 0 | 0 |
| Effective cost/task (median) | unavailable | unavailable | unavailable |

## Uncertainty

- **cuppet**: model tokens/task 13665 (95% mean CI 14423–23569); successful-task tokens 11998 (95% mean CI 12700–22248); wall time 50704 (95% mean CI 57453–95318).
- **opencode**: model tokens/task 9802 (95% mean CI 13174–26097); successful-task tokens 4822 (95% mean CI 10638–22411); wall time 59216 (95% mean CI 61640–115378).
- **codex**: model tokens/task 26258 (95% mean CI 24299–32859); successful-task tokens 25935 (95% mean CI 24519–33264); wall time 79296 (95% mean CI 81449–120495).

## Parity and controller notes

- **cuppet**: Cuppet derivative OpenCode 1.18.4; runtime version captured by arm result; config SHA-256 `6aac7f4a5512346b6555790cd3a30aeac5662919aefe5ce233fef25c1c2d4dfc`.
- **opencode**: OpenCode 1.18.4 kernel; runtime version captured by arm result; config SHA-256 `3f8f6d149fd6434f482cf7bd7e1bb273966ede3d26247659f382c417b1ef275f`.
- **codex**: Codex native exec CLI; version captured by arm result; config SHA-256 `6bc2b3c40846f07c4e1660ef8811682fcdfdfef6d2f7743e7a24273ec15852d8`.
- The controller freezes the repository SHA, task prompts, model settings, harness metadata, environment allowlist, and verifier commands before the first arm runs.
- The controller only runs deterministic verification commands; it does not rewrite prompts, coach harnesses, or make subjective correctness judgments.
- Failed tasks retain all telemetry emitted before failure. A null cost means the harness did not expose provider-adjusted pricing.
- Persistent Cuppet/OpenCode sequences reuse one native session; Codex and Claude Code persistent-family entries currently run sequential native CLI turns because their resume/session telemetry is not yet reliable enough to claim a single persistent session.
- Resume completed without rerunning Task 11; only the missing repeat-3 long-tool-use Opencode arm was executed.

## Per-task results

- Repeat 1, **opencode**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 47905; cached input 269312; uncached input 43163; tools 33.
- Repeat 1, **codex**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 39452; cached input 317696; uncached input 34351; tools 11.
- Repeat 1, **cuppet**, `task-tracker-cross-file`: failed; acceptance 75.0%; model tokens 21612; cached input 22528; uncached input 20649; tools 16; node:internal/modules/run_main:123.
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
- Repeat 1, **cuppet**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 29818; cached input 42496; uncached input 23181; tools 7; node:internal/modules/run_main:123.
- Repeat 1, **opencode**, `long-tool-use-dashboard`: success; acceptance 100.0%; model tokens 65925; cached input 353792; uncached input 54516; tools 22.
- Repeat 1, **codex**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 42040; cached input 337664; uncached input 33671; tools 10; node:internal/modules/run_main:123.
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
- Repeat 2, **opencode**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 67039; cached input 260096; uncached input 58571; tools 22; node:internal/modules/run_main:123.
- Repeat 2, **codex**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 36465; cached input 212992; uncached input 27665; tools 6; node:internal/modules/run_main:123.
- Repeat 2, **cuppet**, `long-tool-use-dashboard`: success; acceptance 100.0%; model tokens 52979; cached input 133632; uncached input 41630; tools 14.
- Repeat 3, **opencode**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 39590; cached input 349696; uncached input 34865; tools 35.
- Repeat 3, **codex**, `task-tracker-cross-file`: failed; acceptance 75.0%; model tokens 25796; cached input 371712; uncached input 21539; tools 8; /Users/addy/Downloads/cuppet/.benchmarks/cuppet-harness-comparison-g9s0rN/workspaces/repeat-3-task-tracker-cross-file-codex/games/task-tracker/src/core/taskFactory.ts:6.
- Repeat 3, **cuppet**, `task-tracker-cross-file`: success; acceptance 100.0%; model tokens 40250; cached input 260096; uncached input 35395; tools 32.
- Repeat 3, **cuppet**, `quiz-game-greenfield`: failed; acceptance 0.0%; model tokens 27837; cached input 105472; uncached input 23031; tools 13; node:internal/modules/run_main:123.
- Repeat 3, **opencode**, `quiz-game-greenfield`: failed; acceptance 0.0%; model tokens 41138; cached input 130048; uncached input 35361; tools 16; node:internal/modules/run_main:123.
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
- Repeat 3, **cuppet**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 45406; cached input 95232; uncached input 38548; tools 11; node:internal/modules/run_main:123.
- Repeat 3, **opencode**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 53398; cached input 183296; uncached input 44478; tools 17; node:internal/modules/run_main:123.
- Repeat 3, **codex**, `long-tool-use-dashboard`: failed; acceptance 0.0%; model tokens 0; cached input 0; uncached input 0; tools 0; codex exited with code 1.

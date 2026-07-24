# Task Tracker graph-only file-navigation experiment

- Created: 2026-07-23T10:54:01.604Z
- Model: `openai/gpt-5.6-luna@low`
- Repeats per arm: 5
- Two fresh-workspace arms used the same fixture, model, tools, existing bounded `CUPPET_CONTEXT`, hidden evaluator, and official OpenCode kernel.
- External-directory discovery was allowed for every arm with `CUPPET_TTT_ALLOW_EXTERNAL=1`.
- Configured OpenCode provider credentials/database and cached model catalog were copied into each disposable runtime; those copies are removed after evaluation.
- The graph-only arm ran a mandatory model graph preflight, then used a fresh task session where glob, grep, and LSP were disabled; read/edit/write remained available. Bash was permitted only for the three required validation commands. Any blocked file-search or unapproved bash requests are reported explicitly.

## Arms

- **current**: current Cuppet instruction plus the existing bounded TST context.
- **graph-only**: graph navigation plus read/edit/write access, with ordinary file-search tools disabled and the identical existing bounded TST context.

## Results

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | Instruction applied | Preflight passed | Gate denials | Unexpected rejects | Blocked file search | Graph guidance messages | Blocked bash | First tool graph | Graph before workspace | Mean graph calls | First graph | First workspace |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 5/5 | 100.0% | 100.0% | 100.0% | 84562 ms | 84562 ms | $0.000000 | 47384 | 1234 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 2.0 | 8655 ms | 4350 ms |
| graph-only | 5/5 | 100.0% | 100.0% | 100.0% | 88528 ms | 88528 ms | $0.000000 | 39290 | 1234 | 100.0% | 100.0% | 0 | 0 | 0 | 6 | 6 | 100.0% | 100.0% | 7.4 | 2220 ms | 6865 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-only vs current | 0.0% | 0.0% | -4.7% | 0.0% | 17.1% | 0.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 78978 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 1; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 8104 ms; first workspace 4350 ms.
- Repeat 1, **graph-only**: success; acceptance 100.0%; latency 85617 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 6; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 1998 ms; first workspace 6340 ms.
- Repeat 2, **graph-only**: success; acceptance 100.0%; latency 80979 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 6; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 2; blocked bash 2; first graph 2514 ms; first workspace 6865 ms.
- Repeat 2, **current**: success; acceptance 100.0%; latency 86414 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 1; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 25497 ms; first workspace 4071 ms.
- Repeat 3, **current**: success; acceptance 100.0%; latency 94655 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 2; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 9361 ms; first workspace 5694 ms.
- Repeat 3, **graph-only**: success; acceptance 100.0%; latency 97810 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 9; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 1; blocked bash 1; first graph 1954 ms; first workspace 6262 ms.
- Repeat 4, **current**: success; acceptance 100.0%; latency 82708 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 4; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 8655 ms; first workspace 4609 ms.
- Repeat 4, **graph-only**: success; acceptance 100.0%; latency 116129 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 7; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 2; blocked bash 2; first graph 2220 ms; first workspace 6917 ms.
- Repeat 5, **graph-only**: success; acceptance 100.0%; latency 88528 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 9; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 1; blocked bash 1; first graph 3799 ms; first workspace 8069 ms.
- Repeat 5, **current**: success; acceptance 100.0%; latency 84562 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 2; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 8023 ms; first workspace 4332 ms.

## Interpretation note

This five-pair run used the explicit graph-tool proxy treatment. All five
graph-only trials selected `cuppet_graph_search` as their first tool, made no
ordinary glob/grep/LSP calls, and completed the hidden evaluator. The graph-only
arm received six Bash guidance messages across the five trials; all were
non-validation shell-discovery attempts. The current arm also used graph traces
in some trials, but continued to use ordinary glob/grep discovery.

The treatment matched current Cuppet on accuracy in this fixture: 5/5 versus
5/5, with 100% acceptance and 100% hop-2 coverage in both arms. It used 17.1%
fewer total model tokens and 18.9% fewer uncached input tokens, but was 4.7%
slower on successful trials. OpenCode reported `$0` for both arms, so provider
cost remains unavailable. This is the first repeat set showing both reliable
graph-tool selection and no accuracy loss; broader tasks are still needed to
establish whether the efficiency difference generalizes.

Interpretation must remain task-specific. This tests whether the graph can supply enough file navigation when ordinary file search is unavailable; it is a constrained graph-assisted workflow, not a pure prompt-wording comparison. 5 repeats per arm provide directional evidence, not a product-wide statistical claim.

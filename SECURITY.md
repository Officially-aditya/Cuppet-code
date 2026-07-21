# Security policy

## Supported versions

Only the newest Cuppet public-alpha release receives security fixes.

## Reporting

Do not open a public issue for a suspected vulnerability. Send a private
report to the project maintainers with reproduction steps, affected version,
and impact. Avoid including real provider keys, OAuth tokens, or private code.

## Security boundaries

Cuppet does not read or migrate `~/.cuppet/credentials.json`,
`~/.cuppet/ltm-trie.json`, or `~/.claude.json`. OpenCode exclusively owns
provider credentials beneath Cuppet's isolated XDG directories. Telemetry is
disabled. Permission prompts default to deny in non-interactive operation.

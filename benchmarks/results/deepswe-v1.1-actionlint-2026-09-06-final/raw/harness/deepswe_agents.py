from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

from pier.agents.installed.base import BaseInstalledAgent, NonZeroAgentExitCodeError, with_prompt_template
from pier.agents.installed.opencode import OpenCode
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist


MODEL = "openai/gpt-5.6-luna"
REASONING = "low"
AUTH_HOST_PATH = Path(os.environ.get("DEEPSWE_AUTH_HOST_PATH", "/Users/addy/.local/share/opencode/auth.json"))
PREFERENCES_HOST_PATH = Path(os.environ.get("DEEPSWE_CUPPET_PREFS_HOST_PATH", "/private/tmp/deepswe-cuppet-preferences.json"))
BUNDLE_HOST_PATH = Path(os.environ.get("DEEPSWE_CUPPET_BUNDLE_HOST_PATH", "/private/tmp/deepswe-cuppet-bundle"))


def _require_parity(model_name: str | None, effort: str | None) -> None:
    if model_name != MODEL:
        raise ValueError(f"model resolution preflight mismatch: expected {MODEL}, received {model_name!r}")
    if effort not in (None, REASONING):
        raise ValueError(f"reasoning preflight mismatch: expected {REASONING}, received {effort!r}")
    if not AUTH_HOST_PATH.is_file():
        raise FileNotFoundError(f"OpenCode auth file is missing: {AUTH_HOST_PATH}")


class StockOpenCodeAuth(OpenCode):
    """Stock Pier OpenCode with only the host's existing auth state uploaded."""

    def __init__(self, *args, reasoning_effort: str | None = None, **kwargs):
        self._reasoning_effort = reasoning_effort
        super().__init__(*args, **kwargs)
        _require_parity(self.model_name, reasoning_effort)

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        await environment.exec(command="mkdir -p /root/.local/share/opencode", user="root")
        await environment.upload_file(AUTH_HOST_PATH, "/root/.local/share/opencode/auth.json")
        await environment.exec(command="chmod 600 /root/.local/share/opencode/auth.json", user="root")

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        provider, _ = self.model_name.split("/", 1)
        env = self.build_process_env()
        if provider == "openai":
            for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL"):
                if value := self._get_env(key):
                    env[key] = value
        env["OPENCODE_FAKE_VCS"] = "git"

        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command, env=env)
        config_command = self._build_register_config_command()
        if config_command:
            await self.exec_as_agent(environment, command=config_command, env=env)

        escaped_instruction = shlex.quote(instruction)
        cli_flags = self.build_cli_flags()
        cli_flags_arg = (cli_flags + " ") if cli_flags else ""
        command = (
            "touch /logs/agent/opencode.txt; "
            ". ~/.nvm/nvm.sh; "
            f"opencode --model={self.model_name} run --format=json {cli_flags_arg}"
            f"--thinking --dangerously-skip-permissions -- {escaped_instruction} "
            "> /logs/agent/opencode.txt 2>&1 & "
            "pid=$!; stopped=0; deadline=$(($(date +%s) + 10800)); "
            "while kill -0 \"$pid\" 2>/dev/null; do "
            "if tail -n 20 /logs/agent/opencode.txt 2>/dev/null | "
            "grep -q '\"type\":\"step_finish\"' && "
            "tail -n 20 /logs/agent/opencode.txt 2>/dev/null | "
            "grep -q '\"reason\":\"stop\"'; then "
            "stopped=1; kill -TERM \"$pid\" 2>/dev/null || true; break; fi; "
            "if [ $(date +%s) -ge \"$deadline\" ]; then break; fi; "
            "sleep 1; done; "
            "if kill -0 \"$pid\" 2>/dev/null; then "
            "kill -KILL \"$pid\" 2>/dev/null || true; fi; "
            "wait \"$pid\" 2>/dev/null; status=$?; "
            "if [ \"$stopped\" -eq 1 ]; then exit 0; fi; exit \"$status\""
        )
        await self.exec_as_agent(environment, command=command, env=env, timeout_sec=10800)
        if messages := self._error_messages():
            raise NonZeroAgentExitCodeError("OpenCode emitted error event(s): " + "; ".join(messages[:3]))

    def network_allowlist(self) -> NetworkAllowlist:
        # OpenAI OAuth-backed requests may route through chatgpt.com before
        # reaching api.openai.com; both are required for the official proxy.
        return NetworkAllowlist(domains=["api.openai.com", ".chatgpt.com", "auth.openai.com"])


class Cuppet(BaseInstalledAgent):
    """Cuppet headless native controller using the verified Linux runtime bundle."""

    SUPPORTS_ATIF = False

    @staticmethod
    def name() -> str:
        return "cuppet"

    def __init__(self, *args, reasoning_effort: str | None = None, **kwargs):
        self._reasoning_effort = reasoning_effort
        super().__init__(*args, **kwargs)
        _require_parity(self.model_name, reasoning_effort)

    def install_spec(self) -> AgentInstallSpec:
        # The official task image already contains Node and the native task
        # toolchain. The harness payload is uploaded during setup so the base
        # image remains the official DeepSWE image.
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[InstallStep(user="root", run="mkdir -p /opt/cuppet-runtime")],
            verification_command="node /opt/cuppet-runtime/cli.js --version",
            cache_key="cuppet-runtime-bundle-12e34fc-0.2.0-alpha.2",
        )

    def get_version_command(self) -> str | None:
        return "node /opt/cuppet-runtime/cli.js --version"

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(domains=["api.openai.com", ".chatgpt.com", "auth.openai.com"])

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        if not BUNDLE_HOST_PATH.is_dir():
            raise FileNotFoundError(f"Cuppet runtime bundle is missing: {BUNDLE_HOST_PATH}")
        if not PREFERENCES_HOST_PATH.is_file():
            raise FileNotFoundError(f"Cuppet preferences are missing: {PREFERENCES_HOST_PATH}")

        await environment.exec(
            command=(
                "mkdir -p /opt/cuppet-runtime /root/.cuppet/v2/opencode/data/opencode "
                "/root/.cuppet/v2/opencode/config/opencode"
            ),
            user="root",
        )
        await environment.upload_dir(BUNDLE_HOST_PATH, "/opt/cuppet-runtime")
        await environment.upload_file(AUTH_HOST_PATH, "/root/.cuppet/v2/opencode/data/opencode/auth.json")
        await environment.upload_file(PREFERENCES_HOST_PATH, "/root/.cuppet/v2/preferences.json")
        await environment.exec(
            command=(
                "chmod 755 /opt/cuppet-runtime/cli.js /opt/cuppet-runtime/bin/opencode "
                "/opt/cuppet-runtime/bin/tst-daemon; "
                "chmod 600 /root/.cuppet/v2/opencode/data/opencode/auth.json "
                "/root/.cuppet/v2/preferences.json"
            ),
            user="root",
        )
        version = await environment.exec(command="node /opt/cuppet-runtime/cli.js --version")
        if version.return_code != 0 or version.stdout.strip() != "0.2.0-alpha.2":
            raise RuntimeError(f"unexpected Cuppet runtime version: {version.stdout!r} {version.stderr!r}")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        _require_parity(self.model_name, self._reasoning_effort)
        escaped = shlex.quote(instruction)
        command = f"""
set +e
rm -rf /logs/agent/cuppet-opencode-data /logs/agent/cuppet-opencode-log /logs/agent/cuppet-projects
mkdir -p /logs/agent/cuppet-opencode-data /logs/agent/cuppet-opencode-log /logs/agent/cuppet-projects
timeout 10800s node /opt/cuppet-runtime/cli.js --prompt {escaped} > /logs/agent/cuppet.stdout 2> /logs/agent/cuppet.stderr
status=$?
for file in opencode.db opencode.db-wal opencode.db-shm; do
  if [ -f "/root/.cuppet/v2/opencode/data/opencode/$file" ]; then
    cp -a "/root/.cuppet/v2/opencode/data/opencode/$file" "/logs/agent/cuppet-opencode-data/$file"
  fi
done
if [ -d /root/.cuppet/v2/opencode/data/opencode/log ]; then
  cp -a /root/.cuppet/v2/opencode/data/opencode/log/. /logs/agent/cuppet-opencode-log/
fi
if [ -d /root/.cuppet/v2/projects ]; then
  cp -a /root/.cuppet/v2/projects/. /logs/agent/cuppet-projects/
fi
printf '%s\\n' "$status" > /logs/agent/cuppet.exit
exit "$status"
"""
        await self.exec_as_agent(
            environment,
            command=command,
            env={
                "CUPPET_OPENCODE_BIN": "/opt/cuppet-runtime/bin/opencode",
                "CUPPET_TST_BIN": "/opt/cuppet-runtime/bin/tst-daemon",
                "CUPPET_PLUGIN_PATH": "/opt/cuppet-runtime/plugin/index.js",
                "CUPPET_TUI_PLUGIN_PATH": "/opt/cuppet-runtime/plugin/tui.js",
                "CUPPET_PE3_ALLOW_MODEL_DOWNLOAD": "0",
                "CUPPET_HEADLESS_AUTO_APPROVE": "1",
            },
            timeout_sec=10800,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Native Cuppet telemetry is preserved as SQLite/log artifacts under
        # /logs/agent; the benchmark report parses those artifacts separately.
        context.metadata = {
            "telemetry": "logs/agent/cuppet-opencode-data/opencode.db",
            "model": MODEL,
            "reasoning_effort": REASONING,
        }

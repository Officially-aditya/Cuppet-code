// src/control.ts
import { createConnection } from "node:net";
var CuppetControlClient = class {
  #socketPath;
  #token;
  constructor(socketPath = process.env.CUPPET_CONTROL_SOCKET ?? "", token = process.env.CUPPET_CONTROL_TOKEN ?? "") {
    if (!socketPath || !token) throw new Error("Cuppet control API is unavailable");
    this.#socketPath = socketPath;
    this.#token = token;
  }
  async call(method, params = {}) {
    const socket = await connect(this.#socketPath);
    try {
      socket.write(`${JSON.stringify({ token: this.#token, method, params })}
`);
      const response = await readLine(socket);
      if (!response.ok) throw new Error(response.error ?? "Cuppet control request failed");
      return response.result;
    } finally {
      socket.destroy();
    }
  }
};
function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 256 * 1024) {
        cleanup();
        reject(new Error("Cuppet control response exceeds frame limit"));
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(buffer.slice(0, end)));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Cuppet control socket closed"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

// src/tui.ts
function uniqueModelRows(models) {
  const rows = /* @__PURE__ */ new Map();
  for (const model of models) {
    const key = `${model.providerID}\0${model.modelID}`;
    const row2 = rows.get(key) ?? {
      providerID: model.providerID,
      modelID: model.modelID,
      name: model.name.replace(/\s+\[[^\]]+\]$/, ""),
      efforts: []
    };
    if (model.variant && !row2.efforts.includes(model.variant)) row2.efforts.push(model.variant);
    rows.set(key, row2);
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}
function modelSelectionSequence(row2) {
  return row2.efforts.length > 0 ? ["model", "effort"] : ["model"];
}
var CuppetTuiPlugin = {
  id: "cuppet-tui",
  async tui(api) {
    if (!process.env.CUPPET_CONTROL_SOCKET || !process.env.CUPPET_CONTROL_TOKEN) return;
    const client = new CuppetControlClient();
    let lastNavigatedSessionID;
    const syncActiveRoute = async () => {
      try {
        const status = await client.call("status");
        const foreground = status.foreground;
        const session = status.session;
        const currentSessionID = session?.id;
        const isRunning = foreground?.running === true;
        if (currentSessionID) {
          const currentRoute = api.route?.current;
          if (isRunning && currentRoute?.name === "home") {
            lastNavigatedSessionID = currentSessionID;
            api.route?.navigate?.("session", { sessionID: currentSessionID });
          } else if (currentRoute?.name === "home" && currentSessionID !== lastNavigatedSessionID) {
            lastNavigatedSessionID = currentSessionID;
            api.route?.navigate?.("session", { sessionID: currentSessionID });
          }
        }
      } catch {
      }
    };
    const timer = setInterval(syncActiveRoute, 350);
    if (typeof timer.unref === "function") timer.unref();
    const action = async (title, method, params, message) => {
      try {
        const result = await client.call(method, params);
        api.ui.toast({
          title,
          variant: "success",
          message: typeof message === "function" ? message(result) : message
        });
      } catch (error) {
        api.ui.toast({
          title,
          variant: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };
    const dispatch = (name) => () => api.keymap.dispatchCommand(name);
    const sessionID = () => {
      const value = api.route?.current?.params?.sessionID;
      return typeof value === "string" ? value : void 0;
    };
    const prompt = (title, placeholder, onConfirm) => {
      if (!api.ui.dialog || !api.ui.DialogPrompt) {
        api.ui.toast({ title, variant: "warning", message: "This Cuppet dialog is unavailable in the current TUI." });
        return;
      }
      api.ui.dialog.replace(() => api.ui.DialogPrompt({
        title,
        placeholder,
        onConfirm: (value) => {
          api.ui.dialog?.clear();
          onConfirm(value);
        },
        onCancel: () => api.ui.dialog?.clear()
      }));
    };
    const choosePlatform = async () => {
      if (!api.ui.dialog || !api.ui.DialogSelect) {
        api.ui.toast({ title: "Cuppet platform", variant: "warning", message: "The platform dialog is unavailable." });
        return;
      }
      try {
        const state = await client.call("platform.list");
        api.ui.dialog.replace(() => api.ui.DialogSelect({
          title: "Choose Cuppet platform",
          placeholder: "Search platforms",
          current: state.selected,
          options: state.options.map((option) => ({
            title: option.label,
            value: option.value,
            description: option.description,
            footer: `${option.models} models${option.connected ? " \xB7 connected" : ""}`
          })),
          onSelect: (option) => {
            api.ui.dialog?.clear();
            void client.call("platform.select", { platform: option.value }).then(() => {
              api.ui.toast({
                title: "Cuppet platform",
                variant: "success",
                message: `${option.title} selected. Choose the foreground model.`
              });
              api.keymap.dispatchCommand("model.list");
            }).catch((error) => api.ui.toast({
              title: "Cuppet platform",
              variant: "error",
              message: error instanceof Error ? error.message : String(error)
            }));
          }
        }));
      } catch (error) {
        api.ui.toast({
          title: "Cuppet platform",
          variant: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };
    const showStatus = async () => {
      if (!api.ui.dialog || !api.ui.DialogAlert) {
        api.ui.toast({ title: "Cuppet status", variant: "warning", message: "The status dialog is unavailable." });
        return;
      }
      try {
        const status = await client.call("status");
        api.ui.dialog.setSize?.("large");
        api.ui.dialog.replace(() => api.ui.DialogAlert({
          title: "Cuppet status",
          message: formatStatus(status),
          onConfirm: () => api.ui.dialog?.clear()
        }));
      } catch (error) {
        api.ui.toast({
          title: "Cuppet status",
          variant: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };
    const showRemote = async () => {
      try {
        const status = await client.call("remote.start");
        if (!api.ui.dialog || !api.ui.DialogAlert) {
          const invite = record(status.invite);
          const setup = record(status.setup);
          api.ui.toast({
            title: "Cuppet remote control",
            variant: "success",
            message: stringValue(setup.url) ? `Open ${setup.url}` : stringValue(invite.code) ? `Pairing code: ${invite.code}` : "Remote control is running."
          });
          return;
        }
        api.ui.dialog.setSize?.("large");
        api.ui.dialog.replace(() => api.ui.DialogAlert({
          title: "Cuppet remote control",
          message: formatRemoteControl(status),
          onConfirm: () => api.ui.dialog?.clear()
        }));
      } catch (error) {
        api.ui.toast({
          title: "Cuppet remote control",
          variant: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };
    const stopRemote = async () => {
      try {
        await client.call("remote.stop");
        api.ui.toast({ title: "Cuppet remote control", variant: "success", message: "Remote control stopped." });
      } catch (error) {
        api.ui.toast({
          title: "Cuppet remote control",
          variant: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };
    const toggleAutoMode = async () => {
      try {
        const status = await client.call("auto.status");
        const enabled = !status.enabled;
        await client.call("auto.set", {
          enabled,
          ...sessionID() ? { sessionID: sessionID() } : {}
        });
        api.ui.toast({
          title: "Cuppet auto mode",
          variant: "success",
          message: enabled ? "Auto mode ON: workspace reads and edits are approved. Protected files, external paths, and non-safe Bash commands still ask." : "Auto mode OFF: permission requests will ask again."
        });
      } catch (error) {
        api.ui.toast({
          title: "Cuppet auto mode",
          variant: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    };
    const showReport = async (title, method, formatter) => {
      if (!api.ui.dialog || !api.ui.DialogAlert) {
        api.ui.toast({ title, variant: "warning", message: "This report dialog is unavailable." });
        return;
      }
      try {
        const result = await client.call(method);
        api.ui.dialog.setSize?.("large");
        api.ui.dialog.replace(() => api.ui.DialogAlert({
          title,
          message: formatter(result),
          onConfirm: () => api.ui.dialog?.clear()
        }));
      } catch (error) {
        api.ui.toast({ title, variant: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };
    api.keymap.registerLayer({
      commands: [
        {
          // Reuse the host command ID so Cuppet replaces OpenCode's default
          // status action instead of adding a second prefixed command.
          name: "opencode.status",
          title: "Cuppet status",
          desc: "Show Cuppet runtime, foreground, background, and memory status",
          category: "Cuppet",
          namespace: "palette",
          slashName: "status",
          run: showStatus
        },
        {
          name: "cuppet.doctor",
          title: "Cuppet doctor",
          desc: "Diagnose Cuppet runtime, provider, storage, and graph health",
          category: "Cuppet",
          namespace: "palette",
          slashName: "doctor",
          run: () => showReport("Cuppet doctor", "doctor", formatDoctor)
        },
        {
          name: "cuppet.remote",
          title: "Start Cuppet remote control",
          desc: "Start phone/browser pairing for the current Cuppet host",
          category: "Cuppet",
          namespace: "palette",
          slashName: "remote",
          slashAliases: ["remote-control"],
          run: showRemote
        },
        {
          name: "cuppet.remote.stop",
          title: "Stop Cuppet remote control",
          desc: "Disconnect the current phone/browser bridge",
          category: "Cuppet",
          namespace: "palette",
          slashName: "remote-stop",
          run: stopRemote
        },
        {
          name: "cuppet.memory",
          title: "Cuppet memory status",
          desc: "Show Cuppet memory and graph status",
          category: "Cuppet",
          namespace: "palette",
          slashName: "memory",
          run: () => showReport("Cuppet memory", "status", formatMemory)
        },
        {
          name: "cuppet.auto.toggle",
          title: "Toggle Cuppet auto mode",
          desc: "Auto-approve safe in-workspace reads and edits for this session",
          category: "Cuppet",
          namespace: "palette",
          slashName: "auto",
          run: toggleAutoMode
        },
        {
          name: "cuppet.memory.remember",
          title: "Remember a Cuppet preference",
          desc: "Save a project or global key=value preference in memory",
          category: "Cuppet",
          namespace: "palette",
          run: () => prompt("Remember preference", "project key=value", (value) => {
            const match = value.trim().match(/^(?:(project|global)\s+)?([^=\s]+)\s*=\s*(.+)$/i);
            if (!match) {
              api.ui.toast({ title: "Cuppet memory", variant: "warning", message: "Use: project key=value or global key=value" });
              return;
            }
            void action("Cuppet memory", "memory.remember", {
              scope: (match[1] ?? "project").toLowerCase(),
              key: match[2],
              value: match[3]
            }, "Preference remembered.");
          })
        },
        {
          name: "cuppet.memory.forget",
          title: "Forget a Cuppet preference",
          desc: "Remove matching Cuppet memory by key",
          category: "Cuppet",
          namespace: "palette",
          run: () => prompt("Forget preference", "key", (value) => {
            if (!value.trim()) return;
            void action("Cuppet memory", "memory.forget", { key: value.trim() }, removedMessage);
          })
        },
        {
          name: "cuppet.memory.clear",
          title: "Clear Cuppet memory",
          desc: "Clear session, project, or global Cuppet memory",
          category: "Cuppet",
          namespace: "palette",
          run: () => prompt("Clear memory", "session, project, or global", (value) => {
            const scope = value.trim().toLowerCase();
            if (scope !== "session" && scope !== "project" && scope !== "global") {
              api.ui.toast({ title: "Cuppet memory", variant: "warning", message: "Scope must be session, project, or global." });
              return;
            }
            void action("Cuppet memory", "memory.clear", { scope }, removedMessage);
          })
        },
        {
          name: "cuppet.background.toggle",
          title: "Toggle Cuppet background enrichment",
          desc: "Pause or resume background memory enrichment",
          category: "Cuppet",
          namespace: "palette",
          slashName: "background",
          run: async () => {
            const status = await client.call("background.status");
            await client.call("background.set", { paused: !status.paused });
            api.ui.toast({
              title: "Cuppet background",
              variant: "success",
              message: status.paused ? "Background enrichment resumed." : "Background enrichment paused."
            });
          }
        },
        {
          name: "cuppet.background.pause",
          title: "Pause Cuppet background enrichment",
          desc: "Pause background memory enrichment",
          category: "Cuppet",
          namespace: "palette",
          run: () => action("Cuppet background", "background.set", { paused: true }, "Background enrichment paused.")
        },
        {
          name: "cuppet.background.resume",
          title: "Resume Cuppet background enrichment",
          desc: "Resume background memory enrichment",
          category: "Cuppet",
          namespace: "palette",
          run: () => action("Cuppet background", "background.set", { paused: false }, "Background enrichment resumed.")
        },
        {
          name: "cuppet.orchestrator.toggle",
          title: "Toggle Cuppet orchestrator mode",
          desc: "Master/worker delegation: primary curates context and reviews, worker codes",
          category: "Cuppet",
          namespace: "palette",
          slashName: "orchestrator",
          run: async () => {
            try {
              const status = await client.call("orchestrator.status");
              const next = !status.enabled;
              await client.call("orchestrator.set", { enabled: next });
              api.ui.toast({
                title: "Cuppet orchestrator",
                variant: "success",
                message: next ? "Orchestrator mode ON for new turns: you are the master; delegate coding to the worker (task tool), and curate context yourself with cuppet_* tools." : "Orchestrator mode OFF: automatic TST context injection restored."
              });
            } catch (error) {
              api.ui.toast({
                title: "Cuppet orchestrator",
                variant: "error",
                message: error instanceof Error ? error.message : String(error)
              });
            }
          }
        },
        {
          name: "cuppet.platform",
          title: "Choose Cuppet platform",
          desc: "Choose Anthropic, OpenAI, Google, OpenCode, or Vertex AI",
          category: "Cuppet",
          namespace: "palette",
          slashName: "platform",
          slashAliases: ["login"],
          run: choosePlatform
        },
        {
          name: "cuppet.model",
          title: "Select Cuppet model",
          desc: "Open the native model selection dialog",
          category: "Cuppet",
          namespace: "palette",
          slashName: "model",
          run: dispatch("model.list")
        },
        {
          name: "cuppet.effort",
          title: "Select model effort",
          desc: "Open the native model effort/variant dialog",
          category: "Cuppet",
          namespace: "palette",
          slashName: "effort",
          run: dispatch("variant.list")
        },
        {
          name: "cuppet.steer",
          title: "Steer at the next safe boundary",
          desc: "Queue an instruction for the active foreground session",
          category: "Cuppet",
          namespace: "palette",
          slashName: "steer",
          run: () => prompt("Steer session", "instruction", (value) => {
            if (!value.trim()) return;
            void action("Cuppet steer", "session.steer", { instruction: value.trim(), interrupt: false }, "Steering instruction queued.");
          })
        },
        {
          name: "cuppet.steer.interrupt",
          title: "Interrupt and steer immediately",
          desc: "Interrupt the active foreground session and submit an instruction",
          category: "Cuppet",
          namespace: "palette",
          run: () => prompt("Interrupt and steer", "instruction", (value) => {
            if (!value.trim()) return;
            void action("Cuppet steer", "session.steer", { instruction: value.trim(), interrupt: true }, "Session interrupted; steering instruction submitted.");
          })
        },
        {
          name: "cuppet.abort",
          title: "Abort active Cuppet session",
          desc: "Abort the active foreground turn",
          category: "Cuppet",
          namespace: "palette",
          slashName: "abort",
          run: async () => {
            const active = sessionID();
            if (!active || !api.client?.session?.abort) {
              api.ui.toast({ title: "Cuppet abort", variant: "warning", message: "No active session." });
              return;
            }
            await api.client.session.abort({ sessionID: active });
            api.ui.toast({ title: "Cuppet abort", variant: "success", message: "Active session aborted." });
          }
        },
        {
          name: "cuppet.plan",
          title: "Switch native plan mode",
          desc: "Switch directly between the native plan and build agents",
          category: "Cuppet",
          namespace: "palette",
          slashName: "plan",
          run: async () => {
            if (!api.agent?.current || !api.agent.set) {
              api.ui.toast({
                title: "Cuppet plan mode",
                variant: "warning",
                message: "Native agent controls are unavailable in this TUI."
              });
              return;
            }
            try {
              const value = await api.agent.current();
              const current = typeof value === "string" ? value : value.id ?? value.name ?? "";
              const target = nextPlanAgent(current);
              await api.agent.set(target);
              await client.call("plan.set", {
                agent: target,
                ...sessionID() ? { sessionID: sessionID() } : {}
              });
              api.ui.toast({
                title: "Cuppet plan mode",
                variant: "success",
                message: target === "plan" ? "Plan mode enabled." : "Plan mode disabled."
              });
            } catch (error) {
              api.ui.toast({
                title: "Cuppet plan mode",
                variant: "error",
                message: error instanceof Error ? error.message : String(error)
              });
            }
          }
        },
        {
          name: "cuppet.plan.agent",
          title: "Choose Cuppet plan agent",
          desc: "Open the native agent picker for plan mode",
          category: "Cuppet",
          namespace: "palette",
          run: dispatch("agent.list")
        },
        {
          name: "session.compact",
          title: "Compact Cuppet conversation and memory",
          desc: "Compact the active conversation, eligible memory, snapshots, and WAL",
          category: "Cuppet",
          namespace: "palette",
          slashName: "compact",
          run: () => action("Cuppet compact", "session.compact", {}, "Conversation and memory compacted.")
        },
        {
          name: "session.undo",
          title: "Undo the latest Cuppet change boundary",
          desc: "Revert the latest OpenCode change boundary",
          category: "Cuppet",
          namespace: "palette",
          slashName: "undo",
          run: () => action("Cuppet undo", "session.undo", {}, "Latest Cuppet change boundary undone.")
        }
      ]
    });
  }
};
var tui_default = CuppetTuiPlugin;
function formatStatus(value) {
  const status = record(value);
  const session = record(status.session);
  const foreground = record(status.foreground);
  const foregroundUsage = record(foreground.usage);
  const approval = record(status.approval);
  const background = record(status.background);
  const tst = record(status.tst);
  const project = record(tst.project);
  const global = record(tst.global);
  const graph = record(tst.graph);
  const progress = record(graph.progress);
  const platform = platformName(stringValue(status.platform) ?? "not selected");
  const sessionTitle = stringValue(session.title);
  const running = booleanValue(foreground.running) ? "running" : "idle";
  const steps = numberValue(foreground.steps);
  const foregroundCost = numberValue(foreground.cost);
  const backgroundCost = numberValue(background.cost);
  const warnings = Array.isArray(tst.recovery_warnings) ? tst.recovery_warnings.length : 0;
  const tstHealth = stringValue(tst.mode) === "degraded" ? `degraded \xB7 ${stringValue(tst.reason) ?? "daemon unavailable"}` : warnings > 0 ? `${warnings} recovery warning${warnings === 1 ? "" : "s"}` : "healthy";
  const graphState = booleanValue(progress.complete) ? "ready" : "indexing";
  return [
    row("Platform", platform),
    ...sessionTitle ? [row("Session", sessionTitle)] : [],
    row("Primary", modelSummary(status.primary)),
    row("Secondary", modelSummary(status.secondary)),
    row("Approvals", booleanValue(approval.auto) ? "auto \xB7 guarded workspace mode" : "ask"),
    row("Orchestrator", booleanValue(record(status.orchestrator).enabled) ? "master/worker" : "off"),
    row("State", `${running}${steps === void 0 ? "" : ` \xB7 ${steps} step${steps === 1 ? "" : "s"}`}`),
    row("Usage", usageSummary(foregroundUsage, foregroundCost)),
    row("Background", backgroundSummary(background, backgroundCost)),
    row("TST", tstHealth),
    row("Memory", `${formatCount(numberValue(project.records))} project \xB7 ${formatCount(numberValue(global.records))} global \xB7 ${formatCount(numberValue(tst.stm_entries))} recent`),
    row("Graph", `${graphState} \xB7 ${formatCount(numberValue(graph.files))} files \xB7 ${formatCount(numberValue(graph.symbols))} syms \xB7 ${formatCount(numberValue(graph.edges))} edges`)
  ].join("\n");
}
function formatRemoteControl(value) {
  const status = record(value);
  const setup = record(status.setup);
  const setupUrl = stringValue(setup.url);
  if (booleanValue(status.starting) && setupUrl) {
    const expiresAt2 = numberValue(setup.expiresAt);
    return [
      "Scan or open this link in the signed-in Cuppet app:",
      "",
      ...stringValue(setup.qr) ? [stringValue(setup.qr), ""] : [],
      setupUrl,
      "",
      row("Setup code", stringValue(setup.code) ?? "not available"),
      ...expiresAt2 ? [row("Expires", new Date(expiresAt2).toISOString())] : [],
      row("Status", "waiting for approval")
    ].join("\n");
  }
  if (!booleanValue(status.running)) {
    return stringValue(status.error) ?? "Remote control is stopped.";
  }
  const invite = record(status.invite);
  const expiresAt = numberValue(invite.expiresAt);
  return [
    row("Host", `${stringValue(status.deviceName) ?? "this machine"} \xB7 ${stringValue(status.hostId) ?? "unknown"}`),
    row("Pairing code", stringValue(invite.code) ?? "not available"),
    ...stringValue(invite.url) ? [row("Pairing URL", stringValue(invite.url))] : [],
    ...expiresAt ? [row("Expires", new Date(expiresAt).toISOString())] : [],
    row("Relay", stringValue(invite.url) ? "ready for phone/browser pairing" : "set CUPPET_RELAY_URL to enable the relay")
  ].join("\n");
}
function formatDoctor(value) {
  const doctor = record(value);
  const engine = record(doctor.opencode);
  const providers = Array.isArray(engine.providers) ? engine.providers.map(record) : [];
  const vertex = record(doctor.vertex);
  const tst = record(doctor.tst);
  const graph = record(tst.graph);
  const progress = record(graph.progress);
  const storage = record(doctor.storage);
  const permissions = record(storage.permissions);
  const checks = Object.values(permissions).map(record);
  const connected = providers.filter((provider) => booleanValue(provider.connected)).length;
  const storageReady = checks.filter((check) => booleanValue(check.available)).length;
  const tstUnavailable = tst.available === false || stringValue(tst.mode) === "degraded";
  return [
    row("Runtime", `${stringValue(doctor.runtimeSource) ?? "unknown"} \xB7 ${stringValue(doctor.platform) ?? "unknown"} \xB7 Node ${stringValue(doctor.node) ?? "?"}`),
    row("Engine", booleanValue(engine.available) ? `ready \xB7 ${formatCount(numberValue(engine.models))} models \xB7 ${formatCount(numberValue(engine.providerCatalogSize))} catalog` : "unavailable"),
    row("Providers", `${connected}/${providers.length} connected`),
    row("Vertex AI", booleanValue(vertex.connected) ? `connected \xB7 ${formatCount(numberValue(vertex.primaryCompatibleModels))} coding models` : "not connected"),
    row("TST", tstUnavailable ? `degraded \xB7 ${stringValue(tst.reason) ?? "daemon unavailable"}` : `healthy \xB7 ${stringValue(tst.protocol) ?? "protocol ready"}`),
    row("Graph", `${booleanValue(progress.complete) ? "ready" : "indexing"} \xB7 ${formatCount(numberValue(graph.files))} files \xB7 ${formatCount(numberValue(graph.symbols))} syms`),
    row("Storage", `${storageReady}/${checks.length} checks passed`)
  ].join("\n");
}
function formatMemory(value) {
  const status = record(value);
  const tst = record(status.tst);
  const project = record(tst.project);
  const global = record(tst.global);
  const graph = record(tst.graph);
  const progress = record(graph.progress);
  const warnings = Array.isArray(tst.recovery_warnings) ? tst.recovery_warnings.length : 0;
  const degraded = stringValue(tst.mode) === "degraded";
  return [
    row("TST", degraded ? `degraded \xB7 ${stringValue(tst.reason) ?? "daemon unavailable"}` : warnings ? `${warnings} recovery warnings` : "healthy"),
    row("Project", `${formatCount(numberValue(project.records))} records \xB7 ${formatBytes(numberValue(project.wal_bytes))} WAL`),
    row("Global", `${formatCount(numberValue(global.records))} records \xB7 ${formatBytes(numberValue(global.wal_bytes))} WAL`),
    row("Recent", `${formatCount(numberValue(tst.stm_entries))} entries \xB7 ${formatCount(numberValue(tst.sessions))} sessions`),
    row("Graph", `${booleanValue(progress.complete) ? "ready" : "indexing"} \xB7 ${formatCount(numberValue(graph.files))} files \xB7 ${formatCount(numberValue(graph.symbols))} syms \xB7 ${formatCount(numberValue(graph.edges))} edges`)
  ].join("\n");
}
function removedMessage(value) {
  const removed = typeof value === "number" ? value : numberValue(record(value).removed) ?? 0;
  if (removed === 0) return "No matching memory records found.";
  return `${removed} memory record${removed === 1 ? "" : "s"} removed.`;
}
function planMessage(value) {
  const state = record(value);
  const enabled = state.agent === "plan" ? true : state.agent === "build" ? false : booleanValue(state.enabled);
  return enabled ? "Plan mode enabled." : "Plan mode disabled.";
}
function nextPlanAgent(value) {
  const current = typeof value === "string" ? value : value?.id ?? value?.name ?? "";
  return current === "plan" ? "build" : "plan";
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringValue(value) {
  return typeof value === "string" && value ? value : void 0;
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function booleanValue(value) {
  return value === true;
}
function row(label, value) {
  return `  ${label.padEnd(13)}${shorten(value, 42)}`;
}
function shorten(value, width) {
  return value.length <= width ? value : `${value.slice(0, width - 1)}\u2026`;
}
function platformName(value) {
  return { vertex: "Vertex AI", openai: "OpenAI", anthropic: "Anthropic", google: "Google", opencode: "OpenCode" }[value] ?? value;
}
function providerName(value) {
  return {
    "google-vertex": "Vertex",
    "google-vertex-anthropic": "Vertex",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    opencode: "OpenCode"
  }[value] ?? value;
}
function modelSummary(value) {
  const model = record(value);
  const id = stringValue(model.modelID);
  if (!id) return "not configured";
  const variant = stringValue(model.variant);
  const rawName = stringValue(model.name) ?? id;
  const name = variant ? rawName.replace(/\s+\[[^\]]+\]$/, "") : rawName;
  const provider = stringValue(model.providerID);
  return [name, provider ? providerName(provider) : void 0, variant].filter(Boolean).join(" \xB7 ");
}
function usageSummary(usage, cost) {
  const input = formatCount(numberValue(usage.input));
  const output = formatCount(numberValue(usage.output));
  const reasoning = numberValue(usage.reasoning);
  return `${input} in \xB7 ${output} out${reasoning ? ` \xB7 ${formatCount(reasoning)} reasoning` : ""}${cost === void 0 ? "" : ` \xB7 ${formatMoney(cost)}`}`;
}
function backgroundSummary(background, cost) {
  if (Object.keys(background).length === 0) return "not configured";
  const state = booleanValue(background.paused) ? "paused" : booleanValue(background.running) ? "running" : "ready";
  const queued = numberValue(background.queued) ?? 0;
  const completed = numberValue(background.completed) ?? 0;
  return `${state} \xB7 ${queued} queued \xB7 ${completed} completed${cost === void 0 ? "" : ` \xB7 ${formatMoney(cost)}`}`;
}
function formatCount(value) {
  if (value === void 0) return "0";
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}
function formatMoney(value) {
  return `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}
function formatBytes(value) {
  if (value === void 0 || value === 0) return "0 B";
  if (value >= 1048576) return `${(value / 1048576).toFixed(1).replace(/\.0$/, "")} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${value} B`;
}
export {
  tui_default as default,
  formatDoctor,
  formatMemory,
  formatRemoteControl,
  formatStatus,
  modelSelectionSequence,
  nextPlanAgent,
  planMessage,
  removedMessage,
  uniqueModelRows
};
//# sourceMappingURL=tui.js.map
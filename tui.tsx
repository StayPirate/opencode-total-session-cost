import type {
  TuiHostSlotMap,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext
} from "@opencode-ai/plugin/tui";
import type { Message, Session } from "@opencode-ai/sdk/v2";
import { MouseButton, type Renderable, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  collectCosts,
  formatBreakdown,
  groupSessionsByDay,
  type CostDeps,
  type MessageLike,
  type SessionGroup,
  type SessionLike
} from "./cost.ts";

export const id = "opencode-total-session-cost";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_DAYS = 7;
const LIST_LIMIT = 500;

const toMessageLike = (message: Message): MessageLike => {
  if (message.role === "assistant") {
    return {
      role: message.role,
      cost: message.cost,
      providerID: message.providerID,
      modelID: message.modelID
    };
  }
  return { role: message.role };
};

const toSessionLike = (session: Session): SessionLike => ({
  id: session.id,
  cost: session.cost,
  agent: session.agent,
  parentID: session.parentID,
  title: session.title,
  time: session.time ? { updated: session.time.updated } : undefined,
  model: session.model
    ? { providerID: session.model.providerID, id: session.model.id }
    : undefined
});

const createDeps = (api: TuiPluginApi): CostDeps => ({
  getSession: (sessionID) => api.state.session.get(sessionID),
  getMessages: (sessionID) => api.state.session.messages(sessionID).map(toMessageLike),
  getChildren: async (sessionID) => {
    try {
      const res = await api.client.session.children({ sessionID });
      return res.data ?? [];
    } catch (error) {
      console.error(`[${id}] failed to load children of session ${sessionID}`, error);
      return [];
    }
  }
});

const SessionCostList = (props: {
  api: TuiPluginApi;
  groups: SessionGroup[];
  current?: string;
  onSelect: (sessionID: string) => void;
}) => {
  const theme = props.api.theme.current;
  const dimensions = useTerminalDimensions();
  const sessions = props.groups.flatMap((group) => group.sessions);
  const [selected, setSelected] = createSignal(
    Math.max(0, sessions.findIndex((session) => session.id === props.current))
  );

  const rowRefs = new Map<number, Renderable>();
  let scroll: ScrollBoxRenderable | undefined;

  const move = (delta: number) => {
    const count = sessions.length;
    if (count === 0) return;
    setSelected((prev) => (prev + delta + count) % count);
  };

  useKeyboard((event) => {
    if (event.name === "up") {
      event.preventDefault();
      event.stopPropagation();
      move(-1);
      return;
    }
    if (event.name === "down") {
      event.preventDefault();
      event.stopPropagation();
      move(1);
      return;
    }
    if (event.name === "return") {
      event.preventDefault();
      event.stopPropagation();
      const session = sessions[selected()];
      if (session) props.onSelect(session.id);
    }
  });

  createEffect(() => {
    const row = rowRefs.get(selected());
    if (!row || !scroll || row.isDestroyed) return;

    const top = row.y - scroll.y;
    if (top < 0) {
      scroll.scrollBy(top);
      return;
    }
    if (top + row.height > scroll.height) {
      scroll.scrollBy(top + row.height - scroll.height);
    }
  });

  const maxHeight = () => Math.max(1, Math.floor(dimensions().height / 2) - 4);

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>
          <b>Session Costs</b>
        </text>
        <text fg={theme.textMuted}>last 7 days</text>
      </box>
      <Show
        when={sessions.length > 0}
        fallback={<text fg={theme.textMuted}>No sessions in the last 7 days.</text>}
      >
        <scrollbox
          ref={(element) => (scroll = element)}
          flexGrow={1}
          maxHeight={maxHeight()}
          scrollbarOptions={{ visible: false }}
        >
          <For each={props.groups}>
            {(group, index) => (
              <>
                <box
                  flexDirection="row"
                  justifyContent="space-between"
                  paddingLeft={1}
                  paddingRight={1}
                  paddingTop={index() > 0 ? 1 : 0}
                >
                  <text fg={theme.accent}>
                    <b>{group.label}</b>
                  </text>
                  <text fg={theme.accent}>
                    <b>${group.total.toFixed(2)}</b>
                  </text>
                </box>
                <For each={group.sessions}>
                  {(session) => {
                    const active = () => session.selection === selected();
                    return (
                      <box
                        ref={(element) => rowRefs.set(session.selection, element)}
                        flexDirection="row"
                        justifyContent="space-between"
                        paddingLeft={3}
                        paddingRight={1}
                        backgroundColor={active() ? theme.primary : undefined}
                        onMouseUp={() => props.onSelect(session.id)}
                      >
                        <text fg={active() ? theme.selectedListItemText : theme.text}>
                          {session.title}
                        </text>
                        <text fg={active() ? theme.selectedListItemText : theme.textMuted}>
                          ${session.total.toFixed(2)}
                        </text>
                      </box>
                    );
                  }}
                </For>
              </>
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  );
};

export const SessionCostPlugin: TuiPlugin = async (api) => {
  const showCostBreakdown = async (sessionID: string) => {
    const breakdown = await collectCosts(sessionID, createDeps(api));

    api.ui.toast({
      title: "Session Costs Breakdown",
      message: formatBreakdown(breakdown),
      variant: "success",
      duration: 10000
    });
  };

  const openSessionsCostList = async () => {
    const now = Date.now();
    let sessions: SessionLike[];
    try {
      const result = await api.client.session.list({
        start: now - LIST_DAYS * DAY_MS,
        limit: LIST_LIMIT
      });
      sessions = (result.data ?? []).map(toSessionLike);
    } catch (error) {
      console.error(`[${id}] failed to load sessions for the cost list`, error);
      api.ui.toast({
        title: "Session Costs",
        message: "Failed to load sessions.",
        variant: "error",
        duration: 4000
      });
      return;
    }

    const groups = groupSessionsByDay(sessions, now, LIST_DAYS);
    const current = api.route.current;
    const currentSessionID =
      current &&
      current.name === "session" &&
      typeof current.params?.sessionID === "string"
        ? current.params.sessionID
        : undefined;

    api.ui.dialog.replace(() => (
      <SessionCostList
        api={api}
        groups={groups}
        current={currentSessionID}
        onSelect={(sessionID) => {
          api.route.navigate("session", { sessionID });
          api.ui.dialog.clear();
        }}
      />
    ));
    api.ui.dialog.setSize("large");
  };

  api.slots?.register({
    slots: {
      session_prompt_right: (
        ctx: Readonly<TuiSlotContext>,
        props: TuiHostSlotMap["session_prompt_right"]
      ) => {
        const [total, setTotal] = createSignal<number>(0);
        let requestId = 0;

        const update = async () => {
          const currentRequest = ++requestId;
          const sessionID = props.session_id;
          if (!sessionID) {
            setTotal(0);
            return;
          }

          const breakdown = await collectCosts(sessionID, createDeps(api));
          if (currentRequest !== requestId) return;

          setTotal(breakdown.total);
        };

        const unsubMsgUpdated = api.event.on("message.updated", () => void update());
        const unsubMsgRemoved = api.event.on("message.removed", () => void update());
        const unsubSessionUpdated = api.event.on("session.updated", () => void update());
        const unsubSessionIdle = api.event.on("session.idle", () => void update());
        const interval = setInterval(() => void update(), 3000);

        onCleanup(() => {
          unsubMsgUpdated();
          unsubMsgRemoved();
          unsubSessionUpdated();
          unsubSessionIdle();
          clearInterval(interval);
        });

        void update();

        return (
          <text
            fg={ctx.theme.current.textMuted}
            onMouseUp={(event) => {
              if (event.button === MouseButton.LEFT) {
                void showCostBreakdown(props.session_id);
              } else if (event.button === MouseButton.RIGHT) {
                void openSessionsCostList();
              }
            }}
          >
            {" "}[ ${total().toFixed(2)} ]
          </text>
        );
      }
    }
  });

  api.keymap.registerLayer({
    commands: [
      {
        name: "total_cost",
        title: "Total Session Cost",
        desc: "Display total cost breakdown of current session and child sessions",
        category: "Cost Tracking",
        namespace: "palette",
        slashName: "total_cost",
        slashAliases: ["costs"],
        run: async () => {
          const currentSessionID =
            api.route.current &&
            api.route.current.name === "session" &&
            typeof api.route.current.params?.sessionID === "string"
              ? api.route.current.params.sessionID
              : null;

          if (!currentSessionID) {
            api.ui.toast({
              title: "No Active Session",
              message: "Please open a session to check costs.",
              variant: "warning",
              duration: 4000
            });
            return;
          }

          await showCostBreakdown(currentSessionID);
        }
      },
      {
        name: "sessions_cost",
        title: "Session Costs List",
        desc: "Show the last 7 days of sessions grouped by day with total costs",
        category: "Cost Tracking",
        namespace: "palette",
        slashName: "sessions_cost",
        slashAliases: ["session_costs"],
        run: async () => {
          await openSessionsCostList();
        }
      }
    ]
  });
};

export const tui = SessionCostPlugin;

const pluginModule: TuiPluginModule = {
  id,
  tui: SessionCostPlugin
};

export default pluginModule;

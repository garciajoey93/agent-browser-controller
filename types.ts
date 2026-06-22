// Shared TypeScript types for the Agent Browser Controller.
// Imported by the TypeScript entry points and the test files.

export type ActionName =
  | 'click' | 'type' | 'scroll' | 'navigate' | 'capture_state' | 'screenshot'
  | 'inspect' | 'evaluate' | 'tabs' | 'open' | 'close' | 'switch_tab'
  | 'set_active_tab' | 'set_status' | 'wait' | 'find_tab' | 'press_key' | 'finish'
  | 'tag_elements' | 'click_by_tag' | 'type_by_tag' | 'hover_by_tag'
  | 'clear_tags' | 'list_tags'
  | 'show_crosshair' | 'hide_crosshair'
  | 'start_drag' | 'update_drag' | 'end_drag'
  | 'move_mouse' | 'element_info' | 'hover_preview'
  | 'show_grid' | 'hide_grid' | 'show_selection' | 'hide_selection'
  | 'set_tag_filter' | 'flash_tag'
  | 'agent_start' | 'agent_step' | 'agent_stop' | 'agent_status'
  | 'save_llm_config' | 'get_llm_config';

export type ErrorCode =
  | 'INVALID_PARAMS' | 'UNKNOWN_ACTION' | 'NO_TAB' | 'ELEMENT_NOT_FOUND'
  | 'DEBUGGER_DENIED' | 'PERMISSION_DENIED' | 'TIMEOUT' | 'RATE_LIMITED'
  | 'NOT_FOUND' | 'EXTENSION_UNAVAILABLE' | 'QUEUE_FULL' | 'AUTH_FAILED';

export interface ActionRequest {
  id?: string;
  action: ActionName;
  params?: Record<string, unknown>;
  sessionId?: string;
  tabId?: number;
  idempotencyKey?: string;
}

export interface ActionResponse {
  ok: boolean;
  error?: string;
  errorCode?: ErrorCode;
  result?: unknown;
  queued?: boolean;
  position?: number;
  queueSize?: number;
  estWaitMs?: number;
  sessionId?: string;
  _idempotent_replay?: boolean;
}

export interface TabsActionResult {
  tabs: Array<{
    id: number;
    url?: string;
    title?: string;
    active?: boolean;
  }>;
}

export interface ScreenshotResult {
  dataUrl: string;
  bytes: number;
  format?: 'png' | 'jpeg' | 'webp';
}

export interface AgentStatus {
  active: boolean;
  runId?: string;
  tabId?: number;
  goal?: string;
}

export interface AgentInfo {
  id: string;
  goal: string;
  startedAt: number;
  lastStepAt: number;
  steps: number;
  workingTabId: number | null;
  lastAction?: string;
}

// Re-export the action list as a constant for runtime validation.
export const KNOWN_ACTIONS: ReadonlyArray<ActionName> = [
  'click', 'type', 'scroll', 'navigate', 'capture_state', 'screenshot',
  'inspect', 'evaluate', 'tabs', 'open', 'close', 'switch_tab',
  'set_active_tab', 'set_status', 'wait', 'find_tab', 'press_key', 'finish',
  'tag_elements', 'click_by_tag', 'type_by_tag', 'hover_by_tag',
  'clear_tags', 'list_tags',
  'show_crosshair', 'hide_crosshair',
  'start_drag', 'update_drag', 'end_drag',
  'move_mouse', 'element_info', 'hover_preview',
  'show_grid', 'hide_grid', 'show_selection', 'hide_selection',
  'set_tag_filter', 'flash_tag',
  'agent_start', 'agent_step', 'agent_stop', 'agent_status',
  'save_llm_config', 'get_llm_config',
];

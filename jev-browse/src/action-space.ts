// Ported from browser-use/jev-ultrafast jev_ultrafast/model.py action_space() (MIT),
// extended with field + value TYPE_TEXT targets when the driver supplies values.
import type { Action } from "./types";

export interface Element {
  index: string;
  label: string;
  operations: string[];
  role?: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  options?: { index: string; label: string; value: string | undefined }[];
}

export interface Target {
  action: Action;
  /** TYPE_TEXT only: provided value index, or null for "a value outside the list". */
  valueIndex?: number | null;
}

export interface ActionSpace {
  elements: Element[];
  /**
   * Operation name -> target key -> target. CLICK keys ("3") and SELECT keys
   * ("3:1") never collide; TYPE_TEXT may reuse a CLICK key for the same node.
   */
  targets: Record<string, Record<string, Target>>;
  /** Code-owned controls such as SCROLL_DOWN and WAIT, keyed by operation name. */
  controls: Record<string, Action>;
}

const OPERATIONS: Partial<Record<Action["kind"], string>> = {
  click: "CLICK",
  fill: "TYPE_TEXT",
  select: "SELECT",
};

/** One index per observed element; each operation has its own valid target choices. */
export function actionSpace(actions: Action[], values: readonly string[] = []): ActionSpace {
  const elements: Element[] = [];
  const indices = new Map<number, string>();
  const targets: Record<string, Record<string, Target>> = {};
  const controls: Record<string, Action> = {};
  for (const action of actions) {
    const operation = OPERATIONS[action.kind];
    if (operation === undefined || typeof action.node !== "number") {
      controls[action.id.toUpperCase()] = action;
      continue;
    }
    let index = indices.get(action.node);
    if (index === undefined) {
      index = String(elements.length + 1);
      indices.set(action.node, index);
      const element: Element = {
        index,
        label: action.label.split(" → ")[0] ?? action.label,
        operations: [],
      };
      for (const key of ["role", "value", "checked", "selected", "expanded"] as const) {
        if (action[key] !== undefined) element[key] = action[key];
      }
      if (action.kind === "select") {
        element.value = action.current_value ?? "";
        element.options = [];
      }
      elements.push(element);
    }
    const element = elements[Number(index) - 1]!;
    if (!element.operations.includes(operation)) element.operations.push(operation);
    const group = (targets[operation] ??= {});
    if (action.kind === "select") {
      element.options ??= [];
      const key = `${index}:${element.options.length + 1}`;
      element.options.push({ index: key, label: action.label, value: action.value });
      group[key] = { action };
    } else if (action.kind === "fill" && values.length > 0) {
      values.forEach((_, valueIndex) => {
        group[`${index}:v${valueIndex + 1}`] = { action, valueIndex };
      });
      group[`${index}:new`] = { action, valueIndex: null };
    } else {
      group[index] = { action };
    }
  }
  return { elements, targets, controls };
}

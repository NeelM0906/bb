import { splitLayoutAtom } from "./atoms";
import {
  countPanes,
  findPaneByContent,
  MAX_PANES,
  replacePaneContent,
  setFocus,
  splitPane,
  type PaneContent,
  type SplitLayout,
} from "./index";

interface SplitLayoutStore {
  get(atom: typeof splitLayoutAtom): SplitLayout | null;
  set(atom: typeof splitLayoutAtom, value: SplitLayout): void;
}

export interface OpenPaneContentInSplitArgs {
  store: SplitLayoutStore;
  /** react-router's navigate, or anything with the same first two arguments. */
  navigate: (
    route: string,
    options?: { replace?: boolean },
  ) => void | Promise<void>;
  content: PaneContent;
  /** The URL this content owns, so the focused pane and the URL agree. */
  route: string;
  /** Splits are off on compact viewports and outside the split workspace. */
  enabled: boolean;
}

/**
 * Open non-thread page content beside the focused pane: focus it if a pane
 * already holds it, replace at the pane cap, otherwise split right. Falls
 * back to plain navigation where there is no split to grow.
 *
 * Shared by the sidebar's cmd-click/drag entry point and by cmd-click on an
 * app-route link inside plugin UI (useRouteAnchorDelegate), so both place
 * the same page the same way.
 */
export function openPaneContentInSplit({
  store,
  navigate,
  content,
  route,
  enabled,
}: OpenPaneContentInSplitArgs): void {
  const layout = store.get(splitLayoutAtom);
  if (!enabled || layout === null) {
    void navigate(route);
    return;
  }
  const existing = findPaneByContent(layout.root, content);
  const next =
    existing !== null
      ? setFocus(layout, existing.paneId)
      : countPanes(layout.root) >= MAX_PANES
        ? replacePaneContent(layout, layout.focusedPaneId, content)
        : splitPane(layout, layout.focusedPaneId, "right", content);
  if (next !== layout) store.set(splitLayoutAtom, next);
  void navigate(route, existing !== null ? { replace: true } : undefined);
}

/**
 * Whether the workspace is already holding a plugin's detail page in a pane.
 *
 * The detail page is full-window like the rest of Extensions by default; it
 * only renders as a pane when something deliberately put it there (cmd-click
 * on a link to it from plugin UI). Deciding from the
 * layout rather than the URL is what keeps ordinary navigation to the page
 * from evicting whatever the focused pane was showing.
 */
export function holdsPluginDetailPane(
  layout: SplitLayout | null,
  pluginId: string,
): boolean {
  if (layout === null) return false;
  return (
    findPaneByContent(layout.root, { kind: "plugin-detail", pluginId }) !== null
  );
}

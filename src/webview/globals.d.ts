interface VsCodeApi<S> {
  getState(): S | undefined;
  setState(state: S): S;
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi<S = unknown>(): VsCodeApi<S>;
interface Window {
  waveWorkflow?: {
    scope: (value: string) => void;
    selectedScope: () => string;
    menu: (x: number, y: number) => void;
    groupsChanged: () => void;
    editGroup: (name?: string) => void;
    groupMenu: (x: number, y: number, name: string) => void;
  };
  waveMarkers?: { render: () => void };
  waveHover?: { refresh: () => void };
}

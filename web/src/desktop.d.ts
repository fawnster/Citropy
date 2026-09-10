export {};

export interface DesktopWindowState {
  maximized: boolean;
  fullscreen: boolean;
  platform: string;
  development: boolean;
  version: string;
  notifications: boolean;
  electron: string;
}

declare global {
  interface Window {
    loomDesktop?: Window["citropyDesktop"];
    citropyDesktop?: {
      windowState(): Promise<DesktopWindowState>;
      windowCommand(
        command: "minimize" | "maximize" | "close" | "reload" | "restart",
      ): Promise<void>;
      onWindowState(callback: (state: DesktopWindowState) => void): () => void;
      onNotification(
        callback: (notification: {
          id: string;
          target: import("../../shared/protocol.ts").NotificationTarget;
        }) => void,
      ): () => void;
      onBrowserSelect(
        callback: (panel: {
          id: string;
          projectId: string;
          threadId?: string;
        }) => void,
      ): () => void;
      browserBounds(
        id: string,
        bounds: { x: number; y: number; width: number; height: number } | null,
        visible: boolean,
        cover?: boolean,
      ): void;
      onBrowserCover(
        callback: (id: string, image?: string) => void,
      ): () => void;
      onAddressFocus(callback: (id: string) => void): () => void;
    };
  }
}

export {};

export interface DesktopWindowState {
  maximized: boolean;
  fullscreen: boolean;
  platform: string;
  development: boolean;
  channel: "stable" | "lemon";
  version: string;
  notifications: boolean;
  electron: string;
}

declare global {
  interface Window {
    loomDesktop?: Window["citropyDesktop"];
    citropyDesktop?: {
      environmentsState(): Promise<import("../../shared/environments.ts").EnvironmentState>;
      configureProjectDefaults(settings: import("../../shared/protocol.ts").ProjectSettings): Promise<import("../../shared/protocol.ts").ProjectSettings>;
      sshHosts(): Promise<string[]>;
      saveEnvironment(connection: Omit<import("../../shared/environments.ts").SshConnection, "id"> & { id?: string }): Promise<import("../../shared/environments.ts").SshConnection>;
      connectEnvironment(id: string): Promise<import("../../shared/environments.ts").EnvironmentState>;
      disconnectEnvironment(id: string): Promise<void>;
      stopEnvironment(id: string): Promise<void>;
      removeEnvironment(id: string): Promise<void>;
      chooseWorkspaceFolder(id: string, path?: string): Promise<string | null>;
      onEnvironmentsState(callback: (state: import("../../shared/environments.ts").EnvironmentState) => void): () => void;
      updateState(): Promise<import("../../shared/app-update.ts").AppUpdateState>;
      updateCommand(action: "check" | "download" | "install"): Promise<import("../../shared/app-update.ts").AppUpdateState>;
      onUpdateState(callback: (state: import("../../shared/app-update.ts").AppUpdateState) => void): () => void;
      windowState(): Promise<DesktopWindowState>;
      windowCommand(
        command: "minimize" | "maximize" | "close" | "reload" | "restart",
      ): Promise<void>;
      onWindowState(callback: (state: DesktopWindowState) => void): () => void;
      onNotification(
        callback: (notification: {
          id: string;
          environmentId?: string;
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

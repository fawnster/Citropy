export interface SshConnection {
  id: string;
  name: string;
  target: string;
  port: number;
  node: string;
}

export interface EnvironmentState {
  activeId: string;
  endpoint: string;
  connections: (SshConnection & {
    status: "disconnected" | "connecting" | "connected" | "error";
    message?: string;
  })[];
}

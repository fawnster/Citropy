import { Ban, Check, CheckCheck, shapeIcon } from "./icons.ts";
import { answerPermission } from "../lib/actions.ts";
import { useApp } from "../lib/store.ts";
import { Modal } from "./Modal.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import type { PermissionRequest } from "../../../shared/protocol.ts";

function lines(value: unknown): string[] {
  return typeof value === "string" ? value.split("\n") : [];
}

function lede(request: PermissionRequest, project: string): string {
  const where = request.detail ? `${request.detail}/` : "";
  switch (request.shape) {
    case "command":
      return `Run this command in ${project}.`;
    case "write":
      return `Create ${where}${request.headline} in ${project}.`;
    case "edit":
      return `Change ${where}${request.headline}.`;
    case "read":
      return `Read ${where}${request.headline}.`;
    case "web":
      return "Fetch this address from the internet.";
    case "computer":
      return "Use the shared desktop screen, pointer, or keyboard.";
    case "task":
      return "Start a subagent for this task.";
    default:
      return `Run the ${request.tool} tool.`;
  }
}

function Body({ request }: { request: PermissionRequest }) {
  const input = (request.input ?? {}) as Record<string, unknown>;

  if (request.shape === "command") {
    return (
      <pre className="ask-code">
        <code>{String(input.command ?? request.headline)}</code>
      </pre>
    );
  }

  if (request.shape === "edit" && typeof input.old_string === "string") {
    return (
      <div className="ask-diff">
        {lines(input.old_string).map((line, index) => (
          <div className="diff-line" data-type="del" key={`d${index}`}>
            <span className="diff-sign">-</span>
            <span className="diff-code">{line}</span>
          </div>
        ))}
        {lines(input.new_string).map((line, index) => (
          <div className="diff-line" data-type="add" key={`a${index}`}>
            <span className="diff-sign">+</span>
            <span className="diff-code">{line}</span>
          </div>
        ))}
      </div>
    );
  }

  if (request.shape === "write" && typeof input.content === "string") {
    return (
      <pre className="ask-code">
        <code>{input.content.slice(0, 4000)}</code>
      </pre>
    );
  }

  return (
    <pre className="ask-code">
      <code>{JSON.stringify(request.input, null, 2).slice(0, 4000)}</code>
    </pre>
  );
}

export function PermissionLayer() {
  const requests = useApp((state) => state.permissions);
  const request = requests[0];
  const project = useApp((state) => {
    const thread = request ? state.threads[request.threadId] : undefined;
    return state.projects.find((entry) => entry.id === thread?.projectId)?.name ?? "this workspace";
  });

  const thread = useApp((state) =>
    request ? state.threads[request.threadId] : undefined,
  );
  const connected = useApp((state) => state.connected);
  if (!request) return null;
  const Icon = shapeIcon[request.shape];
  return (
    <Modal
      key={request.id}
      className="permission-dialog"
      title="Review this action"
      description={lede(request, project)}
      icon={<Icon size={21} />}
      onClose={() => answerPermission(request.id, "deny")}
      footer={
        <>
          <button
            className="btn"
            type="button"
            data-cancel
            disabled={!connected}
            onClick={() => answerPermission(request.id, "deny")}
          >
            <Ban size={14} />
            Deny
          </button>
          <span className="composer-spacer" />
          <button
            className="btn"
            type="button"
            disabled={!connected}
            onClick={() => answerPermission(request.id, "allow_always")}
          >
            <CheckCheck size={14} />
            Allow this tool for this session
          </button>
          <button
            className="btn"
            type="button"
            data-variant="primary"
            disabled={!connected}
            onClick={() => answerPermission(request.id, "allow")}
          >
            <Check size={14} />
            Allow once
          </button>
        </>
      }
    >
      <div className="permission-context">
        {thread && <ProviderIcon provider={thread.provider} />}
        <span className="truncate">{thread?.title ?? project}</span>
        <span>· {request.tool}</span>
        {requests.length > 1 && (
          <span className="pill">{requests.length - 1} waiting</span>
        )}
      </div>
      <Body request={request} />
      {!connected && (
        <p className="dialog-error" role="alert">
          Reconnect to Citropy to respond.
        </p>
      )}
    </Modal>
  );
}

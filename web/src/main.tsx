import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/standard.css";
import "@fontsource-variable/inter/standard-italic.css";
import "@fontsource-variable/geist-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/sidebar.css";
import "./styles/settings.css";
import "./styles/conversation.css";
import "./styles/markdown.css";
import "./styles/diff.css";
import "./styles/composer.css";
import "./styles/inspector.css";
import "./styles/workbench.css";
import "./styles/overlays.css";
import "./styles/git.css";
import "./styles/github.css";
import "./styles/features.css";
import "./styles/computer.css";
import "./styles/environments.css";
import { initializeEnvironment } from "./lib/environment.ts";

async function start() {
  await initializeEnvironment();
  const [{ App }, { connect }, { useApp }] = await Promise.all([import("./App.tsx"), import("./lib/socket.ts"), import("./lib/store.ts")]);

  if (!window.citropyDesktop && window.loomDesktop)
    window.citropyDesktop = window.loomDesktop;

  document.documentElement.dataset.theme = useApp.getState().theme;
  document.documentElement.style.setProperty(
    "--ui-scale",
    String(useApp.getState().uiScale / 100),
  );
  connect();

  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

}

void start().catch(error => {
  const root = document.getElementById("root");
  if (root) root.textContent = error.message;
});

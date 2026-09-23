const { ipcRenderer } = require("electron");

const shortcut = process.platform === "darwin" ? "Control+Option+Escape" : "Ctrl+Alt+Escape";
let paused = false;
ipcRenderer.on("computer-indicator:state", (_, state) => {
  const es = state.language === "es";
  const text = es ? {
    paused: "Uso del ordenador en pausa", control: "Citropy controla esta pantalla", view: "Citropy ve esta pantalla", resume: "Reanudar control", pause: "Pausar control", stop: "Detener uso del ordenador", stopLabel: "Detener", controls: "Controles de uso del ordenador",
  } : {
    paused: "Computer use paused", control: "Citropy is controlling this screen", view: "Citropy is viewing this screen", resume: "Resume computer use", pause: "Pause computer use", stop: "Stop computer use", stopLabel: "Stop", controls: "Computer use controls",
  };
  paused = state.paused;
  document.documentElement.lang = es ? "es" : "en";
  document.querySelector("main").setAttribute("aria-label", text.controls);
  document.body.dataset.paused = String(paused);
  document.querySelector("#status").textContent = paused ? text.paused : state.control ? text.control : text.view;
  const button = document.querySelector("#pause");
  button.setAttribute("aria-label", paused ? text.resume : text.pause);
  button.title = paused ? text.resume : text.pause;
  button.disabled = false;
  document.querySelector("#stop").title = text.stop + (state.shortcut ? ` (${shortcut})` : "");
  document.querySelector("#stop").setAttribute("aria-label", text.stop);
  document.querySelector("#stop-label").textContent = text.stopLabel;
});
window.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#pause").addEventListener("click", event => {
    event.currentTarget.disabled = true;
    ipcRenderer.send("computer-indicator:action", paused ? "resume" : "pause");
  });
  document.querySelector("#stop").addEventListener("click", () => ipcRenderer.send("computer-indicator:action", "stop"));
});

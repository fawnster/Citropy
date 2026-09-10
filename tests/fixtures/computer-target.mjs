import { app, BrowserWindow } from "electron";
import { createInterface } from "node:readline";
import { computerRequest, connectComputerEvents, stopComputer } from "../../desktop/computer.mjs";

app.setPath("userData", process.env.CITROPY_TEST_DATA);
app.whenReady().then(async () => {
const window = new BrowserWindow({ x: 0, y: 0, width: 1200, height: 800, frame: false, webPreferences: { sandbox: true, contextIsolation: true } });
await window.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Computer input fixture</title><style>body{margin:0;background:#15232f;color:white;font:20px sans-serif}main{padding:60px}input,button{font:inherit;padding:12px}#drag{margin-top:40px;height:130px;background:#2587d4;touch-action:none}#scroll{height:180px;overflow:auto;margin-top:30px}#scroll>div{height:1600px;background:linear-gradient(#425,#528)}</style><main><h1>Desktop input test</h1><input aria-label="Text"><button id="click">Click target</button><output id="count">0</output><div id="drag">Drag target</div><div id="scroll"><div>Scroll target</div></div></main><script>window.keys=[];window.drag=[];window.down=false;document.querySelector('#click').onclick=()=>document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1;addEventListener('keydown',e=>window.keys.push({key:e.key,ctrl:e.ctrlKey,shift:e.shiftKey}));addEventListener('pointerdown',e=>{window.down=true;window.drag.push([e.clientX,e.clientY])});addEventListener('pointerup',e=>{window.down=false;window.drag.push([e.clientX,e.clientY])});</script>`)}`);
window.focus();
connectComputerEvents(event => process.stdout.write(`${JSON.stringify({ event })}\n`));
createInterface({ input: process.stdin }).on("line", async line => {
  const request = JSON.parse(line);
  try {
    const result = await computerRequest(request.method, request.params);
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) { process.stdout.write(`${JSON.stringify({ id: request.id, error: error.message })}\n`); }
});
process.stdin.on("end", () => app.quit());
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
});
app.on("before-quit", () => stopComputer());

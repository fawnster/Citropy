# Citropy

A desktop workspace for conversations with Claude Code, Codex, and OpenCode.

Use Node.js 22.18 or newer. Install dependencies with `npm install`, then open the app with `npm run desktop`. If the Electron download was skipped during installation, run `npm run setup:desktop` once.

The desktop window embeds Chromium. Open the workspace panel and choose Browser, Computer, Terminal, Files, Changes, Subagents, or Tools. Browser and terminal tabs stay open when you switch panels. Providers use Citropy's MCP tools to work with those same sessions, subject to the conversation's permission setting. Subagents stay attached to their parent conversation and can be opened from its disclosure or the Subagents tab.

`npm start` runs the web interface at http://127.0.0.1:4177. The embedded browser requires the desktop window; the web interface includes an Open Citropy desktop button. `npm run desktop:dev` opens the desktop with live interface updates at http://127.0.0.1:5177. It reuses the running server and keeps conversations and terminals alive. `npm run dev` starts the web development server without opening a desktop window.

On Linux, `npm run desktop:install` adds Citropy to the application menu with live updates enabled. In Settings > Application, reload the interface or restart the desktop after changing its native code. Server changes need a server restart after active work has finished. There is no packaged updater or signed release build yet.

Model options show the selected model, reasoning effort, context window, and fast mode where supported. Available choices come from the installed providers. Claude extended context is selected per conversation; Codex fast mode uses its priority service tier. Fast mode starts off and can increase provider usage or charges.

The sidebar navigation can collapse to icons by dragging its footer handle down, or by clicking it. Subagent lists are revealed on hover or keyboard focus and expand when clicked. Completed earlier batches remain in the workspace tab under Earlier subagents.

New conversations can use the current folder, create a Git worktree, or select an existing worktree. Files, Git operations, provider tools, and new terminals use that conversation's folder. Creating a worktree requires an initial commit. Removing a conversation keeps its worktree and files.

Settings > Projects saves each project's provider, model, reasoning effort, permission, and worktree defaults. Project actions run saved terminal commands; setup actions run when creating a worktree. Use the composer's command menu or `/run Action name` to run an action in the current conversation's folder.

Attach images and files with the paperclip, paste images, or drop files into the composer. Up to eight files of 50 MB each are stored with the conversation. Click an attachment before or after sending to preview it. The file viewer supports images, PDFs, audio, video, Markdown, HTML, and highlighted source files, with downloads for other formats. HTML previews cannot run scripts. Providers receive native image inputs where supported and local file references for other attachments.

Type `/` to find Citropy commands and commands discovered from the selected provider. Claude exposes its supported headless commands, OpenCode uses its native command catalog, and Codex supports `/review` and personal `/prompts:name` commands. Citropy commands include `/compact`, `/usage`, `/skills`, `/model`, `/plan`, `/permissions`, and available model options. Manual compaction uses the provider's own context summary and keeps the visible conversation history. Providers still perform automatic compaction when needed. Settings > Skills lists personal, project, and plugin skills, shows their instructions, and enables, disables, or deletes them. These changes affect the installed skill files and their provider CLI. Deleted instructions have a recovery copy in `~/.citropy/deleted-skills`. Type `@` in the composer to choose an enabled skill. Personal skills apply across projects for their provider, while `.agents/skills` folders can share skills across providers. The provider filter shows the available inventory.

The menu beside each conversation offers rename, pin, reorder, snooze, archive, and a pull request link. Drag conversations to reorder them. The tick button marks a conversation finished; changing conversations does not finish them.

Settings > Browser manages separate login profiles and imports cookies from supported local Chromium or Firefox profiles. Importing is explicit and may need the system keyring; some protected or partitioned cookies cannot be copied, and sites can require another sign-in. Windows Chromium cookie import is not supported. Open tabs keep their profile when a different profile is selected for new tabs.

The Usage button shows Claude Code and Codex account allowances, reset times, and token totals from saved Citropy conversations. OpenCode does not expose a combined remaining allowance. Totals include input, output, cache reads and writes, and costs reported by providers. Settings > Resources shows memory, CPU, browser tabs, terminals, and running conversations. Its polling stops when the view closes.

The notification center keeps the last 100 completion notices, including responses, Git actions, and GitHub actions. Settings > Notifications controls popups, desktop alerts, and notification sounds. Desktop alerts appear when Citropy is in the background.

Settings > General > Response text controls text streaming. Turn streaming off to wait for a complete text block, then show it immediately or reveal it with a typing animation. The speed slider controls characters per second. Existing history appears immediately, and reduced-motion preferences disable typing animation. Tool activity stays live.

Conversations and workspaces are stored in `~/.citropy`. Desktop preferences and browser sessions use the `Citropy` application data directory, with cookies separated by workspace. On the first launch after renaming, the old Loom data directories, workspace cookies, and browser preferences migrate automatically. Existing Citropy data is never overwritten. Closing the desktop window ends its browser sessions while the local Citropy server continues running.

The browser starts at 1920 × 1080 and scales its preview to fit the workspace panel. The page resolution stays fixed when the app or panel resizes. Use the resolution menu for desktop, tablet, phone, and custom sizes. Mobile mode requests mobile sites using Android Chrome browser identification and client hints, enables touch input, and uses a mobile viewport. Phone and tablet presets enable it automatically. Changing modes reloads the page; resizing within the same mode preserves the current page. This emulates a mobile browser in Chromium, not iOS Safari or actual phone hardware.

Providers can use the MCP `browser_action` tool with `action: "resize"`, `width`, `height`, and optional `mobile`. Omit `mobile` to keep the current mode. MCP screenshots and click coordinates use the selected page resolution.

Computer use controls native Linux desktop applications through the same MCP connection. Enable it in Settings > Computer use, open Computer in the workspace panel, and choose Share a screen. On Wayland, the operating system asks you to select screens and allow keyboard and pointer input. X11 shares the current desktop. One conversation owns the session; other conversations cannot capture it or send input. Plan only sessions can view the screen. Other input follows the conversation's permission setting.

The Computer panel provides a live preview, display selection, a larger preview, pointer interaction, recent activity, pause, and stop. The title bar also stops an active session. Ctrl+Alt+Escape is an emergency stop where the desktop supports global shortcuts. Pausing cancels pending input and invalidates previous screenshot coordinates. Sessions end when their conversation is stopped, finished, deleted, or switched to Plan only, when the provider is disabled or the desktop closes, or after five minutes without actions. Changing a monitor's capture resolution requires starting a new session. Preview refreshes do not extend the inactivity timeout and stop when the panel is hidden.

Providers use `computer_help`, `computer_status`, `computer_start`, `computer_screenshot`, `computer_action`, and `computer_stop`. Actions include movement, single/double/triple clicks, dragging, scrolling, shortcuts, text entry, and short waits. Pointer actions require a recent screenshot ID and coordinates measured in that image; Citropy handles scaling. Screenshots are returned directly to the provider and are not saved as Citropy preview files. Providers can retain tool results in their own session history.

The bundled `@computer-use` skill is shared by Claude Code, Codex, and OpenCode. Its installed instructions live in `~/.citropy/skills/computer-use/SKILL.md`; disabling or deleting them in Skills affects all Citropy providers. Settings > Computer use can restore the bundled instructions. This does not install the skill in the standalone provider CLIs. Existing provider sessions may need a new conversation to discover newly added MCP tools.

Native computer use currently supports Linux. It requires Python 3 and PyGObject with GdkPixbuf. Wayland also requires Python D-Bus, GStreamer with its base and PipeWire plugins, libxkbcommon, and a desktop portal supporting RemoteDesktop and ScreenCast, such as KDE or GNOME. X11 requires xdotool, libX11, and libXtst. Settings reports missing support; `python3 desktop/computer-linux.py --probe` checks dependencies without starting screen sharing. Windows and macOS native computer control are not implemented.

Run `npm run typecheck`, `npm test`, and `npm run build` to verify changes. The native integration tests use Electron, Xvfb, and xdotool on Linux. Portal protocol tests use a private D-Bus session and a synthetic GStreamer video source. A real Wayland sharing session still requires the operating system’s consent dialog.

## Code layout

`shared/` defines the events, model options, and workspace types used by both sides. `server/providers/` translates each provider's protocol into conversation events; `server/runtime.ts` owns a conversation's provider session and cleans up unfinished tools when it ends. `server/providers/process.ts` handles process termination and lets server shutdown wait for it.

`web/src/lib/store.ts` applies batches of server events to normalized UI state. Components subscribe to the records they display. `web/src/lib/requests.ts` owns request deadlines and disconnect cleanup, while `socket.ts` owns connection recovery and event batching. Settings, Git, and GitHub load when opened.

File previews own their requests and ignore replies after closing or switching files. Browser and terminal panels release layout observers when hidden; terminals retain their output across tab switches. Markdown caches completed output with an entry and size limit. `server/git-monitor.ts` coalesces overlapping Git scans and refreshes the affected workspace when a response finishes.

`server/features.ts` routes the local feature APIs to `workspaces.ts`, `assets.ts`, `skills.ts`, `usage.ts`, and `diagnostics.ts`. `desktop/browser-profiles.mjs` owns browser partitions and cookie import. Shared feature types live in `shared/features.ts`; their settings screens and viewers are separate components.

Lifecycle tests cover reconnects, repeated tab switching, deleted conversation data, late file replies, provider startup failures, and processes that ignore graceful termination. These checks detect regressions in those paths; longer sessions and future provider versions still need profiling.

`server/computer.ts` owns computer sessions, permissions, screenshot coordinates, action serialization, and inactivity cleanup. `desktop/computer.mjs` manages the helper process and emergency shortcut; `desktop/computer-linux.py` implements portal and X11 capture and input. `ComputerPane` owns preview polling and `ComputerSettings` owns the feature setup. No computer helper runs while the feature is idle.

<div align="center">
  <img src="public/citropy.svg" width="84" alt="">
  <h1>Citropy</h1>
  <p>A desktop workspace for Claude Code, Codex, and OpenCode.</p>
  <p>
    <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg">
    <img alt="Node.js 22.18 or newer" src="https://img.shields.io/badge/node-%3E%3D22.18-5FA04E.svg">
    <img alt="Linux and macOS" src="https://img.shields.io/badge/desktop-Linux%20%26%20macOS-1793D1.svg">
  </p>
</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/chat-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/chat-light.png">
  <img alt="Citropy running a Claude Code conversation beside the task list and Git status" src="docs/assets/chat-light.png">
</picture>

Citropy runs the coding agent CLIs you already have, in one window. Each conversation keeps its own provider, model, reasoning effort, and permission mode, while files, Git, terminals, browser tabs, and checkpoints belong to the workspace. It runs against a local backend on your machine, or on a remote host over SSH.

## Commit and push with the agent

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/git-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/git-light.png">
  <img alt="The Git panel showing the branch, changed files, and AI commit buttons" src="docs/assets/git-light.png">
</picture>

The floating Git panel shows the branch, the change counts, and the commits waiting to push. AI commit writes the message from a bounded diff in a separate session, and the model used for it is chosen per conversation.

## Review every change

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/changes-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/changes-light.png">
  <img alt="The Changes panel with grouped files and an expanded diff" src="docs/assets/changes-light.png">
</picture>

Files group by added, changed, and deleted, with diffs inline. Stage, unstage, or revert single hunks, comment on lines, and send the comments back to the agent as feedback. Every turn is checkpointed, so a message can be restored or branched into a new conversation.

## Browser, terminals, and files beside the chat

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/browser-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/browser-light.png">
  <img alt="The browser panel showing a local dashboard next to the conversation" src="docs/assets/browser-light.png">
</picture>

The workspace panel opens a browser, terminal, file tree, changes view, subagents, and the MCP tool list. Tabs and terminals stay open while you move between them, and providers drive the same browser and terminal sessions through Citropy's MCP tools. Page resolution, mobile mode, and phone presets are one click away.

## Computer use, for the whole desktop

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/computer-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/computer-light.png">
  <img alt="The Computer panel sharing a Linux desktop with recent activity" src="docs/assets/computer-light.png">
</picture>

Share a screen and let a conversation move, click, drag, scroll, and type in native desktop apps. Input follows the conversation's permission mode, a screen indicator keeps pause and stop reachable from anywhere, and sessions end after five minutes without actions.

## Questions land in one panel

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/question-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/question-light.png">
  <img alt="A question from the agent with answer choices above the composer" src="docs/assets/question-light.png">
</picture>

Claude Code, Codex, and OpenCode ask in the same panel above the composer. Pick one option, select several, write your own answer, or skip. Replies return to the waiting tool, and drafts survive switching conversations and reconnecting.

## Local, SSH, and Docker workspaces

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/workspaces-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/workspaces-light.png">
  <img alt="The workspace picker showing local folders, an SSH host, and Docker" src="docs/assets/workspaces-light.png">
</picture>

Open a local folder, connect to a host over SSH, or start a Docker environment. Files, Git, terminals, and provider sessions run on that host while the interface stays local. Per-folder settings inherit from global defaults or override them, and switching hosts preserves drafts, selections, and running shells.

## Usage and resources

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/usage-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/usage-light.png">
  <img alt="The Usage view with allowances, token totals, and per-conversation usage" src="docs/assets/usage-light.png">
</picture>

Claude Code and Codex allowances with reset times, token totals for every saved conversation, and a live view of memory, CPU, terminals, browsers, and running work.

## Install

Linux, Node.js 22.18 or newer, and Git, plus at least one of the agent CLIs installed and signed in.

Linux and macOS install and update with one command. It downloads the latest release, verifies its checksum, and puts Citropy in your user account, with no administrator password.

```sh
curl -fsSL https://raw.githubusercontent.com/tinuxongit/Citropy/main/scripts/install.sh | sh
```

On Linux it installs `~/.local/bin/citropy` and adds Citropy to your application menu. On macOS it installs `~/Applications/Citropy.app`, ad-hoc signed so Apple Silicon runs it, without the quarantine tag, so it opens without a Gatekeeper prompt. A zip downloaded through a browser instead is blocked by Gatekeeper on macOS 15 and later. Re-run the same command to update, and pass `--uninstall` to remove it. On macOS the update button in Settings runs this installer for you.

### Lemon builds

Every push to main publishes a rolling **Lemon** build with the newest changes. It installs next to Citropy with its own data and settings, and shows a Lemon tag beside the title. These builds are for testing and can break.

```sh
curl -fsSL https://raw.githubusercontent.com/tinuxongit/Citropy/main/scripts/install.sh | sh -s -- --channel=lemon
```

Remove it later with `--channel=lemon --uninstall`.

From a source checkout instead:

```sh
git clone https://github.com/tinuxongit/Citropy.git
cd Citropy
npm install
npm run desktop
```

If the Electron download was skipped during installation, run `npm run setup:desktop` once. Conversations and settings are stored in `~/.citropy`.

## Development

```sh
npm run desktop:dev   # desktop window with live interface updates
npm run dev           # web development server, no desktop window
npm start             # web interface at http://127.0.0.1:4177
npm run typecheck     # TypeScript
npm test              # test suite
npm run build         # production web bundle
npm run screenshots   # regenerate the images in docs/assets
```

`npm run desktop:dev` uses separate data in `~/.citropy-dev`, a **Citropy Dev** desktop profile, and backend port 4178. The live interface runs on port 5177. Development controls stay out of normal builds.

`npm run desktop:install` adds the normal source build to the application menu; pass `-- --dev` for a separate development launcher. `npm run desktop:package` builds a Linux AppImage and its update manifest in `release/`; pass `-- --mac` on macOS for a zip of the app. The packaged app starts and stops its own local server. `npm run desktop:smoke` checks the packaged app without running a model, and `npm run desktop:smoke:mac` checks the macOS zip.

[Development and release instructions](docs/release.md) cover isolation, system dependencies, GitHub checks, and draft releases.

## Documentation

[docs/guide.md](docs/guide.md) covers workspaces, Git and checkpoints, providers, the browser and computer tools, settings, storage, and the code layout. Issues and pull requests are welcome.

## License

MIT. See [LICENSE](LICENSE). Bundled Inter and Geist Mono fonts are used under the SIL Open Font License; license copies ship in `public/fonts`.

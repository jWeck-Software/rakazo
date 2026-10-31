# Import an OpenClaw, Hermes, Grok Bot or ChatGPT agent

Moving from OpenClaw, Hermes Agent, a Grok Bot template or another assistant such as ChatGPT or
Claude? Rakazo can turn it into a new bot, with its instructions, memory and skills, next to the
bots you already have.

Open **Settings → General** and choose **Import an agent**. Import is available in the web app
and the desktop app.

## From OpenClaw or Hermes

Choose either:

- **Choose folder**: the agent's home folder, such as `~/.openclaw` or `~/.hermes`.
- **Choose backup**: a `.zip` or `.tar.gz` backup of that folder.

The folder or backup is read on your device. Only the files the import uses are sent, and
`.env` and `auth.json` are read only if you tick **Include API keys**.

## From a Grok Bot

Bring in a Grok Bot template either way:

- **From the template catalog**: download a template's zip from the
  [Grok Bot template catalog](https://shixuuu.github.io/grokbot-pi-templates/), then choose
  **Choose backup** for the zip, or **Choose folder** for the unzipped folder.
- **By its share link**: paste the link (`https://x.ai/bot/…`) and choose **Open**. Grok Bot
  templates live on Cursor's servers, so the first time Rakazo shows **Sign in with Cursor**.
  This needs a Cursor plan that includes Grok Bot, such as Premium. Cursor's own sign-in page
  opens in your browser, and once you approve it the template opens.

The bot gets the template's description and standing instructions, its notes as memory, and its
skills. Its instructions end with a line crediting the template and its creator. Routines that run
on a schedule come along off until you turn them on, and run in your own time zone. Routines that
start on an event, such as a webhook or a Slack message, and the template's Grok plugins are
listed under **Not imported**: set those up yourself, for example as MCP servers.

Your Cursor sign-in is stored encrypted for your account, sent only to Cursor, and used only to
read templates. Rakazo forgets it when Cursor refuses it, or when you choose **Sign out** next to
**Signed in to Cursor** under the link field.

The catalog is [grokbot-pi-templates](https://github.com/Shixuuu/grokbot-pi-templates), converted
by [pi-grokbot-import](https://github.com/Shixuuu/pi-grokbot-import) (MIT), both by Shixuuu.
Rakazo reads that layout and asks Cursor for templates the way pi-grokbot-import does. Importing
by link follows [OpenMausBot](https://github.com/milind-soni/OpenMausBot) by milind-soni
(Apache-2.0).

## From another assistant

For ChatGPT, Claude, Gemini or any other assistant:

1. Choose **Copy prompt** and send the prompt to your old assistant. It asks it to write down its
   name, instructions, what it remembers about you, and the procedures it follows.
2. Paste its reply and choose **Continue**, or choose **Choose file** if it gave you a `.md` file.

## Choose what comes along

Before anything is created, you see every item the import found and tick what to keep:

| Item | Becomes |
| --- | --- |
| Instructions (`SOUL.md`, `AGENTS.md`, …) | The new bot's instructions |
| Memory (`MEMORY.md`, `USER.md`, daily notes) | The bot's memory, or memory shared by all your bots |
| Skills | Skills in the library all your bots share |
| Model | The bot's model, when you have that provider connected or import its key |
| MCP servers | MCP servers the bot asks before using |
| Scheduled jobs | Routines, paused until you turn them on |
| API keys | Model connections, only when you tick **Include API keys** |

Anything that runs code or acts on its own (skills, MCP servers, routines) starts unticked, as do
untouched defaults the old agent wrote and text that looks like it contains a key. **Not
imported** lists what was left out and why, such as files only the old runtime uses.

## After the import

The new bot opens with a checklist of anything that still needs you, such as a credential an MCP
server needs or a paused routine. Each item links to where you finish it. Your other bots,
including Chief, are not changed.

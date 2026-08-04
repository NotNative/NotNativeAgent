# Telegram gateway

The Telegram gateway is an optional trusted remote-operator surface. It uses Telegram's
HTTPS Bot API directly through Node.js and has no Telegram SDK dependency. It is disabled
until a bot token and at least one numeric Telegram user ID are configured. Messages from
unknown user IDs are ignored and recorded only as content-free denial telemetry.

Run `/gateway` from the Console to inspect status, test the bot, start or stop polling,
enable or disable the gateway, manage authorized user IDs, and select its workspace. The
same controls are available to scripts:

```text
nna gateway status
nna gateway token-env NNA_TELEGRAM_BOT_TOKEN
nna gateway authorize 123456789
nna gateway workspace /absolute/path
nna gateway enable
nna gateway test
nna gateway start
```

The installer can accept a BotFather token and numeric operator ID, validates the bot,
starts the gateway, and registers it for login startup where the platform supports a user
startup service. Existing valid configuration is preserved on later installer runs.
Interactive installer token entry is hidden. The token is stored only in the restricted
local `$NNA_HOME/config/gateway.json`, unless `token-env` is configured; status, health,
logs, support bundles, and the Console never display it.

Each Telegram chat maps to a stable hashed NNA session identity, so chat IDs are not used
as storage names. Chats retain independent durable transcripts and are ordered within the
chat while sharing NNA's bounded provider scheduler. `/cancel` bypasses the chat queue and
reaches an active engine turn immediately. Replies are plain text and split at Telegram's
message-size boundary.

Gateway sessions use the normal engine, reviewer, tools, model routes, context management,
hooks, skills, forensic telemetry, and project-trust rules. A role without a dedicated
provider profile inherits Primary just as it does in the Console. Telegram does not create
a second permission system and cannot bypass tool review. The configured gateway workspace
is therefore a real authority boundary; choose it deliberately.


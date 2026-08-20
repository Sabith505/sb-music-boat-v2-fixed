# SB Music Bot V2

## Commands

- `/sb play <song or YouTube URL>`
- `/sb pause`
- `/sb resume`
- `/sb skip`
- `/sb stop`
- `/sb queue`
- `/sb volume <1-100>`
- `/sb loop`
- `/sb leave`

## Setup

1. Install Node.js 20+.
2. Create a Discord bot in the Discord Developer Portal.
3. Copy `.env.example` to `.env`.
4. Fill in `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID`.
5. Invite the bot with the `bot` and `applications.commands` scopes.
6. Give it View Channel, Connect, Speak, and Send Messages permissions.
7. Run:
   npm install
   npm start

## Notes

This version uses `play-dl` for YouTube search/streaming. YouTube can change its delivery systems, so playback may occasionally require a package update.

# Online Blackjack

Two to four people play blackjack against the dealer from different computers. One person creates a table, shares the link, and everyone plays in the browser.

## Run it on your computer

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. In this folder, run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000. To test alone, open it in two browser tabs: create a table in one and join with the code in the other. Each tab is its own player.

## Put it online (free) so a friend can join

Your friend can't reach `localhost`, so the game needs to run on a server. Render has a free tier that works well for this.

1. Create a free account at https://github.com and a new repository. Upload all the files in this folder (not `node_modules`).
2. Create a free account at https://render.com and choose **New → Web Service**. Connect your GitHub repository.
3. Use these settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Deploy. When it finishes, Render gives you a URL like `https://your-game.onrender.com`.
5. Open the URL, click **Create a table**, then send your friend the invite link shown on screen.

Notes:
- Free Render services go to sleep after a period with no visitors, so the first load can take about a minute. Open the page once before your friend arrives.
- Any host that runs Node and supports WebSockets will work (Railway, Fly.io, a small VPS).
- Games live in the server's memory. If the server restarts, open tables are lost.

## How to play

- Place a bet with the chips, then press **Place bet**. The round deals once everyone has bet.
- On your turn: **Hit** (H), **Stand** (S) or **Double** (D, only on your first two cards).
- Dealer stands on all 17s. Blackjack pays 3:2. Everyone starts with $500, and if you run out you get a fresh $500.
- Refreshing the page or losing connection briefly keeps your seat for 2 minutes.
- **Practice alone** on the start screen lets you play without a friend.

## Files

- `server.js`: game server (rooms, rules, turns, payouts)
- `index.html`: the whole game screen
- `smoketest.js`: optional test that plays rounds with two simulated players (`npm start` in one terminal, `node smoketest.js` in another, with `PORT=3456` set for both)

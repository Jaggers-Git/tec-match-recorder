# Recording station: operator cheat sheet

**Before the first set**
1. Start OBS (check the capture card picture and game audio are live in the preview).
2. Double-click **Start Recorder.bat** on the desktop. Leave the black window open.
3. In the dashboard, the header should show **OBS connected** (green) and **start.gg LIVE** (green),
   or "manual mode" if there is no bracket loaded. Yellow or red? See the bottom of this page.

**Every set**
1. **Pick the set.** Tap it in the bracket list on the left (they carry the same letters as the
   bracket: A, B, C…). No bracket? Type both player names on the right; recent names auto-suggest.
   In pools, tap the pool chip first (A1, A2, ...): every pool has its own set A. The file name carries the pool too, like "A3-A".
2. **Characters…** (optional). Tap the fighters in the order they were played. Type to search, Enter picks the top match.
   With the detector on, characters fill in by themselves when the VS screen shows (chips marked "auto"). Glance at them before End & Save.
3. Keep score with **+1** / **-1** under each name as games finish (shows on the stream overlay). Optional; it resets with the next set.
4. **START RECORDING** the moment the players sit down. You can still fix names and characters while it records.
5. Set over? **END & SAVE**, then tap it again to confirm. Done. The form clears for the next set.
6. Filling in the Stream Bible sheet? Tap **Copy row** on the log line and paste it into the worksheet.

**Rules of thumb**
- One recording per *set* (the whole Bo3/Bo5), not per game.
- The file is named from whatever is in the form at the moment you press End & Save.
- Players sat on the wrong sides? Tap the **⇄ swap** button between the names. Nobody has to move.
- Don't press Stop in OBS itself. (If someone does, the app still labels the file.)
- Players play off the passthrough monitor, never the OBS preview. The preview lags.

**If something looks wrong**
| Header shows | Do this |
| --- | --- |
| **OBS not connected** (red) | Is OBS open? In OBS: Tools, WebSocket Server Settings, *Enable* must be ticked. It reconnects on its own. |
| **OBS: wrong password** | Settings (gear icon), OBS, paste the password from OBS's *Show Connect Info*. |
| **start.gg OFFLINE** (yellow) | Wi-Fi dropped. Keep going: the bracket you see is the last one downloaded. Tap **Sync now** when it's back. |
| **start.gg error** | Token or URL problem. Recording still works; enter names by hand and tell the TO. |
| Disk chip red | Under 25 GB left. Tell the TO before the next set. |
| Log row says **error** | Tap **Retry**. The video is safe in the OBS folder either way. |
| Black window closed by accident | Double-click **Start Recorder.bat** again. A recording in progress keeps running in OBS. |

# Forever Build Coach addon

WoW addons can't go online, so this addon doesn't talk to the server itself. It shows your class,
level and equipped items as one line you copy into your Claude, which has the Forever Build Coach connector.
It doesn't need the armory, and it's always up to date, even before you log out.

## Install
1. Copy the `ForeverBuildCoach` folder into `World of Warcraft/_forever_/Interface/AddOns/` (the folder next to your other addons).
2. Restart the game or type `/reload`.

## Use
1. Type `/fbc`, or click it in the addon menu. A box opens with a line like
   `FBC1:MAGE:15:Uzal:HEAD=0;...;MAINHAND=4566;RANGED=11288`.
2. Press Ctrl+C.
3. Paste it to your Claude: *"Find upgrades for this gear, I'm frost."*

Claude calls the `gear_upgrades` tool, which ranks every Forever item you can use, slot by slot, with links to ForeverDB.
`/fbc print` prints the line in chat instead.

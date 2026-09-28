/* Loaded with `node --import` by the tests that need the tool to believe it runs on Windows —
   Claude Desktop's Store file, %APPDATA% paths — on whichever machine runs `npm test`. It
   changes `os.platform()` and nothing else: paths are still joined with this machine's
   separator, and every path the tool derives from APPDATA, LOCALAPPDATA and HOME is pointed at
   the scratch folder by the test. Not a test itself, and not shipped. */
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'

os.platform = () => 'win32'
syncBuiltinESMExports()

#!/usr/bin/env node
// Compatibility shim: the server now lives at src/server/index.js. Existing
// launchd configs and shell scripts that say `node server.js` keep working.
require("./src/server");

# jet-app

Node application layer for the Recon Jet; talks to `jetd` over its line protocol.
See `docs/jet-app.md` at the repository root for the module map, configuration and deployment.

    npm start                 # dial jetd at 127.0.0.1:7777
    npm test                  # protocol parser, rasteriser + surface flush, gestures (no device needed)
    node src/main.js --help   # every config key, with env/argv spellings

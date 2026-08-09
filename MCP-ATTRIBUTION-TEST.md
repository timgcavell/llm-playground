# MCP attribution test

Written through the production `/api/mcp` endpoint to check that a commit made
over MCP is attributed to the calling client rather than to the app or to the
account holder whose token signed it.

Expected author: the client's registered name, suffixed `(MCP client)`.

This branch is disposable — delete it once the author line has been read.
